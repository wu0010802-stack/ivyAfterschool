<script setup lang="ts">
// FRONTEND-195：接送 POS 右欄佇列卡（倒數 / 進行中 / 已結束）。設計稿：docs/mockups/page-pickup-pos.html（QueueCard 段），
// 倒數卡外觀照已核可的 component-pickup-countdown。
// 移植 ivy FE:src/components/dismissal/pos/DismissalPosQueueCard.vue 的卡片結構、useSwipeReveal 左滑露出取消（鬆手只開合、
// 需再點按鈕）、staging 倒數條、ETA 相對文字；去掉 proxy 明碼與一鍵確認（代理核驗改走 FRONTEND-201）。
// - 狀態 tag 用 POS 用語：pending「等待確認」；needs_reply 另以 danger 實心「待回覆」表示（家長端的「待回覆」不用在員工端）。
// - 第二列整列寬「{班級}・{來源}・{發起人}・{發起時間}」，不和右側 tag 搶寬度。
// - 「我已經到了」捷徑建立的請求（直接 arrived、expected_arrival_at 為 null）：不顯示預計抵達那一行，直接顯示等候時間。
// - 急迫色（FRONTEND-184）：已等 3~7 分 urgency-warning、8 分以上 urgency-critical，套在根元素。
// - 根元素 id="qc-{item.id}"，供 QueuePanel（FRONTEND-194）定位與閃爍（is-flash）。
// - busy（FRONTEND-194 改寫）：送出中「確認」顯示 loading、其餘操作鈕停用（Element Plus 的 disabled / loading 按鈕
//   不會 emit click），防止連點送出兩次。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PickupRequest } from '@/api/pickupRequests'
import type { PosQueueItem } from '@/composables/useDismissalPosQueue'
import { etaRelativeText, formatWaited, urgencyLevel, waitedMinutes } from '@/composables/useDismissalUrgency'
import { useSwipeReveal } from '@/composables/useSwipeReveal'
import {
  HOMEWORK_OVERALL_STATUS_META,
  PICKUP_COMPLETION_METHOD_LABELS,
  PICKUP_REQUEST_STATUS_META,
  PICKUP_SOURCE_LABELS,
  statusMeta,
  type StatusMeta,
} from '@/shared/constants/statusLabels'
import type { PickupRequestStatus } from '@/shared/types/api'
import { formatTime } from '@/shared/utils/datetime'
import CountdownBar from './CountdownBar.vue'

const props = withDefaults(
  defineProps<{
    item: PosQueueItem
    /** 供等候分鐘 / ETA 相對文字計算「現在」（父層傳 useNowClock 的 now） */
    now: number
    canOperate: boolean
    /** 這張卡的請求正在送出（父層的 busyIds 含 item.id）：操作鈕 loading / 停用 */
    busy?: boolean
  }>(),
  { busy: false },
)

const emit = defineEmits<{
  reply: [request: PickupRequest]
  acknowledge: [request: PickupRequest]
  complete: [request: PickupRequest]
  cancel: [item: PosQueueItem]
}>()

/** 露出的取消鈕寬度（px），與 .qcard__cancel 的 CSS 寬度對齊 */
const REVEAL_WIDTH = 84
/** 倒數秒數的更新週期 */
const STAGING_TICK_MS = 250
/** 拖曳超過此距離後，鬆手產生的 click 不視為點按 */
const CLICK_SLOP_PX = 6

/** POS 用語：員工端 pending 叫「等待確認」，其餘沿用共用標籤 */
const POS_REQUEST_STATUS_META: Record<PickupRequestStatus, StatusMeta> = {
  ...PICKUP_REQUEST_STATUS_META,
  pending: { label: '等待確認', tone: 'warning' },
}

const request = computed(() => props.item.request)
const isStaging = computed(() => props.item.phase === 'staging')
const isActive = computed(() => props.item.phase === 'active')

// 倒數秒數用真實時鐘（CountdownBar 也以 Date.now() 計算剩餘），不用 30 秒一跳的 now
const realNow = ref(Date.now())
let tick: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  if (isStaging.value) {
    tick = setInterval(() => {
      realNow.value = Date.now()
    }, STAGING_TICK_MS)
  }
})
onBeforeUnmount(() => {
  if (tick !== null) clearInterval(tick)
})

