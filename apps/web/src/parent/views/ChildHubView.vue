<script setup lang="ts">
/**
 * 家長端首頁（路由 `/`）：小孩身分卡 → 今日狀態卡 → 常用功能。
 * 以選中小孩為操作對象（參考 ivy ChildHubView）；今日狀態只打 /children/{id}/today 一支，之後由 ws 原地更新（PARENT-052）。
 * 「我已經到了 / 我到了」走 PARENT-105 useArriveNow；成功的回應以 applyPickup 立即套到卡片，留在首頁不導頁；
 * 遇到接送狀態已變更 / 請求不存在時由 onStale 呼叫 refresh 重抓今日狀態（保留卡片、不顯示骨架，PARENT-199）。
 */
import { computed, onMounted, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { PICKUP_OPEN_STATUSES, type PickupRequestStatus } from '@/shared/types/api'
import { formatDateWithWeekday } from '@/shared/utils/datetime'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import TodayStatusCard from '../components/home/TodayStatusCard.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import PullToRefresh from '../components/PullToRefresh.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { useArriveNow } from '../composables/useArriveNow'
import { useTodayStatus } from '../composables/useTodayStatus'
import { useChildrenStore } from '../stores/children'

interface QuickLink {
  label: string
  to: string
  icon: string
}

const QUICK_LINKS: readonly QuickLink[] = [
  { label: '請假', to: '/leaves', icon: 'event_busy' },
  { label: '出勤', to: '/attendance', icon: 'calendar_month' },
  { label: '代理接送', to: '/pickup/proxy', icon: 'badge' },
]

const OPEN: ReadonlySet<PickupRequestStatus> = new Set(PICKUP_OPEN_STATUSES)

const router = useRouter()
const children = useChildrenStore()

// 只有清單裡確實有的小孩才打 today：清單回來前 localStorage 殘留的舊 id（例如已解除綁定）不送請求
const activeChildId = computed(() => (children.selectedChild ? children.selectedId : null))

const { today, loading, error, refresh, applyPickup } = useTodayStatus(activeChildId)
const { confirmOpen, skipNextTime, lastResult, request: requestArrive, confirm: confirmArrive, dismiss } = useArriveNow({
  onStale: refresh,
})

// 有舊資料時照常顯示（清單重抓失敗不蓋掉畫面）；沒有資料才看載入 / 錯誤 / 空清單
const childrenState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (children.items.length > 0) return 'ready'
  if (children.loading) return 'loading'
  if (children.error) return 'error'
  return children.loaded ? 'empty' : 'loading'
})

// 沒有可操作的小孩時停用常用功能；清單載入中照常可點（各頁自行載入小孩）
const quickDisabled = computed(() => childrenState.value === 'empty' || childrenState.value === 'error')

const dateLabel = computed(() => (today.value ? formatDateWithWeekday(today.value.date) : ''))

function go(path: string): void {
  void router.push(path)
}

function onArriveNow(): void {
  const id = activeChildId.value
  if (id === null) return
  const current = today.value?.pickup_request ?? null
  requestArrive(id, current && OPEN.has(current.status) ? current.id : null)
}

function onQuickClick(event: MouseEvent, navigate: (e?: MouseEvent) => unknown): void {
  if (quickDisabled.value) {
    event.preventDefault()
    return
  }
  void navigate(event)
}

// confirm() 與「下次不再提醒」後直接送出的回應都寫進 lastResult：一律由這裡套到卡片
watch(lastResult, (result) => {
  if (result) applyPickup(result)
})

onMounted(() => {
  void children.load()
})
</script>

