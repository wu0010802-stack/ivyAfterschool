<script setup lang="ts">
/**
 * 首頁今日狀態卡（純展示）：出勤 / 作業 / 預計可接送 / 接送四個區塊，資料來自 useTodayStatus（PARENT-052）。
 * 狀態文字與 tone 一律取 FRONTEND-005 statusMeta，時間一律以 FRONTEND-003 轉台北 HH:MM。
 * 本元件只 emit：確認對話框（我已經到了 / 我到了）、導頁與 ws 即時更新屬於 ChildHubView 與 composable。
 * 接送權限 can_pickup 由 PickupView 檢查，首頁不另外請求。卡片不顯示小孩姓名（上方 ChildContextHeader 已顯示）。
 */
import { computed } from 'vue'
import {
  ATTENDANCE_STATUS_META,
  HOMEWORK_OVERALL_STATUS_META,
  PICKUP_REQUEST_STATUS_META,
  statusMeta,
  type StatusMeta,
} from '@/shared/constants/statusLabels'
import { PICKUP_OPEN_STATUSES, type PickupRequestStatus } from '@/shared/types/api'
import { formatDateWithWeekday, formatTime } from '@/shared/utils/datetime'
import type { TodayState } from '../../composables/useTodayStatus'
import M3Button from '../m3/M3Button.vue'
import M3Card from '../m3/M3Card.vue'
import M3Icon from '../m3/M3Icon.vue'
import PickupReplyMessage from '../pickup/PickupReplyMessage.vue'
import StatusPill from '../StatusPill.vue'

const props = defineProps<{ today: TodayState | null }>()

const emit = defineEmits<{
  'request-pickup': []
  'arrive-now': []
  'open-homework': []
  'open-pickup': []
}>()

const OPEN: ReadonlySet<PickupRequestStatus> = new Set(PICKUP_OPEN_STATUSES)

// ---- 出勤（on_leave 優先：有請假但當天尚無出勤列時後端 status 回 expected）----
const attendanceStatus = computed(() => props.today?.attendance.status ?? null)

const attendancePill = computed<StatusMeta | null>(() => {
  if (props.today?.on_leave) return ATTENDANCE_STATUS_META.leave
  return attendanceStatus.value ? statusMeta(ATTENDANCE_STATUS_META, attendanceStatus.value) : null
})

const attendanceText = computed(() => {
  const t = props.today
  if (!t) return ''
  if (t.on_leave) return `今日請假（${t.leave?.leave_type_label ?? '請假'}）`
  switch (t.attendance.status) {
    case 'present':
      return `${formatTime(t.attendance.check_in_at)} 到班`
    case 'left':
      return `${formatTime(t.attendance.check_out_at)} 離班`
    case 'absent':
      return '今日缺席'
    case 'expected':
      return '尚未到班'
    default:
      return '尚無出勤紀錄'
  }
})

const leaveRange = computed(() => {
  const leave = props.today?.on_leave ? props.today.leave : null
  if (!leave) return ''
  const first = formatDateWithWeekday(leave.start_date)
  return leave.start_date === leave.end_date ? first : `${first}～${formatDateWithWeekday(leave.end_date)}`
})

// ---- 作業 / 預計可接送 ----
const homework = computed(() => props.today?.homework ?? null)
const homeworkDone = computed(() => homework.value?.overall_status === 'done')
const homeworkPill = computed(() => statusMeta(HOMEWORK_OVERALL_STATUS_META, homework.value?.overall_status))
const homeworkLabel = computed(() => {
  const hw = homework.value
  return hw && hw.item_count > 0 ? `作業進度 ${hw.done_count}/${hw.item_count}` : '作業'
})
const homeworkPercent = computed(() => {
  const hw = homework.value
  if (!hw || hw.item_count <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((hw.done_count / hw.item_count) * 100)))
})

// ---- 接送 ----
const request = computed(() => props.today?.pickup_request ?? null)
const requestOpen = computed(() => !!request.value && OPEN.has(request.value.status))
const requestCompleted = computed(() => request.value?.status === 'completed')
const requestPill = computed(() =>
  requestOpen.value || requestCompleted.value ? statusMeta(PICKUP_REQUEST_STATUS_META, request.value?.status) : null,
)
const completedText = computed(() => {
  const r = request.value
  return r?.completed_at && r.picked_up_by_name ? `${formatTime(r.completed_at)} 已由 ${r.picked_up_by_name} 接走` : '今天已接走'
})

