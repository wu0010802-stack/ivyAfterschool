<script setup lang="ts">
// FRONTEND-232：建立 / 編輯考試（domain_spec M8：grade_level 與 class_id 至少一個決定應考名單；已發布只可改 name / exam_date / note）。
// 設計稿：docs/mockups/page-exams.html（ExamFormDialog 段）。
// - 建立：POST /admin/exams（只送有值的欄位）→ 有勾選科目才 PUT subjects（sort_order 依科目順序）；科目那步失敗仍視為已建立。
// - 編輯：只送變更欄位，年級 / 班級清除時送 null；已發布時類型、年級、班級停用；沒有科目區。
// - 422 invalid_exam_type / invalid_class / grade_not_in_class 標在對應欄位；409 exam_published 顯示在頂端 alert、dialog 不關。
import { ElMessage } from 'element-plus'
import { computed, reactive, ref, watch } from 'vue'
import {
  createExam,
  setExamSubjects,
  updateExam,
  type Exam,
  type ExamCreate,
  type ExamSubjectInput,
  type ExamUpdate,
} from '@/api/exams'
import FormDialog from '@/components/common/FormDialog.vue'
import { useFormDirty } from '@/composables/useFormDirty'
import { useLookupsStore, type LookupKind, type LookupOption } from '@/stores/lookups'
import { errorCode, errorMessage, validationFieldErrors } from '@/shared/utils/errorMessage'
import { currentAcademicYear, GRADE_OPTIONS } from '@/utils/academicYear'
import { isValidFullScore, MAX_FULL_SCORE } from '@/utils/examScore'

const props = withDefaults(defineProps<{ modelValue: boolean; exam?: Exam }>(), { exam: undefined })

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [exam: Exam]
}>()

interface FormState {
  name: string
  exam_type_id: string
  exam_date: string
  grade_level: number | null
  class_id: string | null
  note: string
}

interface SubjectRow {
  subject_id: string
  name: string
  on: boolean
  full_score: number | null
}

type FieldKey = keyof FormState
type ErrorKey = FieldKey | 'scope' | 'subjects'

const DEFAULT_FULL_SCORE = 100

/** 後端 422 錯誤碼 → 顯示在哪個欄位（訊息用後端 message） */
const FIELD_BY_CODE: Record<string, FieldKey> = {
  invalid_exam_type: 'exam_type_id',
  invalid_class: 'class_id',
  grade_not_in_class: 'grade_level',
}
const FIELD_KEYS: FieldKey[] = ['name', 'exam_type_id', 'exam_date', 'grade_level', 'class_id', 'note']

const lookups = useLookupsStore()

const isEdit = computed(() => props.exam !== undefined)
const isPublished = computed(() => props.exam?.status === 'published')

function initialForm(): FormState {
  const e = props.exam
  return {
    name: e?.name ?? '',
    exam_type_id: e?.exam_type.id ?? '',
    exam_date: e?.exam_date ?? '',
    grade_level: e?.grade_level ?? null,
    class_id: e?.class?.id ?? null,
    note: e?.note ?? '',
  }
}

const form = reactive<FormState>(initialForm())
const subjects = ref<SubjectRow[]>([])
const errors = reactive<Record<ErrorKey, string>>({
  name: '',
  exam_type_id: '',
  exam_date: '',
  grade_level: '',
  class_id: '',
  note: '',
  scope: '',
  subjects: '',
})
const alertMsg = ref('')
const loading = ref(false)
const { isDirty: formDirty, markClean } = useFormDirty(form)

// 科目列的預設一律「全部勾選、滿分 100」，偏離預設即算變更，不需另存快照
const subjectsDirty = computed(() => subjects.value.some((s) => !s.on || s.full_score !== DEFAULT_FULL_SCORE))
const dirty = computed(() => formDirty.value || subjectsDirty.value)

function clearErrors(): void {
  for (const key of Object.keys(errors) as ErrorKey[]) errors[key] = ''
  alertMsg.value = ''
}

