<script setup lang="ts">
// FRONTEND-125：出勤改判（attendance:amend，BACKEND-310 寫 audit；請假列不可改判）。
// 設計稿：docs/mockups/page-attendance-today.html（改判 dialog 段）。
// - 以 FormDialog md 呈現；開啟時以當下的 row 為比較基準，只送有變更的欄位 + reason。
// - 時間以台北 HH:MM 輸入，送出時 hhmmToUtcIso(service_date, HH:MM) 轉 UTC；未改的時間不送（保留原本的秒數與來源）。
// - 狀態改為 expected / absent 時不送時間：後端會清空到離班時間；改回 present 時後端清空離班時間。
// - 「儲存」只看欄位變更（不含原因）；關閉確認看整張表單（含原因）。
import { ElMessage } from 'element-plus'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import {
  amendAttendance,
  type AmendableAttendanceStatus,
  type AttendanceAmend,
  type AttendanceRow,
} from '@/api/attendance'
import FormDialog from '@/components/common/FormDialog.vue'
import { useFormDirty } from '@/composables/useFormDirty'
import { ATTENDANCE_STATUS_META } from '@/shared/constants/statusLabels'
import type { AttendanceStatus, HHMM } from '@/shared/types/api'
import { formatTime, hhmmToUtcIso, utcIsoToHHMM } from '@/shared/utils/datetime'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  modelValue: boolean
  row: AttendanceRow
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  amended: [row: AttendanceRow]
}>()

interface AmendForm {
  status: AttendanceStatus
  check_in: HHMM | null
  check_out: HHMM | null
  note: string
  reason: string
}

type FieldKey = 'check_in' | 'check_out' | 'reason'
type AmendChanges = Omit<AttendanceAmend, 'reason'>

const AMENDABLE: AmendableAttendanceStatus[] = ['expected', 'present', 'left', 'absent']
const MAX_LENGTH = 200
const REASON_REQUIRED = '請填寫改判原因，將記錄於稽核紀錄'

/** 後端 422 錯誤碼 → 顯示在哪個時間欄位 */
const TIME_ERROR_FIELDS: Record<string, FieldKey> = {
  check_in_required: 'check_in',
  check_out_required: 'check_out',
  invalid_times: 'check_out',
  time_not_on_service_date: 'check_in',
}

const base = shallowRef<AttendanceRow>(props.row)
const form = reactive<AmendForm>(initialForm(props.row))
const errors = reactive<Record<FieldKey, string>>({ check_in: '', check_out: '', reason: '' })
const saving = ref(false)
const { isDirty, markClean } = useFormDirty(form)

function toHHMM(iso: string | null): HHMM | null {
  return iso ? utcIsoToHHMM(iso) : null
}

function initialForm(row: AttendanceRow): AmendForm {
  return {
    status: row.status,
    check_in: toHHMM(row.check_in_at),
    check_out: toHHMM(row.check_out_at),
    note: row.note ?? '',
    reason: '',
  }
}

function clearErrors(): void {
  errors.check_in = ''
  errors.check_out = ''
  errors.reason = ''
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    base.value = props.row
    Object.assign(form, initialForm(props.row))
    clearErrors()
    markClean()
  },
  { immediate: true },
)

const needsIn = computed(() => form.status === 'present' || form.status === 'left')
const needsOut = computed(() => form.status === 'left')

const currentText = computed(() => {
  const row = base.value
  const parts = [row.service_date, row.class_name ?? '未分班', `目前：${ATTENDANCE_STATUS_META[row.status].label}`]
  if (row.check_in_at) parts.push(`到班 ${formatTime(row.check_in_at)}`)
  if (row.check_out_at) parts.push(`離班 ${formatTime(row.check_out_at)}`)
  return parts.join('・')
})

function isAmendable(status: AttendanceStatus): status is AmendableAttendanceStatus {
  return (AMENDABLE as AttendanceStatus[]).includes(status)
}

const changes = computed<AmendChanges>(() => {
  const row = base.value
  const out: AmendChanges = {}
  if (form.status !== row.status && isAmendable(form.status)) out.status = form.status
  if (needsIn.value && form.check_in !== toHHMM(row.check_in_at)) {
    out.check_in_at = form.check_in ? hhmmToUtcIso(row.service_date, form.check_in) : null
  }
  if (needsOut.value && form.check_out !== toHHMM(row.check_out_at)) {
    out.check_out_at = form.check_out ? hhmmToUtcIso(row.service_date, form.check_out) : null
  }
  const note = form.note.trim()
  if (note !== (row.note ?? '')) out.note = note || null
  return out
})

