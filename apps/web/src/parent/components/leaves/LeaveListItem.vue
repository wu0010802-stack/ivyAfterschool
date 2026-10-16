<script setup lang="ts">
/**
 * 請假紀錄列（純展示）：根元素 li，裡面兩個並列、不巢狀的互動元素——整列主按鈕（emit open）與取消按鈕（emit cancel）。
 * li 本身不掛 click，所以點取消不會觸發 open，也不需要 stopPropagation。
 * 狀態膠囊由 leave 與 today 計算（cancelled 優先於日期判斷：員工可能從後台整筆取消已結束的請假）；
 * 取消確認對話框、空清單、載入中與載入更多屬於 LeavesView。
 */
import { computed } from 'vue'
import { formatDateWithWeekday } from '@/shared/utils/datetime'
import type { ParentLeave } from '../../api/leaves'
import M3Button from '../m3/M3Button.vue'
import M3Icon from '../m3/M3Icon.vue'
import StatusPill from '../StatusPill.vue'

const props = defineProps<{ leave: ParentLeave; today: string }>()

const emit = defineEmits<{ open: [leave: ParentLeave]; cancel: [leave: ParentLeave] }>()

const LEAVE_TYPE_ICONS: Record<string, string> = { sick: 'sick', personal: 'event_busy', other: 'event_note' }

const isCancelled = computed(() => props.leave.status === 'cancelled')

// tone 是列表自己計算的狀態，不在 FRONTEND-005 的對照表內
const status = computed<{ label: string; tone: 'info' | 'warning' | 'neutral' }>(() => {
  if (isCancelled.value) return { label: '已取消', tone: 'neutral' }
  if (props.leave.end_date < props.today) return { label: '已結束', tone: 'neutral' }
  if (props.leave.start_date > props.today) return { label: '已排定', tone: 'info' }
  return { label: '請假中', tone: 'warning' }
})

const period = computed(() => {
  const { start_date: start, end_date: end } = props.leave
  const first = formatDateWithWeekday(start)
  return start === end ? first : `${first}～${formatDateWithWeekday(end)}`
})

// 事由只取第一行，單行省略交給樣式
const reasonLine = computed(
  () =>
    (props.leave.reason ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '',
)

const attachmentCount = computed(() => props.leave.attachments.length)

// 已開始的請假只能取消剩餘日子（後端把 end_date 改為昨天）；今天開始仍算整筆取消
const cancelLabel = computed(() => (props.leave.start_date >= props.today ? '取消請假' : '取消剩餘日子'))

const icon = computed(() => LEAVE_TYPE_ICONS[props.leave.leave_type] ?? 'event_busy')
</script>

<template>
  <li
    class="leave-item"
    :class="{ 'is-cancelled': isCancelled }"
  >
    <button
      type="button"
      class="leave-item__main"
      @click="emit('open', leave)"
    >
      <span
        class="leave-item__icon"
        aria-hidden="true"
      >
        <M3Icon :name="icon" />
      </span>
      <span class="leave-item__body">
        <span class="leave-item__head">
          <span class="leave-item__type m3-title-medium">{{ leave.leave_type_label }}</span>
          <StatusPill
            class="leave-item__status"
            :label="status.label"
            :tone="status.tone"
          />
        </span>
        <span class="leave-item__period m3-body-medium">{{ period }}</span>
        <span
          v-if="reasonLine || attachmentCount"
          class="leave-item__meta m3-body-medium"
        >
          <span class="leave-item__reason">{{ reasonLine }}</span>
          <span
            v-if="attachmentCount"
            class="leave-item__attach"
          >
            <M3Icon
              name="attach_file"
              :size="16"
            />{{ attachmentCount }}<span class="visually-hidden"> 個附件</span>
          </span>
        </span>
      </span>
    </button>
    <div
      v-if="leave.can_cancel"
      class="leave-item__actions"
    >
      <M3Button
        variant="text"
        @click="emit('cancel', leave)"
      >
        {{ cancelLabel }}
      </M3Button>
    </div>
  </li>
</template>

<style scoped>
.leave-item {
  list-style: none;
}

/* 列間分隔線由列自己畫 */
.leave-item + .leave-item {
  border-top: 1px solid var(--m3-outline-variant);
}

.leave-item__main {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 16px;
  width: 100%;
  min-height: 72px;
  margin: 0;
  padding: 12px 16px;
  border: none;
  background: transparent;
  color: var(--m3-on-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* state layer：hover 0.08 / pressed 0.12 */
.leave-item__main::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--m3-on-surface);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.leave-item__main:hover::before {
  opacity: var(--m3-state-hover);
}

.leave-item__main:focus-visible::before {
  opacity: var(--m3-state-focus);
}

.leave-item__main:active::before {
  opacity: var(--m3-state-pressed);
}

.leave-item__main:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: -2px;
}

.leave-item__icon {
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

.leave-item__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.leave-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
}

.leave-item__type {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leave-item__status {
  flex: none;
}

.leave-item__period {
  color: var(--m3-on-surface);
  font-variant-numeric: tabular-nums;
}

.leave-item__meta {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--m3-on-surface-variant);
}

.leave-item__reason {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.leave-item__attach {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

/* 取消按鈕靠右放在內容下方，左側縮排對齊內容；往上收進主按鈕底部 padding */
.leave-item__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: -8px;
  padding: 0 4px 4px 72px;
}

/* 已取消：整列淡化但保持可讀，不加刪除線 */
.leave-item.is-cancelled .leave-item__type,
.leave-item.is-cancelled .leave-item__period {
  color: var(--m3-on-surface-variant);
}

.leave-item.is-cancelled .leave-item__icon {
  background: var(--m3-surface-container-high);
  color: var(--m3-on-surface-variant);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  border: 0;
  white-space: nowrap;
  clip: rect(0 0 0 0);
}
</style>
