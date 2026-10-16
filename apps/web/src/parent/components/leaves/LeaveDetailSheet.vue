<script setup lang="ts">
/**
 * 請假詳情 sheet（ParentBottomSheet，高度自適應）：假別 / 狀態 / 期間摘要 + 明細 + 附件（補上傳）+ 取消。
 * 只做展示與事件：取消確認對話框、取消與上傳的 API 呼叫、成功 / 失敗提示都屬於 LeavesView。
 * 狀態膠囊的規則與 LeaveListItem 相同（cancelled 優先於日期判斷）。
 * 附件 editable 只看 status === 'active'（已結束但仍 active 的請假也能事後補診斷證明）；
 * 數量上限交給 LeaveAttachmentList 的 max 判斷，滿了就不顯示新增並提示「已達 n 個附件上限」。
 * footer（取消按鈕）只在 can_cancel 為 true 時出現；已開始的請假只能取消剩餘日子，按鈕上方說明範圍。
 */
import { computed } from 'vue'
import { formatDateTime, formatDateWithWeekday } from '@/shared/utils/datetime'
import type { ParentLimits } from '../../api/config'
import type { ParentLeave } from '../../api/leaves'
import M3Button from '../m3/M3Button.vue'
import M3Icon from '../m3/M3Icon.vue'
import ParentBottomSheet from '../ParentBottomSheet.vue'
import StatusPill from '../StatusPill.vue'
import LeaveAttachmentList from './LeaveAttachmentList.vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    leave: ParentLeave | null
    studentName: string
    /** 台北今天 YYYY-MM-DD */
    today: string
    limits: ParentLimits
    uploading?: boolean
  }>(),
  { uploading: false },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  cancel: [leave: ParentLeave]
  upload: [file: File]
}>()

const LEAVE_TYPE_ICONS: Record<string, string> = { sick: 'sick', personal: 'event_busy', other: 'event_note' }
const DAY_MS = 86_400_000

// 與 LeaveListItem 同一套規則與 tone
const status = computed<{ label: string; tone: 'info' | 'warning' | 'neutral' }>(() => {
  const l = props.leave
  if (!l || l.status === 'cancelled') return { label: '已取消', tone: 'neutral' }
  if (l.end_date < props.today) return { label: '已結束', tone: 'neutral' }
  if (l.start_date > props.today) return { label: '已排定', tone: 'info' }
  return { label: '請假中', tone: 'warning' }
})

function spanDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1
}

// 'MM/DD（X）～MM/DD（X） · 共 N 天'（含首尾日曆天）
const period = computed(() => {
  const l = props.leave
  if (!l) return ''
  const first = formatDateWithWeekday(l.start_date)
  const range = l.start_date === l.end_date ? first : `${first}～${formatDateWithWeekday(l.end_date)}`
  const days = spanDays(l.start_date, l.end_date)
  return Number.isFinite(days) ? `${range} · 共 ${days} 天` : range
})

const icon = computed(() => LEAVE_TYPE_ICONS[props.leave?.leave_type ?? ''] ?? 'event_busy')
const creator = computed(() => (props.leave?.created_by_type === 'staff' ? '安親班代為登記' : '家長申請'))
const editable = computed(() => props.leave?.status === 'active')

// 已開始（start_date < today）的請假只能取消今天起的日子
const cancelsRemaining = computed(() => (props.leave?.start_date ?? props.today) < props.today)
const cancelLabel = computed(() => (cancelsRemaining.value ? '取消剩餘日子' : '取消請假'))
const remainingNote = computed(
  () => `將取消今天（${props.today.slice(5).replace('-', '/')}）起的請假，之前的日子仍保留為請假`,
)
</script>