const secondsLeft = computed(() => {
  const c = props.item.countdown
  if (!c) return 0
  return Math.max(0, Math.ceil((c.durationMs - (realNow.value - c.startedAt)) / 1000))
})

const status = computed(() => statusMeta(POS_REQUEST_STATUS_META, request.value?.status))
const sourceLabel = computed(() => (request.value ? PICKUP_SOURCE_LABELS[request.value.source] : ''))
const waited = computed(() => (request.value ? waitedMinutes(request.value, props.now) : null))
const waitedText = computed(() => formatWaited(waited.value))
const urgency = computed(() => urgencyLevel(waited.value))
const etaRelative = computed(() => (request.value ? etaRelativeText(request.value.expected_arrival_at, props.now) : ''))
const homework = computed(() => {
  const s = request.value?.current_homework_status
  return s ? HOMEWORK_OVERALL_STATUS_META[s] : null
})

const replySourceText = computed(() => {
  const r = request.value
  if (!r) return ''
  return r.reply_source === 'staff' ? `${r.replied_by_name ?? '員工'} 回覆` : '系統自動回覆'
})

const closedText = computed(() => {
  const r = request.value
  if (!r) return ''
  if (r.status === 'completed') {
    const method = r.completion_method ? PICKUP_COMPLETION_METHOD_LABELS[r.completion_method] : '—'
    return `${r.picked_up_by_name ?? '—'} 接走・${method}・${r.completed_by_name ?? '—'}・${formatTime(r.completed_at)}`
  }
  if (r.status === 'cancelled') return r.cancel_reason ? `已取消・${r.cancel_reason}` : '已取消'
  return '逾時未完成'
})

const rootClass = computed(() => [
  `phase-${props.item.phase}`,
  isActive.value && urgency.value !== 'normal' ? `urgency-${urgency.value}` : '',
])

// 左滑：鬆手只開合，業務動作要再點露出的「取消」
const swipeable = computed(() => props.canOperate && isActive.value)
const swipe = useSwipeReveal({ revealWidth: REVEAL_WIDTH, disabled: () => !swipeable.value })
let startX = 0
let suppressClick = false

function onPointerDown(e: PointerEvent): void {
  startX = e.clientX
  suppressClick = false
  swipe.onPointerDown(e)
}

function onPointerMove(e: PointerEvent): void {
  swipe.onPointerMove(e)
  if (swipe.dragging.value && Math.abs(e.clientX - startX) > CLICK_SLOP_PX) suppressClick = true
}

/** 拖曳後鬆手產生的 click 不可誤觸卡內按鈕 */
function onClickCapture(e: MouseEvent): void {
  if (!suppressClick) return
  suppressClick = false
  e.stopPropagation()
  e.preventDefault()
}

function onCancelClick(): void {
  emit('cancel', props.item)
  swipe.close()
}

const bodyStyle = computed(() => ({ transform: `translateX(${swipe.dragX.value}px)` }))
</script>