/** 以 lookups 的科目重建列；同科目保留使用者已改的勾選與滿分 */
function syncSubjectRows(): void {
  const prev = new Map(subjects.value.map((s) => [s.subject_id, s]))
  subjects.value = lookups.subjectOptions.map(
    (o) => prev.get(o.value) ?? { subject_id: o.value, name: o.label, on: true, full_score: DEFAULT_FULL_SCORE },
  )
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    Object.assign(form, initialForm())
    subjects.value = []
    if (!isEdit.value) syncSubjectRows()
    clearErrors()
    markClean()
    const kinds: LookupKind[] = isEdit.value ? ['examTypes', 'classes'] : ['examTypes', 'classes', 'subjects']
    lookups.ensure(...kinds).catch(() => {
      // 下拉載入失敗時清單為空，仍可送出；後端會以 422 回報不存在的類型 / 班級
    })
  },
  { immediate: true },
)

watch(
  () => lookups.subjectOptions,
  () => {
    if (props.modelValue && !isEdit.value) syncSubjectRows()
  },
)

/** 編輯舊考試時班級可能不在目前學年度的清單：仍以原班級名稱顯示 */
const classOptions = computed<LookupOption[]>(() => {
  const options = lookups.classOptions(currentAcademicYear())
  const current = props.exam?.class
  if (current && !options.some((o) => o.value === current.id)) {
    return [...options, { label: current.name, value: current.id }]
  }
  return options
})

const scopeChanged = computed(
  () =>
    isEdit.value &&
    !isPublished.value &&
    (form.grade_level !== (props.exam?.grade_level ?? null) || form.class_id !== (props.exam?.class?.id ?? null)),
)
const bothScopes = computed(() => form.grade_level !== null && form.class_id !== null && form.class_id !== '')
const allOn = computed(() => subjects.value.length > 0 && subjects.value.every((s) => s.on))
const someOn = computed(() => subjects.value.some((s) => s.on))

function toggleAll(value: string | number | boolean): void {
  const on = value === true
  for (const s of subjects.value) s.on = on
  errors.subjects = ''
}

function onScopeChange(): void {
  errors.scope = ''
  errors.grade_level = ''
  errors.class_id = ''
}

function validate(): boolean {
  clearErrors()
  if (!form.name.trim()) errors.name = '請輸入考試名稱'
  if (!form.exam_type_id) errors.exam_type_id = '請選擇考試類型'
  if (!form.exam_date) errors.exam_date = '請選擇考試日期'
  if (form.grade_level === null && !form.class_id) errors.scope = '請選擇年級或班級'
  if (subjects.value.some((s) => s.on && !isValidFullScore(s.full_score))) {
    errors.subjects = '請輸入勾選科目的滿分（大於 0、最多 1000、最多兩位小數）'
  }
  return !Object.values(errors).some(Boolean)
}

function createBody(): ExamCreate {
  const body: ExamCreate = { name: form.name.trim(), exam_type_id: form.exam_type_id, exam_date: form.exam_date }
  if (form.grade_level !== null) body.grade_level = form.grade_level
  if (form.class_id) body.class_id = form.class_id
  const note = form.note.trim()
  if (note) body.note = note
  return body
}

/** 編輯只送有變更的欄位；年級 / 班級 / 備註清除時送 null */
function patchBody(): ExamUpdate {
  const base = initialForm()
  const current: FormState = { ...form, name: form.name.trim(), note: form.note.trim() }
  const body: ExamUpdate = {}
  for (const key of FIELD_KEYS) {
    if (current[key] === base[key]) continue
    const value = current[key]
    Object.assign(body, { [key]: value === '' ? null : value })
  }
  return body
}

function subjectItems(): ExamSubjectInput[] {
  return subjects.value
    .filter((s) => s.on)
    .map((s, i) => ({ subject_id: s.subject_id, full_score: s.full_score as number, sort_order: i + 1 }))
}

function finish(exam: Exam): void {
  emit('saved', exam)
  emit('update:modelValue', false)
}

