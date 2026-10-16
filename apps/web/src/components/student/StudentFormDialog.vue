<script setup lang="ts">
// FRONTEND-089：新增 / 編輯學生。移植 ivy FE:src/components/student/StudentEditDialog.vue 的 FormDialog + 分段表單
// + dirty 防呆 + 422 欄位錯誤對應；欄位改為本專案 StudentCreate，去掉家長 / 緊急聯絡 / 政府申報分段與 lifecycle。
// 設計稿：docs/mockups/page-students.html（StudentFormDialog 段）。
// - 四個分段：基本資料、就讀、狀態、敏感資料（只有 students:sensitive 才渲染，domain_spec M3）。
// - 編輯只送有變更的欄位；敏感欄位初始為空（留空不變更），勾「清除已填寫的資料」送 null。
// - 編輯時改為暫停 / 退班先確認（BACKEND-529 會自動收尾接送、代理授權、出勤與請假）。
import { Lock } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, reactive, ref, watch } from 'vue'
import {
  createStudent,
  updateStudent,
  type StudentCreate,
  type StudentDetail,
  type StudentUpdate,
} from '@/api/students'
import FormDialog from '@/components/common/FormDialog.vue'
import { useFormDirty } from '@/composables/useFormDirty'
import { GENDER_LABELS, STUDENT_STATUS_META } from '@/shared/constants/statusLabels'
import { GENDERS, STUDENT_STATUSES, type Gender, type ISODate, type StudentStatus } from '@/shared/types/api'
import { todayTaipei } from '@/shared/utils/datetime'
import { errorCode, errorMessage, validationFieldErrors } from '@/shared/utils/errorMessage'
import { useLookupsStore, type LookupOption } from '@/stores/lookups'
import { currentAcademicYear, GRADE_OPTIONS } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** 有值 = 編輯 */
    student?: StudentDetail
  }>(),
  { student: undefined },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [detail: StudentDetail]
}>()

const ID_NUMBER_RE = /^[A-Z][12]\d{8}$/
const STATUS_CONFIRM_TEXT =
  '儲存後系統會自動：取消今天進行中的接送請求與有效的代理接送授權、刪除今天起尚未登記的出勤、取消未來的請假（已開始的截到昨天）。已發生的紀錄會保留。'

interface FormState {
  student_no: string
  name: string
  gender: Gender | null
  birthday: ISODate | null
  grade_level: number | null
  school_id: string | null
  school_class: string
  class_id: string | null
  status: StudentStatus
  enrolled_on: ISODate | null
  withdrawn_on: ISODate | null
  note: string
  id_number: string
  health_note: string
  clear_id_number: boolean
  clear_health_note: boolean
}

const FIELD_KEYS = [
  'student_no',
  'name',
  'gender',
  'birthday',
  'grade_level',
  'school_id',
  'school_class',
  'class_id',
  'status',
  'enrolled_on',
  'withdrawn_on',
  'note',
  'id_number',
  'health_note',
] as const
type FieldKey = (typeof FIELD_KEYS)[number]

/** 一般欄位（敏感欄位另外處理） */
type BasicBody = Required<Omit<StudentCreate, 'id_number' | 'health_note'>>

const lookups = useLookupsStore()
const { can } = usePermission()
const canSensitive = computed(() => can('students:sensitive'))
const academicYear = currentAcademicYear()

function initialForm(): FormState {
  const s = props.student
  return {
    student_no: s?.student_no ?? '',
    name: s?.name ?? '',
    gender: s?.gender ?? null,
    birthday: s?.birthday ?? null,
    grade_level: s?.grade_level ?? null,
    school_id: s?.school?.id ?? null,
    school_class: s?.school_class ?? '',
    class_id: s?.class?.id ?? null,
    status: s?.status ?? 'active',
    enrolled_on: s ? s.enrolled_on : todayTaipei(),
    withdrawn_on: s?.withdrawn_on ?? null,
    note: s?.note ?? '',
    id_number: '',
    health_note: '',
    clear_id_number: false,
    clear_health_note: false,
  }
}

const form = reactive<FormState>(initialForm())
const errors = reactive<Record<FieldKey, string>>(
  Object.fromEntries(FIELD_KEYS.map((k) => [k, ''])) as Record<FieldKey, string>,
)
const loading = ref(false)
const { isDirty, markClean } = useFormDirty(form)