// 沒有進行中請求時，請假 / 缺席 / 已離班不能使用接送
const blockReason = computed(() => {
  if (props.today?.on_leave) return '今日請假'
  if (attendanceStatus.value === 'absent') return '今日缺席'
  if (attendanceStatus.value === 'left') return '已離班'
  return ''
})
</script>

<template>
  <M3Card
    variant="elevated"
    padding="none"
    class="tsc"
    role="region"
    aria-label="今日狀態"
  >
    <div
      v-if="today === null"
      class="tsc-placeholder m3-body-medium"
    >
      尚未取得今日狀態
    </div>
    <p
      v-else-if="!today.is_service_day"
      class="tsc-closed m3-title-medium"
    >
      今天安親班休息
    </p>
    <template v-else>
      <div class="tsc-sec tsc-att">
        <div class="tsc-row">
          <M3Icon
            class="tsc-row__icon"
            name="how_to_reg"
          />
          <span class="tsc-row__label m3-title-small">出勤</span>
          <StatusPill
            v-if="attendancePill"
            :label="attendancePill.label"
            :tone="attendancePill.tone"
          />
        </div>
        <p class="tsc-sub m3-body-medium">
          {{ attendanceText }}
        </p>
        <p
          v-if="leaveRange"
          class="tsc-sub is-muted m3-body-small"
        >
          請假期間 {{ leaveRange }}
        </p>
      </div>

      <button
        v-if="homework"
        type="button"
        class="tsc-sec tsc-hw"
        @click="emit('open-homework')"
      >
        <span class="tsc-row">
          <M3Icon
            class="tsc-row__icon"
            name="assignment"
          />
          <span class="tsc-row__label m3-title-small">{{ homeworkLabel }}</span>
          <StatusPill
            :label="homeworkPill.label"
            :tone="homeworkPill.tone"
          />
          <M3Icon
            class="tsc-hw__chevron"
            name="chevron_right"
          />
        </span>
        <span
          v-if="homework.item_count > 0"
          class="tsc-bar"
          aria-hidden="true"
        >
          <span
            class="tsc-bar__fill"
            :style="{ width: `${homeworkPercent}%` }"
          />
        </span>
        <span
          v-else-if="!homeworkDone"
          class="tsc-sub is-muted m3-body-medium"
        >今天尚無作業項目</span>
      </button>

      <div
        v-if="homework"
        class="tsc-sec tsc-ready"
      >
        <div class="tsc-row">
          <M3Icon
            class="tsc-row__icon"
            :class="{ 'is-done': homeworkDone }"
            :name="homeworkDone ? 'check_circle' : 'schedule'"
            :filled="homeworkDone"
          />
          <p
            v-if="homeworkDone"
            class="tsc-eta is-done m3-title-medium"
          >
            作業已完成，可以來接送了
          </p>
          <p
            v-else-if="homework.ready_eta"
            class="tsc-eta m3-title-medium"
          >
            預計 <span class="tsc-eta__time">{{ homework.ready_eta }}</span> 可接送
          </p>
          <p
            v-else
            class="tsc-eta is-muted m3-body-medium"
          >
            老師尚未提供預計時間
          </p>
        </div>
        <!-- pre-wrap 保留老師輸入的換行：文字包在 span 內，模板縮排才不會變成可見空白 -->
        <p
          v-if="homework.note"
          class="tsc-note m3-body-medium"
        >
          <span>老師說明：{{ homework.note }}</span>
        </p>
      </div>

      <div class="tsc-sec tsc-pickup">
        <div class="tsc-row">
          <M3Icon
            class="tsc-row__icon"
            name="directions_walk"
          />
          <span class="tsc-row__label m3-title-small">接送</span>
          <StatusPill
            v-if="requestPill"
            :label="requestPill.label"
            :tone="requestPill.tone"
          />
        </div>

        <p
          v-if="requestCompleted"
          class="tsc-done m3-title-medium"
        >
          <M3Icon
            name="check_circle"
            filled
          />{{ completedText }}
        </p>

        <template v-else-if="requestOpen && request">
          <div class="tsc-reply">
            <PickupReplyMessage
              :request="request"
              compact
            />
          </div>
          <div class="tsc-actions">
            <M3Button
              :variant="request.can_mark_arrived ? 'outlined' : 'tonal'"
              @click="emit('open-pickup')"
            >
              查看接送
            </M3Button>
            <M3Button
              v-if="request.can_mark_arrived"
              icon="where_to_vote"
              @click="emit('arrive-now')"
            >
              我到了
            </M3Button>
          </div>
        </template>

        <template v-else>
          <p
            v-if="blockReason"
            class="tsc-reason m3-body-medium"
          >
            <M3Icon
              name="info"
              :size="18"
            />{{ blockReason }}，今天無法使用接送
          </p>
          <div class="tsc-actions">
            <M3Button
              icon="directions_walk"
              :disabled="!!blockReason"
              @click="emit('request-pickup')"
            >
              我要來接
            </M3Button>
            <M3Button
              variant="outlined"
              icon="where_to_vote"
              :disabled="!!blockReason"
              @click="emit('arrive-now')"
            >
              我已經到了
            </M3Button>
          </div>
        </template>
      </div>
    </template>
  </M3Card>
