<script setup lang="ts">
// FRONTEND-124：今日出勤頁的逐生卡片。設計稿：docs/mockups/page-attendance-today.html（AttendanceStudentCard 段）。
// - 操作按鈕只在 canOperate（有 attendance:operate 且日期是今天）且不在選取模式時出現，觸控高度 ≥ 44px：
//   expected →「到班」+「缺席」；absent →「到班」（遲到補登）；present →「離班」；left / leave 無按鈕。
// - ⋮「改判」：canAmend、row.id 非 null（虛擬列不可改判）、status 不是 leave，且不在選取模式。
// - 選取模式（批次到班）：只有 expected / absent 可選，整卡可點；其他卡蓋半透明遮罩。
import { ChatDotRound, Check, MoreFilled } from '@element-plus/icons-vue'
import { computed } from 'vue'
import type { AttendanceRow } from '@/api/attendance'
import {
  ATTENDANCE_STATUS_META,
  CHECK_IN_SOURCE_LABELS,
  CHECK_OUT_SOURCE_LABELS,
} from '@/shared/constants/statusLabels'
import { formatTime } from '@/shared/utils/datetime'

const props = withDefaults(
  defineProps<{
    row: AttendanceRow
    canOperate: boolean
    canAmend: boolean
    selectable?: boolean
    selected?: boolean
    busy?: boolean
  }>(),
  { selectable: false, selected: false, busy: false },
)

const emit = defineEmits<{
  'check-in': [row: AttendanceRow]
  'check-out': [row: AttendanceRow]
  'mark-absent': [row: AttendanceRow]
  amend: [row: AttendanceRow]
  'toggle-select': [row: AttendanceRow]
}>()

type ActionEvent = 'check-in' | 'check-out' | 'mark-absent'

interface Action {
  key: string
  label: string
  event: ActionEvent
  type: 'primary' | 'default'
  plain: boolean
  /** 只有主要動作顯示 loading，其餘只停用 */
  showLoading: boolean
}

const meta = computed(() => ATTENDANCE_STATUS_META[props.row.status])
const canSelect = computed(() => props.row.status === 'expected' || props.row.status === 'absent')
const isSelectable = computed(() => props.selectable && canSelect.value)
const showAmend = computed(
  () => props.canAmend && props.row.id !== null && props.row.status !== 'leave' && !props.selectable,
)

const actions = computed<Action[]>(() => {
  if (!props.canOperate || props.selectable) return []
  switch (props.row.status) {
    case 'expected':
      return [
        { key: 'in', label: '到班', event: 'check-in', type: 'primary', plain: false, showLoading: true },
        { key: 'absent', label: '缺席', event: 'mark-absent', type: 'default', plain: false, showLoading: false },
      ]
    case 'absent':
      return [{ key: 'in', label: '到班', event: 'check-in', type: 'primary', plain: true, showLoading: true }]
    case 'present':
      return [{ key: 'out', label: '離班', event: 'check-out', type: 'default', plain: false, showLoading: true }]
    default:
      return []
  }
})

const checkInSource = computed(() => {
  const source = props.row.check_in_source
  return source && source !== 'manual' ? CHECK_IN_SOURCE_LABELS[source] : ''
})

const checkOutSource = computed(() => {
  const source = props.row.check_out_source
  return source && source !== 'manual' ? CHECK_OUT_SOURCE_LABELS[source] : ''
})

const leaveText = computed(() => {
  const leave = props.row.leave
  if (props.row.status !== 'leave' || !leave) return ''
  return `${leave.leave_type_label} ${leave.start_date}~${leave.end_date}`
})

function runAction(action: Action): void {
  if (props.busy) return
  // 三個事件的 payload 型別相同，逐一列出以保留 defineEmits 的型別檢查
  if (action.event === 'check-in') emit('check-in', props.row)
  else if (action.event === 'check-out') emit('check-out', props.row)
  else emit('mark-absent', props.row)
}

function onCardClick(): void {
  if (isSelectable.value) emit('toggle-select', props.row)
}
</script>