function clearErrors(): void {
  for (const key of FIELD_KEYS) errors[key] = ''
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    Object.assign(form, initialForm())
    clearErrors()
    markClean()
    lookups.ensure('schools', 'classes').catch((err: unknown) => {
      ElMessage.error(errorMessage(err, '無法載入學校與班級選項'))
    })
  },
  { immediate: true },
)

/** 選單只列目前學年度的班級；編輯時學生所在班級不在其中（例如舊學年度）也要列出 */
const classOptions = computed<LookupOption[]>(() => {
  const options = lookups.classOptions(academicYear)
  const current = props.student?.class
  if (current && !options.some((o) => o.value === current.id)) options.push({ label: current.name, value: current.id })
  return options
})

const schoolOptions = computed<LookupOption[]>(() => {
  const options = [...lookups.schoolOptions]
  const current = props.student?.school
  if (current && !options.some((o) => o.value === current.id)) {
    options.push({ label: current.short_name || current.name, value: current.id })
  }
  return options
})

const visibleKeys = computed<Set<FieldKey>>(() => {
  const keys = new Set<FieldKey>(FIELD_KEYS)
  if (form.status !== 'withdrawn') keys.delete('withdrawn_on')
  if (!canSensitive.value) {
    keys.delete('id_number')
    keys.delete('health_note')
  }
  return keys
})