</template>

<style scoped>
/* elevated 卡、內距 0；四個區塊以分隔線分開 */
.tsc {
  overflow: hidden;
}

.tsc-sec {
  display: block;
  padding: 12px 16px;
}

.tsc-sec + .tsc-sec {
  border-top: 1px solid var(--m3-outline-variant);
}

.tsc-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 28px;
}

.tsc-row__icon {
  color: var(--m3-on-surface-variant);
}

.tsc-row__icon.is-done {
  color: var(--m3-primary);
}

.tsc-row__label {
  flex: 1;
  min-width: 0;
  color: var(--m3-on-surface);
}

/* 說明文字縮排 36px，對齊區塊標題 */
.tsc-sub {
  display: block;
  margin: 4px 0 0 36px;
  color: var(--m3-on-surface);
  font-variant-numeric: tabular-nums;
}

.tsc-sub.is-muted {
  color: var(--m3-on-surface-variant);
}

/* 作業區塊整塊可點（emit open-homework） */
.tsc-hw {
  position: relative;
  width: 100%;
  margin: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.tsc-hw::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--m3-on-surface);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.tsc-hw:hover::before {
  opacity: var(--m3-state-hover);
}

.tsc-hw:focus-visible::before {
  opacity: var(--m3-state-focus);
}

.tsc-hw:active::before {
  opacity: var(--m3-state-pressed);
}

.tsc-hw:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: -2px;
}

.tsc-hw__chevron {
  margin-right: -4px;
  color: var(--m3-on-surface-variant);
}

.tsc-bar {
  display: block;
  height: 4px;
  margin: 10px 0 2px 36px;
  overflow: hidden;
  border-radius: var(--m3-shape-full);
  background: var(--m3-surface-container-highest);
}

.tsc-bar__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--m3-primary);
  transition: width var(--m3-dur-medium-2) var(--m3-easing-standard);
}

.tsc-eta {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--m3-on-surface);
}

.tsc-eta__time {
  color: var(--m3-primary);
  font-variant-numeric: tabular-nums;
}

.tsc-eta.is-done {
  color: var(--m3-primary);
}

.tsc-eta.is-muted {
  color: var(--m3-on-surface-variant);
  font-weight: 400;
}

.tsc-note {
  margin: 4px 0 0 36px;
  color: var(--m3-on-surface-variant);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tsc-reply {
  margin: 8px 0 0 36px;
}

.tsc-reason {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  color: var(--m3-on-surface-variant);
}

.tsc-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.tsc-actions > * {
  flex: 1 1 0;
  min-width: 0;
}

.tsc-done {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0 36px;
  color: var(--m3-on-surface);
}

.tsc-done .m3-icon {
  color: var(--m3-primary);
}

.tsc-closed {
  margin: 0;
  padding: 24px 16px;
  color: var(--m3-on-surface);
  text-align: center;
}

.tsc-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 120px;
  padding: 16px;
  color: var(--m3-on-surface-variant);
}
</style>