<template>
  <div
    class="acard"
    :class="[`tone-${meta.tone}`, { 'is-selectable': isSelectable, 'is-selected': isSelectable && selected }]"
    :role="isSelectable ? 'checkbox' : undefined"
    :aria-checked="isSelectable ? String(selected) : undefined"
    :tabindex="isSelectable ? 0 : undefined"
    @click="onCardClick"
    @keydown.space.prevent="onCardClick"
  >
    <div class="acard__top">
      <span class="acard__name">{{ row.student_name }}</span>
      <el-tag
        :type="meta.tone"
        disable-transitions
      >
        {{ meta.label }}
      </el-tag>
      <el-dropdown
        v-if="showAmend"
        class="acard__menu"
        trigger="click"
        @command="emit('amend', row)"
      >
        <el-button
          class="acard__more"
          text
          aria-label="更多操作"
        >
          <el-icon :size="18">
            <MoreFilled />
          </el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="amend">
              改判
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div class="acard__meta">
      {{ row.student_no }}・{{ row.grade_level }} 年級・{{ row.class_name ?? '未分班' }}
    </div>
    <div class="acard__times">
      <span v-if="row.check_in_at">
        到班 {{ formatTime(row.check_in_at) }}<el-tag
          v-if="checkInSource"
          size="small"
          type="info"
          disable-transitions
        >{{ checkInSource }}</el-tag>
      </span>
      <span v-if="row.check_out_at">
        離班 {{ formatTime(row.check_out_at) }}<el-tag
          v-if="checkOutSource"
          size="small"
          type="info"
          disable-transitions
        >{{ checkOutSource }}</el-tag>
      </span>
      <span v-if="leaveText">{{ leaveText }}</span>
      <el-tooltip
        v-if="row.note"
        :content="row.note"
        placement="top"
      >
        <span
          class="acard__note"
          data-test="att-note"
        >
          <el-icon><ChatDotRound /></el-icon>備註
        </span>
      </el-tooltip>
    </div>
    <div
      v-if="actions.length"
      class="acard__actions"
      data-test="att-actions"
    >
      <el-button
        v-for="action in actions"
        :key="action.key"
        :type="action.type"
        :plain="action.plain"
        :loading="busy && action.showLoading"
        :disabled="busy"
        @click.stop="runAction(action)"
      >
        {{ action.label }}
      </el-button>
    </div>
    <span
      v-if="isSelectable"
      class="acard__check"
      aria-hidden="true"
    >
      <el-icon
        v-if="selected"
        :size="14"
      ><Check /></el-icon>
    </span>
    <div
      v-if="selectable && !canSelect"
      class="acard__mask"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.acard {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 148px;
  padding: 12px 12px 12px 16px;
  overflow: hidden;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

/* 左側 4px 狀態色條：預計到班 warning、已到班 success、缺席 danger、已離班 / 請假 info 淡灰 */
.acard::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 4px;
  content: '';
  background: var(--el-color-info-light-5);
}

.acard.tone-warning::before {
  background: var(--el-color-warning);
}

.acard.tone-success::before {
  background: var(--el-color-success);
}

.acard.tone-danger::before {
  background: var(--el-color-danger);
}

.acard__top {
  display: flex;
  gap: 6px;
  align-items: center;
}

.acard__name {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
}

.acard__menu {
  margin-left: auto;
}

/* ⋮ 觸控目標 44×44，以負邊距抵銷，不撐高標題列 */
.acard__more {
  width: 44px;
  height: 44px;
  margin: -10px -8px -10px 0;
}

.acard__meta {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.acard__times {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-regular);
}

.acard__times .el-tag {
  margin-left: 4px;
}

.acard__note {
  display: inline-flex;
  gap: 2px;
  align-items: center;
  color: var(--el-text-color-secondary);
  cursor: help;
}

/* 按鈕固定在卡片底部、等寬撐滿，觸控高度 ≥ 44px */
.acard__actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
}

.acard__actions .el-button {
  flex: 1;
  min-height: 44px;
  margin-left: 0;
  font-size: 15px;
}

.acard.is-selectable {
  cursor: pointer;
}

.acard.is-selected {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary);
  box-shadow: inset 0 0 0 1px var(--el-color-primary);
}

.acard__check {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: var(--el-color-white);
  background: var(--el-bg-color);
  border: 2px solid var(--el-border-color);
  border-radius: 50%;
}

.acard.is-selected .acard__check {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
}

.acard__mask {
  position: absolute;
  inset: 0;
  cursor: not-allowed;
  background: var(--el-bg-color);
  opacity: 0.6;
}
</style>