function isFutureDate(d: Date): boolean {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` > todayTaipei()
}

function onIdNumberInput(value: string): void {
  form.id_number = value.toUpperCase()
  errors.id_number = ''
}

function idNumberError(): string {
  if (!canSensitive.value || form.clear_id_number) return ''
  const value = form.id_number.trim()
  return value && !ID_NUMBER_RE.test(value) ? '身分證字號格式不正確' : ''
}

function validateIdNumber(): void {
  errors.id_number = idNumberError()
}

function onClearIdNumber(): void {
  errors.id_number = ''
}

function validate(): boolean {
  clearErrors()
  if (!form.student_no.trim()) errors.student_no = '請輸入學號'
  if (!form.name.trim()) errors.name = '請輸入姓名'
  if (form.grade_level === null) errors.grade_level = '請選擇年級'
  if (form.birthday && form.birthday > todayTaipei()) errors.birthday = '生日不可晚於今天'
  if (form.status === 'withdrawn' && !form.withdrawn_on) errors.withdrawn_on = '請選擇退班日'
  errors.id_number = idNumberError()
  return FIELD_KEYS.every((key) => !errors[key])
}

function basicBody(): BasicBody {
  return {
    student_no: form.student_no.trim(),
    name: form.name.trim(),
    gender: form.gender || null,
    birthday: form.birthday || null,
    grade_level: form.grade_level ?? 0,
    school_id: form.school_id || null,
    school_class: form.school_class.trim() || null,
    class_id: form.class_id || null,
    status: form.status,
    enrolled_on: form.enrolled_on || null,
    withdrawn_on: form.status === 'withdrawn' ? form.withdrawn_on || null : null,
    note: form.note.trim() || null,
  }
}

function originalBody(s: StudentDetail): BasicBody {
  return {
    student_no: s.student_no,
    name: s.name,
    gender: s.gender,
    birthday: s.birthday,
    grade_level: s.grade_level,
    school_id: s.school?.id ?? null,
    school_class: s.school_class || null,
    class_id: s.class?.id ?? null,
    status: s.status,
    enrolled_on: s.enrolled_on,
    withdrawn_on: s.withdrawn_on,
    note: s.note || null,
  }
}

function createBody(): StudentCreate {
  const body: StudentCreate = basicBody()
  if (canSensitive.value) {
    const idNumber = form.id_number.trim()
    const healthNote = form.health_note.trim()
    if (idNumber) body.id_number = idNumber
    if (healthNote) body.health_note = healthNote
  }
  return body
}

function updateBody(s: StudentDetail): StudentUpdate {
  const next = basicBody()
  const original = originalBody(s)
  const body: StudentUpdate = {}
  for (const key of Object.keys(next) as (keyof BasicBody)[]) {
    if (next[key] !== original[key]) Object.assign(body, { [key]: next[key] })
  }
  if (canSensitive.value) {
    const idNumber = form.id_number.trim()
    const healthNote = form.health_note.trim()
    if (form.clear_id_number) body.id_number = null
    else if (idNumber) body.id_number = idNumber
    if (form.clear_health_note) body.health_note = null
    else if (healthNote) body.health_note = healthNote
  }
  return body
}

/** 編輯時由在學改為暫停 / 退班，或由暫停改為退班 */
function isDeactivating(s: StudentDetail): boolean {
  const from = s.status
  const to = form.status
  return from !== to && (to === 'withdrawn' || (to === 'suspended' && from === 'active'))
}

async function confirmStatusChange(s: StudentDetail): Promise<boolean> {
  try {
    await ElMessageBox.confirm(STATUS_CONFIRM_TEXT, `確認將 ${s.name} 改為${STUDENT_STATUS_META[form.status].label}`, {
      type: 'warning',
      confirmButtonText: '確定儲存',
      cancelButtonText: '取消',
    })
    return true
  } catch {
    return false
  }
}

function showError(err: unknown): void {
  const code = errorCode(err)
  if (code === 'student_no_taken') {
    errors.student_no = '學號已被使用'
    return
  }
  if (code === 'id_number_duplicate' && canSensitive.value) {
    errors.id_number = '此身分證字號已有學生使用'
    return
  }
  if (code === 'invalid_dates' && form.status === 'withdrawn') {
    errors.withdrawn_on = errorMessage(err, '日期不正確')
    return
  }
  const fieldErrors = validationFieldErrors(err)
  const mapped = FIELD_KEYS.filter((key) => fieldErrors[key] && visibleKeys.value.has(key))
  for (const key of mapped) errors[key] = fieldErrors[key]!
  if (!mapped.length) ElMessage.error(errorMessage(err, '儲存失敗，請稍後再試'))
}

async function submit(): Promise<void> {
  if (loading.value || !validate()) return
  const s = props.student
  const body = s ? updateBody(s) : createBody()
  if (s && Object.keys(body).length === 0) {
    emit('update:modelValue', false)
    return
  }
  if (s && isDeactivating(s) && !(await confirmStatusChange(s))) return
  loading.value = true
  try {
    const saved = s ? await updateStudent(s.id, body) : await createStudent(body as StudentCreate)
    ElMessage.success('已儲存')
    emit('saved', saved)
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
    :title="student ? '編輯學生' : '新增學生'"
    size="lg"
    :loading="loading"
    :dirty="isDirty"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
  >
    <el-form
      class="sf-form"
      label-position="top"
      :disabled="loading"
      @submit.prevent
    >
      <div class="form-section">
        基本資料
      </div>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item
            label="學號"
            required
            :error="errors.student_no"
          >
            <el-input
              v-model="form.student_no"
              maxlength="20"
              placeholder="例如：S11309"
              @input="errors.student_no = ''"
            />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item
            label="姓名"
            required
            :error="errors.name"
          >
            <el-input
              v-model="form.name"
              maxlength="30"
              @input="errors.name = ''"
            />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item
            label="性別"
            :error="errors.gender"
          >
            <el-select
              v-model="form.gender"
              clearable
              placeholder="未填"
              @change="errors.gender = ''"
            >
              <el-option
                v-for="g in GENDERS"
                :key="g"
                :label="GENDER_LABELS[g]"
                :value="g"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item
            label="生日"
            :error="errors.birthday"
          >
            <el-date-picker
              v-model="form.birthday"
              class="sf-date"
              type="date"
              value-format="YYYY-MM-DD"
              format="YYYY/MM/DD"
              placeholder="選擇日期"
              :disabled-date="isFutureDate"
              @change="errors.birthday = ''"
            />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item
            label="年級"
            required
            :error="errors.grade_level"
          >
            <el-select
              v-model="form.grade_level"
              placeholder="選擇年級"
              @change="errors.grade_level = ''"
            >
              <el-option
                v-for="g in GRADE_OPTIONS"
                :key="g.value"
                :label="g.label"
                :value="g.value"
              />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <div class="form-section">
        就讀
      </div>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item
            label="就讀國小"
            :error="errors.school_id"
          >
            <el-select
              v-model="form.school_id"
              clearable
              placeholder="未填"
              @change="errors.school_id = ''"
            >
              <el-option
                v-for="o in schoolOptions"
                :key="o.value"
                :label="o.label"
                :value="o.value"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item
            label="學校班級"
            :error="errors.school_class"
          >
            <el-input
              v-model="form.school_class"
              maxlength="20"
              placeholder="例如：三年二班"
              @input="errors.school_class = ''"
            />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item
            :label="`安親班班級（${academicYear} 學年度）`"
            :error="errors.class_id"
          >
            <el-select
              v-model="form.class_id"
              clearable
              placeholder="未分班"
              @change="errors.class_id = ''"
            >
              <el-option
                v-for="o in classOptions"
                :key="o.value"
                :label="o.label"
                :value="o.value"
              />
            </el-select>
          </el-form-item>
        </el-col>
      </el-row>

      <div class="form-section">
        狀態
      </div>
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item
            label="狀態"
            :error="errors.status"
          >
            <el-select
              v-model="form.status"
              @change="errors.status = ''"
            >
              <el-option
                v-for="st in STUDENT_STATUSES"
                :key="st"
                :label="STUDENT_STATUS_META[st].label"
                :value="st"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item
            label="入學日"
            :error="errors.enrolled_on"
          >
            <el-date-picker
              v-model="form.enrolled_on"
              class="sf-date"
              type="date"
              value-format="YYYY-MM-DD"
              format="YYYY/MM/DD"
              placeholder="選擇日期"
              @change="errors.enrolled_on = ''"
            />
          </el-form-item>
        </el-col>
        <el-col
          v-if="form.status === 'withdrawn'"
          :span="8"
        >
          <el-form-item
            label="退班日"
            required
            :error="errors.withdrawn_on"
          >
            <el-date-picker
              v-model="form.withdrawn_on"
              class="sf-date"
              type="date"
              value-format="YYYY-MM-DD"
              format="YYYY/MM/DD"
              placeholder="選擇日期"
              @change="errors.withdrawn_on = ''"
            />
          </el-form-item>
        </el-col>
        <el-col :span="24">
          <el-form-item
            label="備註"
            :error="errors.note"
          >
            <el-input
              v-model="form.note"
              type="textarea"
              :rows="2"
              maxlength="500"
              @input="errors.note = ''"
            />
          </el-form-item>
        </el-col>
      </el-row>

      <template v-if="canSensitive">
        <div class="form-section">
          <el-icon class="form-section__icon">
            <Lock />
          </el-icon>敏感資料（只有具敏感資料權限的人看得到這一段）
        </div>
        <el-row :gutter="16">
          <el-col :span="12">
            <el-form-item
              label="身分證字號"
              :error="errors.id_number"
            >
              <el-input
                :model-value="form.id_number"
                maxlength="10"
                :placeholder="student ? '留空表示不變更' : '選填'"
                :disabled="form.clear_id_number"
                @update:model-value="onIdNumberInput"
                @blur="validateIdNumber"
              />
              <div
                v-if="student?.has_id_number"
                class="field-row"
              >
                <el-tag
                  size="small"
                  type="info"
                  disable-transitions
                >
                  目前已填寫
                </el-tag>
                <el-checkbox
                  v-model="form.clear_id_number"
                  @change="onClearIdNumber"
                >
                  清除已填寫的資料
                </el-checkbox>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item
              label="健康備註"
              :error="errors.health_note"
            >
              <el-input
                v-model="form.health_note"
                type="textarea"
                :rows="2"
                maxlength="500"
                show-word-limit
                :placeholder="student ? '留空表示不變更' : '例如：過敏、慢性病、用藥'"
                :disabled="form.clear_health_note"
                @input="errors.health_note = ''"
              />
              <div
                v-if="student?.has_health_note"
                class="field-row"
              >
                <el-tag
                  size="small"
                  type="info"
                  disable-transitions
                >
                  目前已填寫
                </el-tag>
                <el-checkbox v-model="form.clear_health_note">
                  清除已填寫的資料
                </el-checkbox>
              </div>
            </el-form-item>
          </el-col>
        </el-row>
      </template>
    </el-form>
  </FormDialog>
</template>

<style scoped>
/* el-row 的 gutter 以負邊距實作，會讓 dialog body 多出 8px 橫向捲動（手機滿版時 body 可捲動）；只裁切橫向 */
.sf-form {
  overflow-x: clip;
}

.form-section {
  display: flex;
  gap: 4px;
  align-items: center;
  padding-bottom: 4px;
  margin: 4px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  width: 100%;
  margin-top: 4px;
}

.el-select,
.sf-date,
.sf-date :deep(.el-input__wrapper) {
  width: 100%;
}

:deep(.el-date-editor.sf-date) {
  width: 100%;
}
</style>
