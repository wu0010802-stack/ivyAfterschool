<script setup lang="ts">
/**
 * 今日作業（/homework，底部導覽「作業」；頂部列「今日作業」由 ParentLayout 負責）。
 * 版面、文案與互動以 docs/mockups/parent-page-homework.html 為準；本頁只呈現，沒有可點的列。
 *
 * - 資料來自 homeworkToday store（PARENT-071）：掛載與切換小孩時 force 重抓，畫面讀 get(id)；
 *   ws 更新由 store 原地套用，畫面直接反映。
 * - 這個小孩還沒有資料 → 骨架 / 錯誤狀態；已有資料（快取、下拉重新整理、斷線輪詢）→ 照常顯示並背景重抓，
 *   失敗時保留舊資料、上方加錯誤列（不另跳 snackbar）。
 */
import { computed, onMounted, watch } from 'vue'
import { HOMEWORK_OVERALL_STATUS_META, statusMeta } from '@/shared/constants/statusLabels'
import { formatDateWithWeekday, formatTime } from '@/shared/utils/datetime'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import HomeworkItemRow from '../components/homework/HomeworkItemRow.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import PullToRefresh from '../components/PullToRefresh.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import { useChildrenStore } from '../stores/children'
import { useHomeworkTodayStore } from '../stores/homeworkToday'

const children = useChildrenStore()
const homeworkToday = useHomeworkTodayStore()

const current = computed(() => (children.selectedId === null ? null : homeworkToday.get(children.selectedId)))
const error = computed(() => (children.selectedId === null ? null : homeworkToday.errorByChild[children.selectedId] ?? null))

/** 身分卡位置：小孩清單載入中且還沒有任何小孩 */
const childrenPending = computed(() => children.loading && children.items.length === 0)

/**
 * 內容區狀態：
 * - data：這個小孩有資料（含快取）
 * - loading：沒有資料且載入中，或還在等小孩清單
 * - error：沒有資料且載入失敗（或小孩清單載入失敗）
 * - empty：小孩清單已載入但沒有任何小孩
 */
const view = computed<'data' | 'loading' | 'error' | 'empty'>(() => {
  if (current.value) return 'data'
  if (children.selectedId === null) {
    if (children.loaded) return 'empty'
    return children.error ? 'error' : 'loading'
  }
  // store 開始載入時會清掉 errorByChild，所以有錯誤就表示目前沒有在載入
  if (error.value) return 'error'
  return 'loading'
})

const doneCount = computed(() => current.value?.items.filter((i) => i.status === 'done').length ?? 0)
const itemCount = computed(() => current.value?.items.length ?? 0)
const progressWidth = computed(() => (itemCount.value ? `${(doneCount.value / itemCount.value) * 100}%` : '0%'))
const overallMeta = computed(() => statusMeta(HOMEWORK_OVERALL_STATUS_META, current.value?.overall_status ?? 'not_started'))

function reload(): Promise<void> {
  const id = children.selectedId
  if (id === null) return Promise.resolve()
  return homeworkToday.load(id, { force: true })
}

function retry(): void {
  if (children.selectedId === null) void children.load(true)
  else void reload()
}

// 掛載與切換小孩時 force 重抓；store 以並發共用與世代避免舊回應蓋掉新資料
watch(
  () => children.selectedId,
  (id) => {
    if (id !== null) void homeworkToday.load(id, { force: true })
  },
  { immediate: true },
)

onMounted(() => {
  // 深層連結直接進入時小孩清單尚未載入
  void children.load()
})
</script>