<template>
  <div
    :id="`qc-${item.id}`"
    class="qcard"
    :class="rootClass"
  >
    <div
      v-if="swipeable"
      class="qcard__reveal"
    >
      <button
        type="button"
        class="qcard__cancel"
        :disabled="!swipe.isOpen.value"
        :tabindex="swipe.isOpen.value ? 0 : -1"
        @click="onCancelClick"
      >
        取消
      </button>
    </div>
    <div
      class="queue-card"
      :class="{
        'is-staging': isStaging,
        'is-dragging': swipe.dragging.value,
        'is-rebound-instant': swipe.reboundInstant.value,
      }"
      :style="bodyStyle"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="swipe.onPointerUp"
      @pointercancel="swipe.onPointerCancel"
      @click.capture="onClickCapture"
    >
      <template v-if="isStaging">
        <div class="queue-card__top">
          <div class="queue-card__who">
            <div class="queue-card__name">
              {{ item.studentName }}
            </div>
            <div class="queue-card__meta">
              {{ item.className }}・員工代建
            </div>
          </div>
        </div>
        <div class="queue-card__staging-row">
          <span class="queue-card__secs">{{ secondsLeft }} 秒後送出</span>
          <el-button
            class="btn-touch"
            @click="emit('cancel', item)"
          >
            取消
          </el-button>
        </div>
        <CountdownBar
          v-if="item.countdown"
          class="queue-card__countdown"
          :started-at="item.countdown.startedAt"
          :duration-ms="item.countdown.durationMs"
          :aria-label="`${item.studentName} 送出倒數`"
        />
      </template>

      <template v-else-if="request && isActive">
        <div class="queue-card__top">
          <div class="queue-card__name">
            {{ request.student.name }}
          </div>
          <div class="queue-card__tags">
            <el-tag
              v-if="request.needs_reply"
              type="danger"
              effect="dark"
              disable-transitions
            >
              待回覆
            </el-tag>
            <el-tag
              :type="status.tone"
              disable-transitions
            >
              {{ status.label }}
            </el-tag>
          </div>
        </div>
        <div class="queue-card__meta">
          {{ request.student.class_name }}・{{ sourceLabel }}・{{ request.requested_by_name }}・{{ formatTime(request.created_at) }}
        </div>
        <div
          v-if="request.status === 'arrived'"
          class="queue-card__when"
        >
          <span class="queue-card__waited">{{ waitedText }}</span>
          <span class="queue-card__sub">{{ formatTime(request.arrived_at) }} 到達</span>
        </div>
        <div
          v-else-if="request.expected_arrival_at"
          class="queue-card__when"
        >
          <span class="queue-card__eta">預計 {{ request.expected_arrival_at }} 到</span>
          <span class="queue-card__sub">{{ etaRelative }}</span>
        </div>
        <div
          v-if="homework || request.current_ready_eta"
          class="queue-card__hw"
        >
          <span class="queue-card__label">作業</span>
          <el-tag
            v-if="homework"
            :type="homework.tone"
            size="small"
            effect="plain"
            disable-transitions
          >
            {{ homework.label }}
          </el-tag>
          <span v-if="request.current_ready_eta">作業預計 {{ request.current_ready_eta }} 完成</span>
        </div>
        <div class="queue-card__reply">
          <template v-if="request.reply_message">
            <div class="queue-card__reply-src">
              {{ replySourceText }}
            </div>
            <div class="queue-card__reply-msg">
              {{ request.reply_message }}
            </div>
          </template>
          <div
            v-else
            class="queue-card__reply-none"
          >
            尚未回覆
          </div>
        </div>
        <div
          v-if="canOperate"
          class="queue-card__actions"
          data-test="queue-actions"
        >
          <template v-if="request.status === 'pending'">
            <el-button
              :type="request.needs_reply ? 'primary' : 'default'"
              :disabled="busy"
              @click="emit('reply', request)"
            >
              回覆時間
            </el-button>
            <el-button
              :type="request.needs_reply ? 'default' : 'primary'"
              :loading="busy"
              @click="emit('acknowledge', request)"
            >
              確認
            </el-button>
          </template>
          <template v-else-if="request.status === 'acknowledged'">
            <el-button
              :disabled="busy"
              @click="emit('reply', request)"
            >
              修改回覆
            </el-button>
            <el-button
              type="primary"
              :disabled="busy"
              @click="emit('complete', request)"
            >
              完成交付
            </el-button>
          </template>
          <template v-else>
            <el-button
              class="is-main"
              type="primary"
              :disabled="busy"
              @click="emit('complete', request)"
            >
              完成交付
            </el-button>
            <el-button
              :disabled="busy"
              @click="emit('reply', request)"
            >
              修改回覆
            </el-button>
          </template>
        </div>
      </template>

      <template v-else-if="request">
        <div class="queue-card__top">
          <div class="queue-card__name">
            {{ request.student.name }}
          </div>
          <el-tag
            :type="status.tone"
            disable-transitions
          >
            {{ status.label }}
          </el-tag>
        </div>
        <div class="queue-card__meta">
          {{ request.student.class_name }}・{{ sourceLabel }}
        </div>
        <div class="queue-card__closed">
          {{ closedText }}
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.qcard {
  position: relative;
  margin-bottom: 10px;
  overflow: hidden;
  border-radius: 10px;
}

