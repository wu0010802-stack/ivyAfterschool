<script setup lang="ts">
// FRONTEND-130：員工代登記請假（POST /admin/leaves，BACKEND-352：同一學生生效中的請假不可重疊；送出即生效）。
// 設計稿：docs/mockups/page-leaves.html（LeaveFormDialog 段）。
// - FormDialog md：學生（StudentSelect，presetStudent 時預選）→ 假別（三段按鈕，必填、沒有預設）→ 請假期間（daterange，
//   30 天前以前不可選，快捷「今天」「明天」）→ 原因（選填 ≤ 200 字）；表單下方 info 說明送出即生效。
// - 前端驗證不送請求；後端錯誤（重疊、沒有營業日、學生不是在學、422 欄位）顯示在對應欄位下方。
import { ElMessage } from 'element-plus'
import { computed, reactive, ref, watch } from 'vue'
import { createLeave, type LeaveCreate, type Leave, type LeaveOverlapDetails } from '@/api/leaves'
import FormDialog from '@/components/common/FormDialog.vue'
import StudentSelect, { type StudentSelectInitialOption } from '@/components/student/StudentSelect.vue'
import { useFormDirty } from '@/composables/useFormDirty'
import { LEAVE_TYPE_META } from '@/shared/constants/statusLabels'
import { LEAVE_TYPES, type ISODate, type LeaveType } from '@/shared/types/api'
import { addDays, todayTaipei } from '@/shared/utils/datetime'
import { errorCode, errorMessage, validationFieldErrors } from '@/shared/utils/errorMessage'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    presetStudent?: StudentSelectInitialOption
  }>(),
  { presetStudent: undefined },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [leave: Leave]
}>()

/** 單筆最長 61 天（end − start ≤ 60，同後端上限） */
const MAX_SPAN_DAYS = 60
const EARLIEST_DAYS_AGO = 30

interface FormState {
  student_id: string | null
  leave_type: LeaveType | null
  range: [ISODate, ISODate] | null
  reason: string
}

type FieldKey = 'student_id' | 'leave_type' | 'range' | 'reason'

const today = todayTaipei()
const minDate = addDays(today, -EARLIEST_DAYS_AGO)

function blankForm(): FormState {
  return { student_id: props.presetStudent?.id ?? null, leave_type: null, range: null, reason: '' }
}

const form = reactive<FormState>(blankForm())
const errors = reactive<Record<FieldKey, string>>({ student_id: '', leave_type: '', range: '', reason: '' })
const loading = ref(false)
// 每次開啟換新的 key：StudentSelect 只在建立時讀 initialOption
const openSeq = ref(0)
const { isDirty, markClean } = useFormDirty(form)

function clearErrors(): void {
  errors.student_id = ''
  errors.leave_type = ''
  errors.range = ''
  errors.reason = ''
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    Object.assign(form, blankForm())
    clearErrors()
    openSeq.value += 1
    markClean()
  },
  { immediate: true },
)

