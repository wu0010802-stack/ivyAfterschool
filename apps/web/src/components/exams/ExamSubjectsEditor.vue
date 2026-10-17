<script setup lang="ts">
// FRONTEND-233：考試科目與滿分設定（PUT /admin/exams/{id}/subjects 整批取代；移除科目會刪除該科成績，BACKEND-472）。
// 設計稿：docs/mockups/page-exam-detail.html（科目設定分頁）。
// - 草稿且有 exams:write 才可編輯；已發布或唯讀身分顯示唯讀表。
// - 科目 1~20：空清單不可儲存，已有 20 列或沒有可再選的科目時「新增科目」停用。
// - 儲存前若移除了已有成績的科目先確認；409 full_score_below_existing 標在該列並附目前最高分、
//   409 exam_published 顯示頂端 alert 並 emit conflict、422 invalid_subject 標出已停用的列。
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { computed, h, reactive, ref, watch } from 'vue'
import { setExamSubjects, type Exam, type ExamSubject, type ExamSubjectInput } from '@/api/exams'
import EmptyState from '@/components/common/EmptyState.vue'
import { useLookupsStore } from '@/stores/lookups'
import { isApiError } from '@/shared/types/api'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'
import { isValidFullScore, MAX_FULL_SCORE } from '@/utils/examScore'

const props = defineProps<{
  exam: Exam
  /** subject_id → 已輸入分數數（取自 summary 的 scored_count） */
  scoredCounts: Record<string, number>
  canWrite: boolean
}>()

const emit = defineEmits<{
  saved: [exam: Exam]
  /** 409 exam_published：由 view 重新載入考試 */
  conflict: []
}>()

const MAX_SUBJECTS = 20
const DEFAULT_FULL_SCORE = 100

interface Row {
  key: number
  subject_id: string | null
  full_score: number | null
}

interface RowError {
  field: 'subject' | 'full'
  message: string
}

const lookups = useLookupsStore()

let seq = 0
function toRows(subjects: ExamSubject[]): Row[] {
  return subjects.map((s) => ({ key: seq++, subject_id: s.subject_id, full_score: s.full_score }))
}
function snapshot(rows: Row[]): string {
  return JSON.stringify(rows.map((r) => [r.subject_id, r.full_score]))
}

const rows = ref<Row[]>(toRows(props.exam.subjects))
const baseline = ref(snapshot(rows.value))
const rowErrors = reactive<Record<number, RowError>>({})
const alertMsg = ref('')
const saving = ref(false)

const readonly = computed(() => props.exam.status === 'published' || !props.canWrite)
const dirty = computed(() => snapshot(rows.value) !== baseline.value)
const hadSubjects = computed(() => props.exam.subjects.length > 0)

function clearErrors(): void {
  for (const key of Object.keys(rowErrors)) delete rowErrors[Number(key)]
  alertMsg.value = ''
}

function reset(): void {
  rows.value = toRows(props.exam.subjects)
  baseline.value = snapshot(rows.value)
  clearErrors()
}

watch(() => props.exam.subjects, reset, { deep: true })

watch(
  readonly,
  (ro) => {
    if (ro) return
    lookups.ensure('subjects').catch(() => {
      // 清單載入失敗時下拉只剩既有科目，仍可調整滿分與順序
    })
  },
  { immediate: true },
)

const subjectOptions = computed(() => lookups.subjectOptions)

function nameOf(id: string | null): string {
  if (!id) return ''
  return (
    subjectOptions.value.find((o) => o.value === id)?.label ??
    props.exam.subjects.find((s) => s.subject_id === id)?.subject_name ??
    id
  )
}

function missingFromOptions(id: string): boolean {
  return !subjectOptions.value.some((o) => o.value === id)
}

/** 科目清單已載入卻找不到：在參考資料被停用 */
function isInactive(id: string | null): boolean {
  return !!id && lookups.subjectsLoaded && missingFromOptions(id)
}

function takenBy(id: string, row: Row): boolean {
  return rows.value.some((r) => r !== row && r.subject_id === id)
}

const canAdd = computed(() => {
  if (saving.value || rows.value.length >= MAX_SUBJECTS) return false
  const unused = subjectOptions.value.filter((o) => !rows.value.some((r) => r.subject_id === o.value)).length
  return rows.value.filter((r) => !r.subject_id).length < unused
})

function countText(id: string | null): string {
  const n = id ? (props.scoredCounts[id] ?? 0) : 0
  return n ? `${n} 筆` : '—'
}

function clearRowError(row: Row): void {
  delete rowErrors[row.key]
  alertMsg.value = ''
}

function move(index: number, delta: number): void {
  const next = [...rows.value]
  const [row] = next.splice(index, 1)
  next.splice(index + delta, 0, row!)
  rows.value = next
}

function addRow(): void {
  rows.value = [...rows.value, { key: seq++, subject_id: null, full_score: DEFAULT_FULL_SCORE }]
}

