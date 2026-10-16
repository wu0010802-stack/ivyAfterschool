<script setup lang="ts">
// FRONTEND-131：取消請假（POST /admin/leaves/{id}/cancel，BACKEND-353；domain_spec M5）。
// 設計稿：docs/mockups/page-leaves.html（LeaveCancelDialog 段）。
// 依今天判斷可選範圍：
// - 尚未開始或今天才開始（start_date ≥ today）：只能整筆取消，送 remaining（此時與 all 結果相同）。
// - 已開始（start_date < today ≤ end_date）：預設 remaining（end_date 改為昨天），可改選 all。
// - 已結束（end_date < today）：只送 all（事後更正），避免 409 leave_already_ended。
// 409 leave_not_active / leave_already_ended：頂端 alert 顯示後端訊息、保持開啟、emit failed，由列表於關閉後重新整理。
import { Bell } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { cancelLeave, type Leave, type LeaveCancelScope } from '@/api/leaves'
import FormDialog from '@/components/common/FormDialog.vue'
import { LEAVE_TYPE_META } from '@/shared/constants/statusLabels'
import type { ISODate } from '@/shared/types/api'
import { addDays, todayTaipei } from '@/shared/utils/datetime'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'

type Phase = 'future' | 'started' | 'ended'

const FAILED_CODES = new Set(['leave_not_active', 'leave_already_ended'])

const props = defineProps<{
  modelValue: boolean
  leave: Leave
  /** 預設 todayTaipei() */
  today?: ISODate
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  cancelled: [leave: Leave]
  failed: [code: string]
  closed: []
}>()

const scope = ref<LeaveCancelScope>('remaining')
const errorMsg = ref('')
const loading = ref(false)

const today = computed<ISODate>(() => props.today ?? todayTaipei())

/** 同一天只顯示一天 */
function formatRange(start: ISODate, end: ISODate): string {
  return start === end ? start : `${start}~${end}`
}

const phase = computed<Phase>(() => {
  const { start_date: start, end_date: end } = props.leave
  if (end < today.value) return 'ended'
  if (start >= today.value) return 'future'
  return 'started'
})

const submitScope = computed<LeaveCancelScope>(() => {
  if (phase.value === 'ended') return 'all'
  if (phase.value === 'future') return 'remaining'
  return scope.value
})

const title = computed(() => (phase.value === 'ended' ? '整筆取消請假' : '取消請假'))
const submitText = computed(() => (submitScope.value === 'all' ? '整筆取消' : '取消請假'))
const typeTone = computed(() => LEAVE_TYPE_META[props.leave.leave_type]?.tone ?? 'info')
const period = computed(() => formatRange(props.leave.start_date, props.leave.end_date))
const remainingRange = computed(() => formatRange(today.value, props.leave.end_date))
const keptRange = computed(() => formatRange(props.leave.start_date, addDays(today.value, -1)))

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    scope.value = 'remaining'
    errorMsg.value = ''
  },
  { immediate: true },
)

async function submit(): Promise<void> {
  if (loading.value) return
  errorMsg.value = ''
  loading.value = true
  try {
    const updated = await cancelLeave(props.leave.id, submitScope.value)
    ElMessage.success('已取消請假')
    emit('cancelled', updated)
    emit('update:modelValue', false)
  } catch (err) {
    errorMsg.value = errorMessage(err, '取消失敗，請稍後再試')
    const code = errorCode(err)
    if (code !== null && FAILED_CODES.has(code)) emit('failed', code)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="title"
    cancel-text="返回"
    :submit-text="submitText"
    :loading="loading"
    :autofocus="false"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
    @closed="emit('closed')"
  >
    <el-alert
      v-if="errorMsg"
      class="lc-error"
      type="error"
      show-icon
      :title="errorMsg"
      @close="errorMsg = ''"
    />
    <div class="lc-summary">
      <span class="lc-summary__name">{{ leave.student.name }}</span>（{{ leave.student.student_no }}・{{
        leave.student.class_name || '未分班'
      }}）<br>
      <el-tag
        :type="typeTone"
        size="small"
        disable-transitions
      >
        {{ leave.leave_type_label }}
      </el-tag>
      <span class="lc-summary__period">{{ period }}</span>
    </div>

    <div
      v-if="phase === 'future'"
      class="lc-only"
    >
      <span class="lc-only__title">將取消整筆請假</span>
    </div>
    <el-radio-group
      v-else-if="phase === 'started'"
      v-model="scope"
      class="lc-options"
      aria-label="取消範圍"
      :disabled="loading"
    >
      <el-radio
        value="remaining"
        border
      >
        <span class="lc-option__title">取消今天起的請假（{{ remainingRange }}）</span>
        <span class="lc-option__desc">今天起的出勤會恢復為預計到班；{{ keptRange }} 保留為請假</span>
      </el-radio>
      <el-radio
        value="all"
        border
      >
        <span class="lc-option__title">整筆取消（{{ period }}）</span>
        <span class="lc-option__desc">已過去的日子也會改回，已登記到班或離班的紀錄不受影響</span>
      </el-radio>
    </el-radio-group>
    <div
      v-else
      class="lc-only"
    >
      已結束的請假只能整筆取消（事後更正）；期間內登記為請假的出勤會自動還原，已登記到班或離班的紀錄不受影響
    </div>

    <div class="lc-notify">
      <el-icon><Bell /></el-icon>取消後會通知班級負責老師
    </div>
  </FormDialog>
</template>

<style scoped>
.lc-error {
  margin-bottom: 12px;
}

.lc-summary {
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.lc-summary__name {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.lc-summary__period {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
}

.lc-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.lc-options :deep(.el-radio.is-bordered) {
  align-items: flex-start;
  width: 100%;
  height: auto;
  padding: 10px 14px;
  margin: 0;
  white-space: normal;
}

.lc-options :deep(.el-radio__input) {
  margin-top: 3px;
}

.lc-option__title {
  display: block;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  color: var(--el-text-color-primary);
}

.lc-option__desc {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.lc-only {
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.lc-only__title {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.lc-notify {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