<template>
  <ParentBottomSheet
    :model-value="modelValue"
    title="請假詳情"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div
      v-if="leave"
      class="lds"
      :class="{ 'is-cancelled': leave.status === 'cancelled' }"
    >
      <div class="lds-summary">
        <span
          class="lds-summary__icon"
          aria-hidden="true"
        >
          <M3Icon :name="icon" />
        </span>
        <span class="lds-summary__body">
          <span class="lds-summary__head">
            <span class="lds-summary__type m3-title-medium">{{ leave.leave_type_label }}</span>
            <StatusPill
              :label="status.label"
              :tone="status.tone"
            />
          </span>
          <span class="lds-summary__period m3-body-medium">{{ period }}</span>
        </span>
      </div>

      <dl class="lds-kv">
        <div class="lds-kv__row">
          <dt class="lds-kv__k m3-body-medium">
            小孩
          </dt>
          <dd class="lds-kv__v m3-body-medium">
            {{ studentName }}
          </dd>
        </div>
        <div class="lds-kv__row">
          <dt class="lds-kv__k m3-body-medium">
            事由
          </dt>
          <dd
            class="lds-kv__v m3-body-medium"
            :class="{ 'is-empty': !leave.reason }"
          >
            {{ leave.reason || '未填寫' }}
          </dd>
        </div>
        <div class="lds-kv__row">
          <dt class="lds-kv__k m3-body-medium">
            申請者
          </dt>
          <dd class="lds-kv__v m3-body-medium">
            {{ creator }}
          </dd>
        </div>
        <div class="lds-kv__row">
          <dt class="lds-kv__k m3-body-medium">
            申請時間
          </dt>
          <dd class="lds-kv__v m3-body-medium">
            {{ formatDateTime(leave.created_at) }}
          </dd>
        </div>
        <div
          v-if="leave.cancelled_at"
          class="lds-kv__row"
        >
          <dt class="lds-kv__k m3-body-medium">
            取消時間
          </dt>
          <dd class="lds-kv__v m3-body-medium">
            {{ formatDateTime(leave.cancelled_at) }}
          </dd>
        </div>
      </dl>

      <h3 class="lds-section m3-title-small">
        附件
      </h3>
      <LeaveAttachmentList
        :attachments="leave.attachments"
        :editable="editable"
        :uploading="uploading"
        :max="limits.leave_max_attachments"
        :max-mb="limits.leave_max_attachment_mb"
        @upload="emit('upload', $event)"
      />
    </div>

    <template
      v-if="leave && leave.can_cancel"
      #footer
    >
      <div class="lds-cancel">
        <p
          v-if="cancelsRemaining"
          class="lds-cancel__note m3-body-small"
        >
          <M3Icon
            name="info"
            :size="16"
          />
          <span>{{ remainingNote }}</span>
        </p>
        <M3Button
          variant="outlined"
          block
          @click="emit('cancel', leave)"
        >
          {{ cancelLabel }}
        </M3Button>
      </div>
    </template>
  </ParentBottomSheet>
</template>

<style scoped>
.lds-summary {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 4px 0 16px;
  border-bottom: 1px solid var(--m3-outline-variant);
}

.lds-summary__icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--m3-shape-full);
  background: var(--m3-secondary-container);
  color: var(--m3-on-secondary-container);
}

.lds-summary__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.lds-summary__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
}

.lds-summary__type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lds-summary__period {
  color: var(--m3-on-surface);
  font-variant-numeric: tabular-nums;
}

/* 已取消：摘要淡化但保持可讀 */
.lds.is-cancelled .lds-summary__icon {
  background: var(--m3-surface-container-high);
  color: var(--m3-on-surface-variant);
}

.lds.is-cancelled .lds-summary__type,
.lds.is-cancelled .lds-summary__period {
  color: var(--m3-on-surface-variant);
}

.lds-kv {
  margin: 0;
}

.lds-kv__row {
  display: flex;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--m3-outline-variant);
}

.lds-kv__k {
  flex: none;
  width: 72px;
  color: var(--m3-on-surface-variant);
}

.lds-kv__v {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--m3-on-surface);
  font-variant-numeric: tabular-nums;
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.lds-kv__v.is-empty {
  color: var(--m3-on-surface-variant);
}

.lds-section {
  margin: 20px 0 8px;
  color: var(--m3-on-surface);
}

.lds-cancel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lds-cancel__note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  color: var(--m3-on-surface-variant);
}
</style>