.qcard__reveal {
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  background: var(--el-color-danger);
}

.qcard__cancel {
  width: 84px;
  font-family: inherit;
  font-size: 15px;
  font-weight: 600;
  color: var(--el-color-white);
  cursor: pointer;
  background: var(--el-color-danger);
  border: none;
}

.qcard__cancel:disabled {
  cursor: default;
}

.qcard__cancel:focus-visible {
  outline: 2px solid var(--el-color-white);
  outline-offset: -4px;
}

.queue-card {
  position: relative;
  z-index: 1;
  padding: 14px;
  touch-action: pan-y;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  transition: transform 0.2s ease;
}

.queue-card.is-dragging,
.queue-card.is-rebound-instant {
  user-select: none;
  transition: none;
}

.queue-card.is-staging {
  border-color: var(--el-color-primary-light-5);
  border-style: dashed;
}

.queue-card__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.queue-card__who {
  min-width: 0;
}

.queue-card__name {
  min-width: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.queue-card__meta {
  margin-top: 2px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.queue-card__tags {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.queue-card__staging-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}

.queue-card__secs {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-color-primary);
  font-variant-numeric: tabular-nums;
}

.queue-card__countdown {
  margin-top: 10px;
}

.btn-touch {
  min-width: 88px;
  min-height: 44px;
  font-size: 15px;
}

.queue-card__when {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: baseline;
  margin-top: 8px;
  font-variant-numeric: tabular-nums;
}

.queue-card__eta {
  font-size: 15px;
  font-weight: 600;
}

.queue-card__sub {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.queue-card__waited {
  font-size: 17px;
  font-weight: 700;
  color: var(--el-color-danger);
}

.queue-card__hw {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.queue-card__label {
  color: var(--el-text-color-secondary);
}

.queue-card__reply {
  margin-top: 8px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.queue-card__reply-src {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.queue-card__reply-msg {
  color: var(--el-text-color-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.queue-card__reply-none {
  color: var(--el-text-color-placeholder);
}

.queue-card__actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.queue-card__actions .el-button {
  flex: 1;
  min-height: 44px;
  margin-left: 0;
  font-size: 15px;
}

.queue-card__actions .el-button.is-main {
  flex: 2;
}

.queue-card__closed {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}

/* 家長已到的等候急迫色（FRONTEND-184：3 分 warning、8 分 critical） */
.qcard.urgency-warning .queue-card {
  border-color: var(--el-color-warning);
  box-shadow: inset 0 0 0 1px var(--el-color-warning);
}

.qcard.urgency-warning .queue-card__waited {
  color: var(--el-color-warning-dark-2);
}

.qcard.urgency-critical .queue-card {
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger);
  box-shadow: inset 0 0 0 1px var(--el-color-danger);
}

.qcard.urgency-critical .queue-card__reply {
  background: var(--el-bg-color);
}

/* 已結束：唯讀、淡灰 */
.qcard.phase-closed .queue-card {
  background: var(--el-fill-color-lighter);
}

.qcard.phase-closed .queue-card__name {
  font-size: 16px;
  color: var(--el-text-color-secondary);
}

/* 從學生卡定位（QueuePanel 加 is-flash）：閃爍 1.5 秒 */
.qcard.is-flash .queue-card {
  animation: qcard-flash 1.5s ease-out;
}

@keyframes qcard-flash {
  0%,
  55% {
    box-shadow: 0 0 0 3px var(--el-color-primary-light-3);
  }

  100% {
    box-shadow: 0 0 0 3px var(--el-color-primary-light-9);
  }
}

@media (prefers-reduced-motion: reduce) {
  .queue-card {
    transition: none;
  }

  .qcard.is-flash .queue-card {
    outline: 3px solid var(--el-color-primary-light-3);
    animation: none;
  }
}
</style>