const hasChanges = computed(() => Object.keys(changes.value).length > 0)

function validate(): boolean {
  clearErrors()
  if (needsIn.value && !form.check_in) errors.check_in = '請填寫到班時間'
  if (needsOut.value && !form.check_out) errors.check_out = '請填寫離班時間'
  else if (needsOut.value && form.check_in && form.check_out && form.check_out < form.check_in) {
    errors.check_out = '離班時間不可早於到班時間'
  }
  if (!form.reason.trim()) errors.reason = REASON_REQUIRED
  return !errors.check_in && !errors.check_out && !errors.reason
}

function showError(err: unknown): void {
  const code = errorCode(err)
  const field = code ? TIME_ERROR_FIELDS[code] : undefined
  if (field) {
    errors[field] = errorMessage(err, '時間不正確')
    return
  }
  if (code === 'no_changes') {
    ElMessage.error('沒有任何變更')
    return
  }
  if (code === 'attendance_managed_by_leave') {
    ElMessage.error('請假中的出勤請到請假頁取消請假')
    return
  }
  ElMessage.error(errorMessage(err, '改判失敗，請稍後再試'))
}

async function submit(): Promise<void> {
  const id = base.value.id
  if (saving.value || id === null || !hasChanges.value || !validate()) return
  saving.value = true
  try {
    const saved = await amendAttendance(id, { ...changes.value, reason: form.reason.trim() })
    ElMessage.success('已改判')
    emit('amended', saved)
    emit('update:modelValue', false)
  } catch (err) {
    showError(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="`改判出勤：${base.student_name}`"
    size="md"
    :loading="saving"
    :dirty="isDirty"
    :submit-disabled="!hasChanges"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
  >
    <div
      class="amend-current"
      data-test="amend-current"
    >
      {{ currentText }}
    </div>
    <el-form
      label-position="top"
      :disabled="saving"
      @submit.prevent
    >
      <el-form-item label="狀態">
        <el-radio-group
          v-model="form.status"
          class="amend-status"
        >
          <el-radio-button
            v-for="s in AMENDABLE"
            :key="s"
            :value="s"
          >
            {{ ATTENDANCE_STATUS_META[s].label }}
          </el-radio-button>
        </el-radio-group>
      </el-form-item>
      <div
        v-if="needsIn"
        class="amend-times"
      >
        <el-form-item
          label="到班時間"
          required
          :error="errors.check_in"
        >
          <el-time-picker
            v-model="form.check_in"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="HH:MM"
            size="large"
            :clearable="false"
            @change="errors.check_in = ''"
          />
        </el-form-item>
        <el-form-item
          v-if="needsOut"
          label="離班時間"
          required
          :error="errors.check_out"
        >
          <el-time-picker
            v-model="form.check_out"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="HH:MM"
            size="large"
            :clearable="false"
            @change="errors.check_out = ''"
          />
        </el-form-item>
      </div>
      <el-form-item label="備註">
        <el-input
          v-model="form.note"
          type="textarea"
          :rows="2"
          :maxlength="MAX_LENGTH"
          show-word-limit
          placeholder="選填"
        />
      </el-form-item>
      <el-form-item
        label="改判原因"
        required
        :error="errors.reason"
      >
        <el-input
          v-model="form.reason"
          type="textarea"
          :rows="2"
          :maxlength="MAX_LENGTH"
          show-word-limit
          placeholder="例如：家長提早接走未登記"
          @input="errors.reason = ''"
        />
        <div class="amend-hint">
          改判原因會記錄於稽核紀錄。
        </div>
      </el-form-item>
    </el-form>
  </FormDialog>
</template>

<style scoped>
.amend-current {
  padding: 10px 12px;
  margin-bottom: 16px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

/* 狀態分段按鈕與時間欄位：平板觸控高度 ≥ 44px */
.amend-status :deep(.el-radio-button__inner) {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 16px;
}

.amend-times {
  display: flex;
  gap: 16px;
}

.amend-times .el-form-item {
  flex: 1;
}

.amend-times :deep(.el-date-editor) {
  width: 100%;
}

.amend-times :deep(.el-input__wrapper) {
  min-height: 44px;
}

.amend-hint {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