/** 'YYYY-MM-DD' → 本地日期（日期選單的格子以本地日期表示） */
function localDate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function isoOfLocal(d: Date): ISODate {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function isBeforeEarliest(d: Date): boolean {
  return isoOfLocal(d) < minDate
}

const shortcuts = [
  { text: '今天', value: () => [localDate(today), localDate(today)] },
  { text: '明天', value: () => [localDate(addDays(today, 1)), localDate(addDays(today, 1))] },
]

/** el-radio-group 的 model 型別不接受 null（未選假別時給 undefined） */
const leaveTypeModel = computed<LeaveType | undefined>({
  get: () => form.leave_type ?? undefined,
  set: (value) => {
    form.leave_type = value ?? null
  },
})

const rangeModel = computed<[ISODate, ISODate] | null>({
  get: () => form.range,
  set: (value) => {
    form.range = value && value.length === 2 ? [value[0], value[1]] : null
  },
})

function formatRange(start: ISODate, end: ISODate): string {
  return start === end ? start : `${start}~${end}`
}

function validate(): boolean {
  clearErrors()
  if (!form.student_id) errors.student_id = '請選擇學生'
  if (!form.leave_type) errors.leave_type = '請選擇假別'
  if (!form.range) errors.range = '請選擇請假期間'
  else if (addDays(form.range[0], MAX_SPAN_DAYS) < form.range[1]) errors.range = '單筆請假最長 61 天'
  return !errors.student_id && !errors.leave_type && !errors.range
}

function overlapDetails(err: unknown): LeaveOverlapDetails | null {
  if (typeof err !== 'object' || err === null || !('details' in err)) return null
  const details = (err as { details: unknown }).details as Partial<LeaveOverlapDetails> | null
  return details && typeof details.start_date === 'string' && typeof details.end_date === 'string'
    ? (details as LeaveOverlapDetails)
    : null
}

function showError(err: unknown): void {
  const code = errorCode(err)
  if (code === 'leave_overlap') {
    const d = overlapDetails(err)
    errors.range = d ? `與既有請假（${formatRange(d.start_date, d.end_date)}）重疊` : '與既有請假重疊'
    return
  }
  if (code === 'no_service_days_in_range') {
    errors.range = '所選期間沒有營業日'
    return
  }
  if (code === 'student_not_active') {
    errors.student_id = '此學生不是在學狀態'
    return
  }
  const fields = validationFieldErrors(err)
  const mapped: [FieldKey, string | undefined][] = [
    ['student_id', fields.student_id],
    ['leave_type', fields.leave_type],
    ['range', fields.start_date ?? fields.end_date],
    ['reason', fields.reason],
  ]
  let any = false
  for (const [key, message] of mapped) {
    if (message) {
      errors[key] = message
      any = true
    }
  }
  if (!any) ElMessage.error(errorMessage(err, '送出失敗，請稍後再試'))
}

async function submit(): Promise<void> {
  if (loading.value || !validate()) return
  const [start, end] = form.range!
  const body: LeaveCreate = {
    student_id: form.student_id!,
    leave_type: form.leave_type!,
    start_date: start,
    end_date: end,
  }
  const reason = form.reason.trim()
  if (reason) body.reason = reason
  loading.value = true
  try {
    const created = await createLeave(body)
    ElMessage.success('已登記請假')
    emit('created', created)
    emit('update:modelValue', false)
  } catch (err) {
    showError(err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    title="代登記請假"
    submit-text="送出"
    :loading="loading"
    :dirty="isDirty"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
  >
    <el-form
      label-position="top"
      @submit.prevent
    >
      <el-form-item
        label="學生"
        required
        :error="errors.student_id"
      >
        <StudentSelect
          :key="openSeq"
          v-model="form.student_id"
          :initial-option="presetStudent"
          :disabled="loading"
          @change="errors.student_id = ''"
        />
      </el-form-item>
      <el-form-item
        label="假別"
        required
        :error="errors.leave_type"
      >
        <el-radio-group
          v-model="leaveTypeModel"
          class="lf-type"
          :disabled="loading"
          @change="errors.leave_type = ''"
        >
          <el-radio-button
            v-for="t in LEAVE_TYPES"
            :key="t"
            :value="t"
          >
            {{ LEAVE_TYPE_META[t].label }}
          </el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item
        label="請假期間"
        required
        :error="errors.range"
      >
        <el-date-picker
          v-model="rangeModel"
          class="lf-range"
          type="daterange"
          value-format="YYYY-MM-DD"
          unlink-panels
          range-separator="~"
          start-placeholder="開始日"
          end-placeholder="結束日"
          :disabled-date="isBeforeEarliest"
          :shortcuts="shortcuts"
          :disabled="loading"
          @change="errors.range = ''"
        />
        <div
          v-if="!errors.range"
          class="form-hint"
        >
          單日請假：開始與結束選同一天。最早可選 {{ minDate }}（30 天前）。
        </div>
      </el-form-item>
      <el-form-item
        label="原因（選填）"
        :error="errors.reason"
      >
        <el-input
          v-model="form.reason"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="例如：發燒看醫生"
          :disabled="loading"
          @input="errors.reason = ''"
        />
      </el-form-item>
    </el-form>
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="送出後立即生效，期間內的出勤會改為請假，並通知班級負責老師"
    />
  </FormDialog>
</template>

<style scoped>
.lf-type :deep(.el-radio-button__inner) {
  min-width: 76px;
}

:deep(.lf-range.el-date-editor) {
  width: 100%;
}

.form-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