function applyError(err: unknown): void {
  const code = errorCode(err)
  if (code === 'exam_published') {
    alertMsg.value = errorMessage(err, '考試已發布，名單與類型不可修改，請先取消發布')
    return
  }
  const field = code ? FIELD_BY_CODE[code] : undefined
  if (field) {
    errors[field] = errorMessage(err, '欄位值無效')
    return
  }
  const fieldErrors = validationFieldErrors(err)
  const mapped = FIELD_KEYS.filter((key) => fieldErrors[key])
  for (const key of mapped) errors[key] = fieldErrors[key]!
  if (!mapped.length) ElMessage.error(errorMessage(err, '儲存失敗，請稍後再試'))
}

async function submitCreate(): Promise<void> {
  const created = await createExam(createBody())
  const items = subjectItems()
  if (!items.length) {
    ElMessage.success('已建立考試')
    finish(created)
    return
  }
  let result = created
  try {
    result = await setExamSubjects(created.id, items)
  } catch {
    ElMessage.warning('考試已建立，但科目設定失敗，請到「科目設定」分頁重試')
    finish(created)
    return
  }
  ElMessage.success('已建立考試')
  finish(result)
}

async function submitEdit(exam: Exam): Promise<void> {
  const body = patchBody()
  if (Object.keys(body).length === 0) return
  const updated = await updateExam(exam.id, body)
  ElMessage.success('已更新')
  finish(updated)
}