function removeRow(row: Row): void {
  rows.value = rows.value.filter((r) => r !== row)
  delete rowErrors[row.key]
}

function validate(): boolean {
  clearErrors()
  let ok = true
  for (const r of rows.value) {
    if (!r.subject_id) {
      rowErrors[r.key] = { field: 'subject', message: '請選擇科目' }
      ok = false
    } else if (!isValidFullScore(r.full_score)) {
      rowErrors[r.key] = { field: 'full', message: '請輸入滿分（大於 0、最多 1000、最多兩位小數）' }
      ok = false
    }
  }
  return ok
}

/** 移除了已有成績的科目時先確認；回 false 表示取消 */
async function confirmRemovals(): Promise<boolean> {
  const removed = props.exam.subjects.filter(
    (s) => !rows.value.some((r) => r.subject_id === s.subject_id) && (props.scoredCounts[s.subject_id] ?? 0) > 0,
  )
  if (!removed.length) return true
  try {
    await ElMessageBox.confirm(
      h(
        'div',
        removed.map((s) =>
          h(
            'p',
            { style: 'margin: 0 0 4px' },
            `移除「${s.subject_name}」會刪除已輸入的 ${props.scoredCounts[s.subject_id]} 筆成績，確定嗎？`,
          ),
        ),
      ),
      '移除科目',
      { type: 'warning', confirmButtonText: '移除並儲存', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false
  }
}

function detailsOf(err: unknown): Record<string, unknown> {
  const details = isApiError(err) ? err.details : null
  return details !== null && typeof details === 'object' ? (details as Record<string, unknown>) : {}
}

function markRowsBySubject(ids: string[], error: RowError): void {
  for (const r of rows.value) {
    if (r.subject_id && ids.includes(r.subject_id)) rowErrors[r.key] = error
  }
}

function applyError(err: unknown): void {
  const code = errorCode(err)
  const details = detailsOf(err)
  if (code === 'full_score_below_existing') {
    const maxScore = details.max_score
    markRowsBySubject([String(details.subject_id ?? '')], {
      field: 'full',
      message: `滿分不可低於已輸入的最高分（目前最高 ${typeof maxScore === 'number' ? maxScore : '—'} 分）`,
    })
    return
  }
  if (code === 'exam_published') {
    alertMsg.value = errorMessage(err, '考試已發布，請先取消發布再修改')
    emit('conflict')
    return
  }
  if (code === 'invalid_subject') {
    alertMsg.value = errorMessage(err, '科目不存在或已停用')
    const ids = Array.isArray(details.subject_ids) ? details.subject_ids.map(String) : []
    markRowsBySubject(ids, {
      field: 'subject',
      message: '此科目已在參考資料停用，移除後才能儲存（會一併刪除該科成績）',
    })
    return
  }
  ElMessage.error(errorMessage(err, '儲存失敗，請稍後再試'))
}

async function save(): Promise<void> {
  if (!dirty.value || !rows.value.length || saving.value) return
  if (!validate()) return
  if (!(await confirmRemovals())) return
  const items: ExamSubjectInput[] = rows.value.map((r, i) => ({
    subject_id: r.subject_id as string,
    full_score: r.full_score as number,
    sort_order: i + 1,
  }))
  saving.value = true
  try {
    const exam = await setExamSubjects(props.exam.id, items)
    baseline.value = snapshot(rows.value)
    ElMessage.success('已儲存科目設定')
    emit('saved', exam)
  } catch (err) {
    applyError(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="subj">
    <el-alert
      v-if="exam.status === 'published'"
      class="subj__alert"
      type="info"
      :closable="false"
      show-icon
      title="已發布的考試不可修改科目"
    />
    <el-alert
      v-if="alertMsg"
      class="subj__alert"
      type="error"
      show-icon
      :title="alertMsg"
      @close="alertMsg = ''"
    />
    <template v-if="readonly">
      <EmptyState
        v-if="!exam.subjects.length"
        variant="inline"
        title="尚未設定科目"
      />
      <el-table
        v-else
        :data="exam.subjects"
        border
        class="subj__table"
      >
        <el-table-column
          label="順序"
          width="70"
          align="center"
        >
          <template #default="{ $index }: { $index: number }">
            {{ $index + 1 }}
          </template>
        </el-table-column>
        <el-table-column
          prop="subject_name"
          label="科目"
          min-width="140"
        />
        <!-- @vue-generic {ExamSubject} -->
        <el-table-column
          label="滿分"
          width="100"
          align="right"
        >
          <template #default="{ row }: { row: ExamSubject }">
            {{ row.full_score }}
          </template>
        </el-table-column>
        <!-- @vue-generic {ExamSubject} -->
        <el-table-column
          label="已輸入成績"
          width="120"
          align="right"
        >
          <template #default="{ row }: { row: ExamSubject }">
            {{ countText(row.subject_id) }}
          </template>
        </el-table-column>
      </el-table>
    </template>
    <template v-else>
      <p class="subj__hint">
        科目順序就是成績表與家長端的顯示順序；移除科目會一併刪除該科已輸入的成績。
      </p>
      <div
        v-if="rows.length"
        class="subj-head"
      >
        <span>順序</span><span>科目</span><span>滿分</span><span>已輸入成績</span><span />
      </div>
      <div
        v-for="(row, i) in rows"
        :key="row.key"
        class="subj-row"
        :class="rowErrors[row.key] ? `is-error-${rowErrors[row.key]!.field}` : ''"
      >
        <span class="subj-row__no">{{ i + 1 }}</span>
        <span class="subj-row__subject">
          <el-select
            v-model="row.subject_id"
            placeholder="選擇科目"
            :disabled="saving"
            :aria-label="`第 ${i + 1} 個科目`"
            @change="clearRowError(row)"
          >
            <el-option
              v-if="row.subject_id && missingFromOptions(row.subject_id)"
              :label="nameOf(row.subject_id) + (isInactive(row.subject_id) ? '（已停用）' : '')"
              :value="row.subject_id"
              disabled
            />
            <el-option
              v-for="o in subjectOptions"
              :key="o.value"
              :label="o.label"
              :value="o.value"
              :disabled="takenBy(o.value, row)"
            />
          </el-select>
          <el-tag
            v-if="isInactive(row.subject_id)"
            size="small"
            type="danger"
            effect="plain"
            disable-transitions
          >
            已停用
          </el-tag>
        </span>
        <el-input-number
          v-model="row.full_score"
          :min="0.01"
          :max="MAX_FULL_SCORE"
          :step="1"
          controls-position="right"
          :disabled="saving"
          :aria-label="`${nameOf(row.subject_id) || '科目'} 滿分`"
          @change="clearRowError(row)"
        />
        <span class="subj-row__count">{{ countText(row.subject_id) }}</span>
        <span class="subj-row__ops">
          <el-button
            text
            :disabled="i === 0 || saving"
            @click="move(i, -1)"
          >
            上移
          </el-button>
          <el-button
            text
            :disabled="i === rows.length - 1 || saving"
            @click="move(i, 1)"
          >
            下移
          </el-button>
          <el-button
            text
            type="danger"
            :disabled="saving"
            @click="removeRow(row)"
          >
            移除
          </el-button>
        </span>
        <div
          v-if="rowErrors[row.key]"
          class="subj-row__error"
        >
          {{ rowErrors[row.key]!.message }}
        </div>
      </div>
      <div
        v-if="!rows.length"
        class="subj-empty"
      >
        {{ hadSubjects ? '考試至少要有一個科目：請新增科目，或按「還原變更」' : '尚未設定科目，請新增後才能輸入成績' }}
      </div>
      <div class="subj-foot">
        <el-button
          class="touch"
          :disabled="!canAdd"
          @click="addRow"
        >
          <el-icon><Plus /></el-icon>新增科目
        </el-button>
        <span class="subj-foot__count">{{ rows.length }} / {{ MAX_SUBJECTS }}</span>
        <span class="subj-foot__spacer" />
        <el-button
          v-if="dirty"
          class="touch"
          text
          :disabled="saving"
          @click="reset"
        >
          還原變更
        </el-button>
        <el-button
          type="primary"
          class="touch"
          :loading="saving"
          :disabled="!dirty || !rows.length"
          @click="save"
        >
          儲存
        </el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.subj {
  max-width: 860px;
}

.subj__alert {
  margin-bottom: 12px;
}

.subj__hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.subj__table {
  max-width: 560px;
}

.subj-head,
.subj-row {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 150px 96px 196px;
  gap: 8px;
  align-items: center;
}

.subj-head {
  padding: 0 0 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.subj-head span:nth-child(4) {
  text-align: right;
}

.subj-row {
  min-height: 52px;
  padding: 4px 0;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.subj-row__no {
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.subj-row__subject {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.subj-row__subject :deep(.el-select) {
  flex: 1;
  min-width: 0;
}

.subj-row :deep(.el-input-number) {
  width: 100%;
}

.subj-row__count {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  text-align: right;
}

.subj-row__ops {
  display: flex;
  justify-content: flex-end;
}

/* 文字按鈕 44px 高（平板） */
.subj-row__ops :deep(.el-button) {
  min-height: 44px;
  padding: 0 10px;
  margin-left: 0;
}

.subj-row.is-error-subject :deep(.el-select__wrapper),
.subj-row.is-error-full :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.subj-row__error {
  grid-column: 2 / -1;
  margin-top: -2px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.subj-empty {
  padding: 16px 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.subj-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.subj-foot__count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.subj-foot__spacer {
  flex: 1;
}

.touch.el-button {
  min-height: 44px;
}
</style>
