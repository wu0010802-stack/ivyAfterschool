<script setup lang="ts">
// FRONTEND-261：今日儀表板（/，dashboard:read；domain_spec M11，單一 endpoint GET /admin/dashboard/today）。
// 設計稿：docs/mockups/page-dashboard.html。
// - 出勤 5 張、接送 4 張 StatCard；作業完成率卡沿用 StatCard 的外框 / 標籤列箭頭 / hover（本頁自畫，內容不同）。
// - 卡片可不可點各看 attendance:read / pickup:read / homework:read；近期請假的權限由 RecentLeavesList 自己判斷。
// - 頁面可見時每 60 秒重抓；document.hidden 時暫停，回到可見立即重抓並重新計時。沒有 ws。
// - 首次載入失敗 → EmptyState error；已有資料時失敗只提示並保留舊資料（更新時間繼續累加）。
import { ArrowRight, Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { fetchDashboardToday, type DashboardToday } from '@/api/dashboard'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import StatCard from '@/components/common/StatCard.vue'
import RecentLeavesList from '@/components/dashboard/RecentLeavesList.vue'
import { PERMISSIONS } from '@/constants/permissions'
import { HOMEWORK_OVERALL_STATUS_META } from '@/shared/constants/statusLabels'
import { formatDateWithWeekday } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'
import { usePermission } from '@/utils/permission'

const REFRESH_INTERVAL_MS = 60_000
const TICK_MS = 1_000

/** 首次載入前的占位數字（卡片顯示 skeleton，不會露出） */
const EMPTY: Pick<DashboardToday, 'attendance' | 'pickup' | 'homework'> = {
  attendance: { expected_total: 0, arrived: 0, present: 0, left: 0, not_arrived: 0, leave: 0, absent: 0 },
  pickup: { open: 0, needs_reply: 0, arrived: 0, completed: 0 },
  homework: { total: 0, done: 0, in_progress: 0, not_started: 0, completion_rate: 0 },
}

const HOMEWORK_LEGEND = (['done', 'in_progress', 'not_started'] as const).map((key) => ({
  key,
  ...HOMEWORK_OVERALL_STATUS_META[key],
}))

const router = useRouter()
const { can } = usePermission()

const data = ref<DashboardToday | null>(null)
const loadError = ref<string | null>(null)
const fetching = ref(false)
const lastUpdatedAt = ref(0)
const now = ref(Date.now())

const firstLoading = computed(() => data.value === null && loadError.value === null)
const refreshing = computed(() => fetching.value && data.value !== null)

const att = computed(() => (data.value ?? EMPTY).attendance)
const pickup = computed(() => (data.value ?? EMPTY).pickup)
const hw = computed(() => (data.value ?? EMPTY).homework)
/** 後端 completion_rate 已是 0~100（1 位小數），不再乘 100 */
const hwRate = computed(() => Math.round(hw.value.completion_rate))
const showStats = computed(() => data.value === null || data.value.is_service_day)

const attendanceLink = computed(() => (can(PERMISSIONS.ATTENDANCE_READ) ? '/attendance' : undefined))
const pickupLink = computed(() => (can(PERMISSIONS.PICKUP_READ) ? '/pickup' : undefined))
const canHomework = computed(() => can(PERMISSIONS.HOMEWORK_READ))

const subtitle = computed(() => (data.value ? formatDateWithWeekday(data.value.date) : undefined))

const updatedText = computed(() => {
  const seconds = Math.max(0, Math.floor((now.value - lastUpdatedAt.value) / 1000))
  if (seconds < 5) return '剛剛更新'
  if (seconds < 60) return `${seconds} 秒前更新`
  return `${Math.floor(seconds / 60)} 分鐘前更新`
})

async function refresh(): Promise<void> {
  if (fetching.value) return
  fetching.value = true
  try {
    data.value = await fetchDashboardToday()
    loadError.value = null
    lastUpdatedAt.value = Date.now()
    now.value = lastUpdatedAt.value
  } catch (err) {
    if (data.value) ElMessage.error(errorMessage(err, '無法更新儀表板'))
    else loadError.value = errorMessage(err, '請稍後再試一次')
  } finally {
    fetching.value = false
  }
}

function retry(): void {
  loadError.value = null
  void refresh()
}

function onRefreshClick(): void {
  if (data.value) void refresh()
  else retry()
}

function openHomework(): void {
  if (canHomework.value) void router.push('/homework')
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
let ticker: ReturnType<typeof setInterval> | null = null

function stopAutoRefresh(): void {
  if (refreshTimer !== null) clearInterval(refreshTimer)
  refreshTimer = null
}

function startAutoRefresh(): void {
  stopAutoRefresh()
  refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
}

function onVisibilityChange(): void {
  if (document.hidden) {
    stopAutoRefresh()
    return
  }
  void refresh()
  startAutoRefresh()
}

onMounted(() => {
  void refresh()
  if (!document.hidden) startAutoRefresh()
  document.addEventListener('visibilitychange', onVisibilityChange)
  ticker = setInterval(() => {
    now.value = Date.now()
  }, TICK_MS)
})

onBeforeUnmount(() => {
  stopAutoRefresh()
  if (ticker !== null) clearInterval(ticker)
  ticker = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="dashboard">
    <PageHeader
      title="今日儀表板"
      :subtitle="subtitle"
    >
      <template #actions>
        <span
          v-if="data"
          class="dash-updated"
          data-test="updated-at"
        >{{ updatedText }}</span>
        <el-button
          :icon="Refresh"
          :loading="refreshing"
          :disabled="firstLoading"
          @click="onRefreshClick"
        >
          重新整理
        </el-button>
      </template>
    </PageHeader>

    <EmptyState
      v-if="loadError !== null && !data"
      variant="error"
      title="無法載入今日儀表板"
      :description="loadError"
    >
      <template #action>
        <el-button @click="retry">
          重試
        </el-button>
      </template>
    </EmptyState>

    <div
      v-else
      class="dash"
    >
      <el-alert
        v-if="data && !data.is_service_day"
        type="info"
        :closable="false"
        show-icon
        title="今天不是營業日"
        description="出勤、接送與作業統計只在營業日顯示；近期請假照常列出。"
      />

      <template v-if="showStats">
        <section
          class="dash-section"
          aria-label="出勤"
        >
          <h2 class="dash-section__title">
            出勤
          </h2>
          <div class="dash-grid dash-grid--5">
            <StatCard
              label="應到"
              :value="att.expected_total"
              hint="不含請假"
              :loading="firstLoading"
              :to="attendanceLink"
            />
            <StatCard
              label="已到"
              :value="att.arrived"
              :hint="`在班 ${att.present}・已離班 ${att.left}`"
              :loading="firstLoading"
              :to="attendanceLink"
            />
            <StatCard
              label="未到"
              :value="att.not_arrived"
              :tone="att.not_arrived > 0 ? 'warning' : 'info'"
              :loading="firstLoading"
              :to="attendanceLink"
            />
            <StatCard
              label="請假"
              :value="att.leave"
              :loading="firstLoading"
              :to="attendanceLink"
            />
            <StatCard
              label="缺席"
              :value="att.absent"
              :tone="att.absent > 0 ? 'danger' : 'info'"
              :loading="firstLoading"
              :to="attendanceLink"
            />
          </div>
        </section>

        <div class="dash-row">
          <section
            class="dash-section"
            aria-label="接送"
          >
            <h2 class="dash-section__title">
              接送
            </h2>
            <div class="dash-grid dash-grid--4">
              <StatCard
                label="進行中"
                :value="pickup.open"
                :loading="firstLoading"
                :to="pickupLink"
              />
              <StatCard
                label="待回覆"
                :value="pickup.needs_reply"
                :tone="pickup.needs_reply > 0 ? 'danger' : 'info'"
                :loading="firstLoading"
                :to="pickupLink"
              />
              <StatCard
                label="家長已到"
                :value="pickup.arrived"
                :tone="pickup.arrived > 0 ? 'danger' : 'info'"
                :loading="firstLoading"
                :to="pickupLink"
              />
              <StatCard
                label="今日已完成"
                :value="pickup.completed"
                :loading="firstLoading"
                :to="pickupLink"
              />
            </div>
          </section>

          <section
            class="dash-section"
            aria-label="作業進度"
          >
            <h2 class="dash-section__title">
              作業進度
            </h2>
            <div
              class="stat-card hw-card"
              :class="{ 'is-interactive': canHomework }"
              :role="canHomework ? 'link' : undefined"
              :tabindex="canHomework ? 0 : undefined"
              :aria-busy="firstLoading ? 'true' : undefined"
              @click="openHomework"
              @keydown.enter.prevent="openHomework"
            >
              <div class="stat-card__label">
                <span>作業完成率</span>
                <el-icon
                  v-if="canHomework"
                  class="stat-card__chevron"
                >
                  <ArrowRight />
                </el-icon>
              </div>
              <div
                v-if="firstLoading"
                class="stat-card__skeleton"
              >
                <el-skeleton animated>
                  <template #template>
                    <el-skeleton-item
                      variant="h3"
                      class="hw-card__skeleton-value"
                    />
                    <el-skeleton-item
                      variant="text"
                      class="hw-card__skeleton-bar"
                    />
                  </template>
                </el-skeleton>
              </div>
              <template v-else-if="hw.total === 0">
                <div class="stat-card__value">
                  —
                </div>
                <div class="hw-card__basis">
                  今天還沒有學生到班
                </div>
              </template>
              <template v-else>
                <div class="stat-card__value">
                  {{ hwRate }}%
                </div>
                <el-progress
                  class="hw-card__progress"
                  :percentage="hwRate"
                  :show-text="false"
                  :stroke-width="10"
                  :status="hwRate === 100 ? 'success' : undefined"
                  :aria-label="`作業完成率 ${hwRate}%`"
                />
                <div
                  class="hw-card__legend"
                  data-test="hw-legend"
                >
                  <span
                    v-for="item in HOMEWORK_LEGEND"
                    :key="item.key"
                  ><i
                    class="hw-dot"
                    :class="`tone-${item.tone}`"
                  />{{ item.label }}<strong>{{ hw[item.key] }}</strong></span>
                </div>
                <div class="hw-card__basis">
                  以今天到班的 {{ hw.total }} 位學生計算
                </div>
              </template>
            </div>
          </section>
        </div>
      </template>

      <section
        class="dash-section"
        aria-label="近期請假"
      >
        <h2 class="dash-section__title">
          近期請假<span class="dash-section__hint">今天起 7 天內</span>
        </h2>
        <RecentLeavesList
          :items="data?.recent_leaves ?? []"
          :loading="firstLoading"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.dash-updated {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.dash-section__title {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.dash-section__hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.dash-grid {
  display: grid;
  gap: 12px;
}

.dash-grid--5 {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.dash-grid--4 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.dash-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

@media (max-width: 1199.98px) {
  .dash-row {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 作業完成率卡：外框 / 標籤列 / 箭頭 / hover 與 StatCard（FRONTEND-043）一致；選擇器限定 .hw-card，不影響子元件 StatCard */
.hw-card {
  position: relative;
  box-sizing: border-box;
  min-height: 88px;
  padding: 14px 16px;
  text-align: left;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.hw-card .stat-card__label {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.hw-card .stat-card__chevron {
  margin-left: auto;
  font-size: 14px;
  color: var(--el-text-color-placeholder);
}

.hw-card .stat-card__value {
  margin-top: 6px;
  font-size: 28px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  color: var(--el-text-color-primary);
}

.hw-card .stat-card__skeleton {
  margin-top: 10px;
}

.hw-card__skeleton-value {
  width: 56px;
  height: 24px;
}

.hw-card__skeleton-bar {
  width: 100%;
  margin-top: 14px;
}

.hw-card.is-interactive {
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.hw-card.is-interactive:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: var(--el-box-shadow-lighter);
}

.hw-card.is-interactive:hover .stat-card__chevron {
  color: var(--el-color-primary);
}

.hw-card.is-interactive:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.hw-card__progress {
  margin-top: 10px;
}

.hw-card__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.hw-card__legend strong {
  margin-left: 2px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.hw-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 4px;
  vertical-align: 1px;
  border-radius: 50%;
}

.hw-dot.tone-success {
  background: var(--el-color-success);
}

.hw-dot.tone-warning {
  background: var(--el-color-warning);
}

.hw-dot.tone-info {
  background: var(--el-color-info-light-3);
}

.hw-card__basis {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .hw-card.is-interactive {
    transition: none;
  }
}
</style>