async function submit(): Promise<void> {
  if (!validate()) return
  loading.value = true
  try {
    if (props.exam) await submitEdit(props.exam)
    else await submitCreate()
  } catch (err) {
    applyError(err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="isEdit ? '編輯考試' : '建立考試'"
    size="lg"
    :submit-text="isEdit ? '儲存' : '建立'"
    :loading="loading"
    :dirty="dirty"
    :submit-disabled="isEdit && !dirty"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
  >
    <el-alert
      v-if="isPublished"
      class="ef-alert"
      type="info"
      :closable="false"
      show-icon
      title="已發布的考試只能修改名稱、日期與備註"
    />
    <el-alert
      v-if="alertMsg"
      class="ef-alert"
      type="error"
      show-icon
      :title="alertMsg"
      @close="alertMsg = ''"
    />
    <el-form
      label-position="top"
      :disabled="loading"
      @submit.prevent
    >
      <div class="ef-grid">
        <el-form-item
          label="名稱"
          required
          :error="errors.name"
        >
          <el-input
            v-model="form.name"
            maxlength="50"
            show-word-limit
            placeholder="例如：第一次段考"
            @input="errors.name = ''"
          />
        </el-form-item>
        <el-form-item
          label="考試類型"
          required
          :error="errors.exam_type_id"
        >
          <el-select
            v-model="form.exam_type_id"
            placeholder="選擇類型"
            :disabled="isPublished"
            @change="errors.exam_type_id = ''"
          >
            <el-option
              v-for="t in lookups.examTypeOptions"
              :key="t.value"
              :label="t.label"
              :value="t.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          label="考試日期"
          required
          :error="errors.exam_date"
        >
          <el-date-picker
            v-model="form.exam_date"
            class="ef-date"
            type="date"
            value-format="YYYY-MM-DD"
            format="YYYY/MM/DD"
            placeholder="選擇日期"
            @change="errors.exam_date = ''"
          />
        </el-form-item>
      </div>

      <div class="ef-section">
        <span>應考對象</span><span class="ef-section__required">*</span>
        <span class="ef-section__hint">年級與班級至少選一項，決定應考學生名單</span>
      </div>
      <div
        class="ef-grid ef-grid--2 ef-scope"
        :class="{ 'is-error': !!errors.scope }"
      >
        <el-form-item
          label="年級"
          :error="errors.grade_level"
        >
          <el-select
            v-model="form.grade_level"
            clearable
            placeholder="不限"
            :value-on-clear="() => null"
            :disabled="isPublished"
            @change="onScopeChange"
          >
            <el-option
              v-for="g in GRADE_OPTIONS"
              :key="g.value"
              :label="g.label"
              :value="g.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item
          label="班級"
          :error="errors.class_id"
        >
          <el-select
            v-model="form.class_id"
            clearable
            placeholder="不限"
            :value-on-clear="() => null"
            :disabled="isPublished"
            @change="onScopeChange"
          >
            <el-option
              v-for="c in classOptions"
              :key="c.value"
              :label="c.label"
              :value="c.value"
            />
          </el-select>
        </el-form-item>
      </div>
      <div
        v-if="errors.scope"
        class="ef-scope-msg form-error"
      >
        {{ errors.scope }}
      </div>
      <div
        v-else-if="bothScopes && !errors.grade_level && !errors.class_id"
        class="ef-scope-msg form-hint"
      >
        只包含該班中該年級的學生
      </div>
      <div
        v-if="scopeChanged"
        class="ef-scope-msg form-warn"
      >
        變更應考對象後，已有成績但不在新名單的學生，成績會保留並標示「已不在名單」。
      </div>

      <el-form-item
        label="備註"
        :error="errors.note"
      >
        <el-input
          v-model="form.note"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="例如：範圍 國語第 1~4 課"
          @input="errors.note = ''"
        />
      </el-form-item>

      <template v-if="!isEdit">
        <div class="ef-section">
          <span>科目與滿分</span>
          <span class="ef-section__hint">建立後可在考試頁的「科目設定」分頁調整科目、滿分與順序</span>
          <span class="ef-section__spacer" />
          <el-checkbox
            v-if="subjects.length"
            :model-value="allOn"
            :indeterminate="someOn && !allOn"
            @update:model-value="toggleAll"
          >
            全選
          </el-checkbox>
        </div>
        <div
          v-if="subjects.length"
          class="ef-subjects"
        >
          <div
            v-for="s in subjects"
            :key="s.subject_id"
            class="ef-subject"
            :class="{ 'is-off': !s.on }"
          >
            <el-checkbox
              v-model="s.on"
              @change="errors.subjects = ''"
            >
              {{ s.name }}
            </el-checkbox>
            <span class="ef-subject__full">
              滿分
              <el-input-number
                v-model="s.full_score"
                :min="0.01"
                :max="MAX_FULL_SCORE"
                :step="1"
                controls-position="right"
                :disabled="!s.on"
                :aria-label="`${s.name} 滿分`"
                @change="errors.subjects = ''"
              />
            </span>
          </div>
        </div>
        <p
          v-else
          class="form-hint"
        >
          尚未建立任何科目。可以先建立考試，之後再到考試頁的「科目設定」新增。
        </p>
        <div
          v-if="errors.subjects"
          class="form-error"
        >
          {{ errors.subjects }}
        </div>
      </template>
      <p
        v-else-if="!isPublished"
        class="form-hint"
      >
        科目與滿分請在考試頁的「科目設定」分頁調整。
      </p>
    </el-form>
  </FormDialog>
</template>

<style scoped>
.ef-alert {
  margin-bottom: 16px;
}

.ef-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: 0 16px;
}

.ef-grid--2 {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.ef-grid :deep(.el-select),
.ef-date {
  width: 100%;
}

.ef-section {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 4px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.ef-section__required {
  color: var(--el-color-danger);
}

.ef-section__hint {
  margin-left: 4px;
  font-size: 12px;
  font-weight: normal;
  color: var(--el-text-color-secondary);
}

.ef-section__spacer {
  flex: 1;
}

.ef-scope.is-error :deep(.el-select__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.ef-scope-msg {
  margin: -12px 0 14px;
}

.form-hint,
.form-warn,
.form-error {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.form-hint {
  color: var(--el-text-color-secondary);
}

.form-warn {
  line-height: 1.6;
  color: var(--el-color-warning-dark-2);
}

.form-error {
  color: var(--el-color-danger);
}

.ef-subjects {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px 16px;
  margin-bottom: 4px;
}

/* 每科一個 48px 高的框：勾選框 + 科目名，右側滿分 */
.ef-subject {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 0 8px 0 12px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.ef-subject.is-off {
  background: var(--el-fill-color-lighter);
}

.ef-subject.is-off :deep(.el-checkbox__label) {
  color: var(--el-text-color-secondary);
}

.ef-subject__full {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.ef-subject__full :deep(.el-input-number) {
  width: 120px;
}
</style>