<template>
  <div class="child-hub">
    <PullToRefresh
      :on-refresh="refresh"
      :disabled="children.items.length === 0"
    >
      <div class="hub">
        <template v-if="childrenState === 'loading'">
          <SkeletonBlock
            variant="row"
            height="80px"
            class="hub-cch-skeleton"
          />
          <div class="hub-section m3-label-large">
            <span>今日狀態</span>
          </div>
          <SkeletonBlock
            variant="card"
            height="300px"
          />
        </template>
        <ParentEmptyState
          v-else-if="childrenState === 'error'"
          class="hub-empty"
          variant="error"
          title="小孩清單載入失敗"
          description="請檢查網路連線後再試一次"
          @action="children.load(true)"
        />
        <ParentEmptyState
          v-else-if="childrenState === 'empty'"
          class="hub-empty"
          icon="link"
          title="尚未綁定小孩"
          description="請輸入安親班提供的綁定碼"
          action-label="輸入綁定碼"
          @action="go('/bind')"
        />
        <template v-else>
          <ChildContextHeader
            :children="children.items"
            :selected-id="children.selectedId"
            @select="children.select"
          />
          <div class="hub-section m3-label-large">
            <span>今日狀態</span>
            <span
              v-if="dateLabel"
              class="hub-section__date m3-body-medium"
            >{{ dateLabel }}</span>
          </div>
          <div
            v-if="error"
            class="today-error"
            role="alert"
          >
            <M3Icon
              name="error"
              :size="20"
              filled
            />
            <span class="today-error__text m3-body-medium">今日狀態載入失敗</span>
            <button
              type="button"
              class="today-error__action m3-label-large"
              @click="refresh"
            >
              重試
            </button>
          </div>
          <SkeletonBlock
            v-if="loading && !today"
            variant="card"
            height="300px"
          />
          <TodayStatusCard
            v-else
            :today="today"
            @request-pickup="go('/pickup')"
            @open-pickup="go('/pickup')"
            @open-homework="go('/homework')"
            @arrive-now="onArriveNow"
          />
        </template>

        <div class="hub-section m3-label-large">
          <span>常用功能</span>
        </div>
        <ul
          class="quick"
          role="list"
          aria-label="常用功能"
        >
          <li
            v-for="q in QUICK_LINKS"
            :key="q.to"
          >
            <RouterLink
              v-slot="{ href, navigate }"
              :to="q.to"
              custom
            >
              <a
                class="quick__item"
                :href="href"
                :aria-disabled="quickDisabled ? 'true' : undefined"
                :tabindex="quickDisabled ? -1 : undefined"
                @click="onQuickClick($event, navigate)"
              >
                <span
                  class="quick__icon"
                  aria-hidden="true"
                >
                  <M3Icon :name="q.icon" />
                </span>
                <span class="quick__label m3-label-large">{{ q.label }}</span>
              </a>
            </RouterLink>
          </li>
        </ul>
      </div>
    </PullToRefresh>

    <ConfirmDialog
      :open="confirmOpen"
      title="確認已抵達安親班？"
      message="老師會收到通知並準備帶孩子出來"
      confirm-label="我到了"
      @confirm="confirmArrive"
      @cancel="dismiss"
    >
      <label class="check-row m3-body-large"><input
        v-model="skipNextTime"
        type="checkbox"
      >下次不再提醒</label>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、上 8px、底 24px 內距；放在 PullToRefresh 內層，下拉指示器才橫跨全寬（ParentLayout 不加） */
.hub {
  padding: 8px 16px 24px;
}

.hub-section {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 20px 4px 8px;
  color: var(--m3-on-surface-variant);
}

.hub-section__date {
  font-variant-numeric: tabular-nums;
}

/* 同身分卡外框：圓角 16px、surface-container-low */
.hub-cch-skeleton {
  border-radius: var(--m3-shape-large);
  background: var(--m3-surface-container-low);
  overflow: hidden;
}

.hub-empty {
  margin-top: 24px;
}

/* 今日狀態錯誤列：卡片上方，error-container 底；「重試」本身就是 48×48 以上的點擊區 */
.today-error {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  margin-bottom: 8px;
  padding: 0 4px 0 16px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-error-container);
  color: var(--m3-on-error-container);
}

.today-error__text {
  flex: 1;
  min-width: 0;
  padding: 14px 0;
}

.today-error__action {
  position: relative;
  flex: none;
  min-width: 48px;
  height: 48px;
  padding: 0 12px;
  border: none;
  border-radius: var(--m3-shape-full);
  background: transparent;
  color: inherit;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.today-error__action:focus-visible {
  outline: 2px solid currentcolor;
  outline-offset: -2px;
}

/* 常用功能：一列三格等寬 */
.quick {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.quick__item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 88px;
  padding: 12px 4px;
  border: 1px solid var(--m3-outline-variant);
  border-radius: var(--m3-shape-large);
  background: var(--m3-surface);
  color: var(--m3-on-surface);
  text-align: center;
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
}

.quick__item:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: 2px;
}

.quick__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--m3-shape-full);
  background: var(--m3-secondary-container);
  color: var(--m3-on-secondary-container);
}

.quick__label {
  overflow-wrap: anywhere;
}

.quick__item[aria-disabled='true'] {
  opacity: 0.38;
  cursor: not-allowed;
}

/* M3 state layer */
.today-error__action::before,
.quick__item::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: currentcolor;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.today-error__action:hover::before,
.quick__item:not([aria-disabled='true']):hover::before {
  opacity: var(--m3-state-hover);
}

.today-error__action:focus-visible::before,
.quick__item:not([aria-disabled='true']):focus-visible::before {
  opacity: var(--m3-state-focus);
}

.today-error__action:active::before,
.quick__item:not([aria-disabled='true']):active::before {
  opacity: var(--m3-state-pressed);
}

/* ConfirmDialog default slot：「下次不再提醒」整列 48px 可點 */
.check-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.check-row input {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 0 3px;
  accent-color: var(--m3-primary);
  cursor: pointer;
}

.check-row input:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: 4px;
}
</style>