<template>
  <div class="homework-view">
    <PullToRefresh
      :on-refresh="reload"
      :disabled="view === 'loading'"
    >
      <div class="hwv">
        <SkeletonBlock
          v-if="childrenPending"
          variant="row"
          height="80px"
          class="hwv-cch-skeleton"
        />
        <ChildContextHeader
          v-else
          :children="children.items"
          :selected-id="children.selectedId"
          @select="children.select"
        />

        <div class="hwv-section m3-label-large">
          <span>作業進度</span>
          <span
            v-if="current"
            class="hwv-section__aside m3-body-medium"
          >{{ formatDateWithWeekday(current.date) }}</span>
        </div>

        <!-- 有舊資料、重新整理失敗：只在上方顯示錯誤列 -->
        <div
          v-if="error && current"
          class="hwv-error"
          role="alert"
        >
          <M3Icon
            name="error"
            :size="20"
            filled
          />
          <span class="hwv-error__text m3-body-medium">作業進度載入失敗</span>
          <button
            type="button"
            class="hwv-error__action m3-label-large"
            @click="reload"
          >
            重試
          </button>
        </div>

        <template v-if="view === 'data' && current">
          <M3Card
            variant="elevated"
            padding="none"
            class="hws"
            aria-label="作業進度摘要"
          >
            <div class="hws-sec">
              <div class="hws-head">
                <p class="hws-head__text m3-title-medium">
                  <template v-if="itemCount">
                    已完成 <span class="hws-num">{{ doneCount }}/{{ itemCount }}</span> 項
                  </template>
                  <template v-else>
                    今日作業
                  </template>
                </p>
                <StatusPill
                  :label="overallMeta.label"
                  :tone="overallMeta.tone"
                />
              </div>
              <span
                v-if="itemCount"
                class="hws-bar"
                aria-hidden="true"
              >
                <span
                  class="hws-bar__fill"
                  :style="{ width: progressWidth }"
                />
              </span>
            </div>
            <div class="hws-sec">
              <div
                v-if="current.overall_status === 'done'"
                class="hws-eta is-done"
              >
                <M3Icon
                  class="hws-eta__icon"
                  name="check_circle"
                  filled
                />
                <p class="hws-eta__text m3-title-medium">
                  作業已完成，可以來接送了
                </p>
              </div>
              <div
                v-else-if="current.ready_eta"
                class="hws-eta"
              >
                <M3Icon
                  class="hws-eta__icon"
                  name="schedule"
                />
                <p class="hws-eta__text m3-title-medium">
                  預計 <span class="hws-eta__time">{{ current.ready_eta }}</span> 可接送
                </p>
              </div>
              <div
                v-else
                class="hws-eta is-muted"
              >
                <M3Icon
                  class="hws-eta__icon"
                  name="schedule"
                />
                <p class="hws-eta__text m3-body-medium">
                  老師尚未提供預計時間
                </p>
              </div>
              <p
                v-if="current.note"
                class="hws-note m3-body-medium"
              >
                <span>老師說明：{{ current.note }}</span>
              </p>
            </div>
            <p
              v-if="current.updated_at"
              class="hws-updated m3-body-small"
            >
              最後更新 {{ formatTime(current.updated_at) }}
            </p>
          </M3Card>

          <div class="hwv-section m3-label-large">
            <span>作業項目</span>
            <span
              v-if="itemCount"
              class="hwv-section__aside m3-body-medium"
            >共 {{ itemCount }} 項</span>
          </div>
          <M3Card
            variant="outlined"
            padding="none"
            class="hw-card"
          >
            <ul
              v-if="itemCount"
              class="hw-list"
              role="list"
              aria-label="今日作業項目"
            >
              <HomeworkItemRow
                v-for="(item, index) in current.items"
                :key="index"
                :item="item"
              />
            </ul>
            <ParentEmptyState
              v-else-if="current.overall_status === 'done'"
              icon="done_all"
              title="老師已標記今日作業完成"
            />
            <ParentEmptyState
              v-else
              icon="assignment"
              title="今天還沒有作業項目"
              description="老師登記作業後會顯示在這裡"
            />
          </M3Card>
        </template>

        <template v-else-if="view === 'loading'">
          <SkeletonBlock
            variant="card"
            height="168px"
          />
          <div class="hwv-section m3-label-large">
            <span>作業項目</span>
          </div>
          <M3Card
            variant="outlined"
            padding="none"
            class="hw-card"
          >
            <SkeletonBlock
              variant="row"
              :count="3"
            />
          </M3Card>
        </template>

        <ParentEmptyState
          v-else-if="view === 'error'"
          variant="error"
          title="作業進度載入失敗"
          description="請檢查網路連線後再試一次"
          @action="retry"
        />

        <M3Card
          v-else
          variant="outlined"
          padding="none"
          class="hw-card"
        >
          <ParentEmptyState
            icon="assignment"
            title="今天還沒有作業項目"
            description="老師登記作業後會顯示在這裡"
          />
        </M3Card>
      </div>
    </PullToRefresh>
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、上 8px、底部 24px；放在 PullToRefresh 內層，下拉指示器才橫跨全寬 */
.hwv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 16px 24px;
}

.hwv-section {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 8px 4px -4px;
  color: var(--m3-on-surface-variant);
}

.hwv-section__aside {
  font-variant-numeric: tabular-nums;
}

.hwv-cch-skeleton {
  overflow: hidden;
  border-radius: var(--m3-shape-large);
  background: var(--m3-surface-container-low);
}

/* 摘要卡：兩個區塊（進度 / 預計可接送）以分隔線分開，同 TodayStatusCard 的區塊語言 */
.hws {
  overflow: hidden;
}

.hws-sec {
  padding: 12px 16px;
}

.hws-sec + .hws-sec {
  border-top: 1px solid var(--m3-outline-variant);
}

.hws-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 32px;
}

.hws-head__text {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--m3-on-surface);
}

.hws-num {
  font-variant-numeric: tabular-nums;
}

.hws-bar {
  display: block;
  height: 4px;
  margin: 10px 0 2px;
  overflow: hidden;
  border-radius: var(--m3-shape-full);
  background: var(--m3-surface-container-highest);
}

.hws-bar__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--m3-primary);
  transition: width var(--m3-dur-medium-2) var(--m3-easing-standard);
}

.hws-eta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 28px;
}

.hws-eta__icon {
  color: var(--m3-on-surface-variant);
}

.hws-eta__text {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--m3-on-surface);
}

.hws-eta__time {
  color: var(--m3-primary);
  font-variant-numeric: tabular-nums;
}

.hws-eta.is-done .hws-eta__icon,
.hws-eta.is-done .hws-eta__text {
  color: var(--m3-primary);
}

.hws-eta.is-muted .hws-eta__text {
  color: var(--m3-on-surface-variant);
}

/* 老師說明：縮排對齊圖示右側文字，保留換行、純文字 */
.hws-note {
  margin: 8px 0 0 36px;
  color: var(--m3-on-surface);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.hws-updated {
  margin: 0;
  padding: 0 16px 12px;
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.hw-card {
  overflow: hidden;
}

.hw-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 有舊資料時的錯誤列（同首頁「今日狀態載入失敗」列） */
.hwv-error {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 0 4px 0 16px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-error-container);
  color: var(--m3-on-error-container);
}

.hwv-error__text {
  flex: 1;
  min-width: 0;
  padding: 14px 0;
}

.hwv-error__action {
  flex: none;
  min-width: 48px;
  height: 48px;
  padding: 0 12px;
  border: none;
  border-radius: var(--m3-shape-full);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.hwv-error__action:focus-visible {
  outline: 2px solid currentcolor;
  outline-offset: -2px;
}
</style>
