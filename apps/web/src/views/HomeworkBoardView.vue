<script setup lang="ts">
// FRONTEND-151：作業進度看板（/homework，homework:read，meta.tablet）。設計稿：docs/mockups/page-homework-board.html。
// 新做（ivy 無對應頁）。資料、項目與整體進度的異動、樂觀更新與 ws 合併由 useHomeworkBoard（FRONTEND-152）負責；
// 本頁處理篩選、卡片分組、dialog 與卡片事件的對應。
// - 班級存在 route.query.class_id（後端篩選）；「隱藏請假 / 缺席 / 已離班」（預設開，存 localStorage）、摘要 StatCard、搜尋只做前端過濾。
// - 日期可選範圍取自看板回應的 window（今天 −past_days ~ +future_days），首次載入前以 30 / 7 顯示；範圍外的輸入不切換。
// - 卡片依班級（沿用後端的班級順序）、學號排序；全部班級時依班級分組並加「{班級}（人數）」小標。
// - 同一時間只開一個 dialog；送出中 loading，失敗把訊息傳給 dialog 的 error、保持開啟。
import { Plus, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import type { BoardStudent, HomeworkItem, HomeworkWindow } from '@/api/homework'
import EmptyState from '@/components/common/EmptyState.vue'
import StatCard from '@/components/common/StatCard.vue'
import HomeworkBatchAddDialog from '@/components/homework/HomeworkBatchAddDialog.vue'
import HomeworkItemDialog from '@/components/homework/HomeworkItemDialog.vue'
import HomeworkStudentCard from '@/components/homework/HomeworkStudentCard.vue'
import ReadyEtaDialog from '@/components/homework/ReadyEtaDialog.vue'
import { useConfirmDelete } from '@/composables/useConfirmDelete'
import { useHomeworkBoard } from '@/composables/useHomeworkBoard'
import type { Tone } from '@/shared/constants/statusLabels'
import type { HomeworkItemStatus, HomeworkOverallStatus, ISODate } from '@/shared/types/api'
import { addDays, todayTaipei } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'
import { useLookupsStore } from '@/stores/lookups'
import { currentAcademicYear } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

type SummaryKey = 'all' | HomeworkOverallStatus
type DialogKind = 'item' | 'eta' | 'batch'

interface ClassGroup {
  key: string
  name: string
  students: BoardStudent[]
}

const HIDE_AWAY_KEY = 'homework.hideAway'
/** 「隱藏請假 / 缺席 / 已離班」隱藏的出勤狀態 */
const AWAY_STATUSES: ReadonlySet<string> = new Set(['leave', 'absent', 'left'])
/** 首次載入前的日期範圍（與後端 homework.window 預設一致） */
const DEFAULT_WINDOW: HomeworkWindow = { past_days: 30, future_days: 7 }

const SUMMARY_CARDS: { key: SummaryKey; label: string; tone: Tone }[] = [
  { key: 'all', label: '全部', tone: 'info' },
  { key: 'done', label: '已完成', tone: 'success' },
  { key: 'in_progress', label: '進行中', tone: 'warning' },
  { key: 'not_started', label: '尚未開始', tone: 'info' },
]

const route = useRoute()
const router = useRouter()
const lookups = useLookupsStore()
const { can } = usePermission()

const today = todayTaipei()
const academicYear = currentAcademicYear()

lookups.ensure('classes').catch(() => {
  // 班級清單載入失敗時下拉是空的，仍可看全部班級
})
const classOptions = computed(() => lookups.classOptions(academicYear))

// ---- 篩選 ----
const date = ref<ISODate>(today)
const classId = computed<string | null>(() => {
  const value = route.query.class_id
  return typeof value === 'string' && value !== '' ? value : null
})
const classSelection = computed<string>({
  get: () => classId.value ?? '',
  set: (value: string | undefined) => {
    const query: LocationQueryRaw = { ...route.query }
    if (value) query.class_id = value
    else delete query.class_id
    void router.replace({ query })
  },
})

function readHideAway(): boolean {
  try {
    return localStorage.getItem(HIDE_AWAY_KEY) !== 'false'
  } catch {
    return true
  }
}

const hideAway = ref(readHideAway())
watch(hideAway, (value) => {
  try {
    localStorage.setItem(HIDE_AWAY_KEY, String(value))
  } catch {
    // 偏好存不下來只影響下次開啟
  }
})
const keyword = ref('')
const summaryFilter = ref<SummaryKey>('all')

const isToday = computed(() => date.value === today)
const canWrite = computed(() => can('homework:write'))

// ---- 資料 ----
const hw = useHomeworkBoard({ date, classId })
const { board, loading, error, summary, pendingItemIds, wsDenied } = hw

const homeworkWindow = computed<HomeworkWindow>(() => board.value?.window ?? DEFAULT_WINDOW)
const minDate = computed(() => addDays(today, -homeworkWindow.value.past_days))
const maxDate = computed(() => addDays(today, homeworkWindow.value.future_days))

function localIsoDate(d: Date): ISODate {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function outOfRange(d: Date): boolean {
  const iso = localIsoDate(d)
  return iso < minDate.value || iso > maxDate.value
}

function onDateChange(value: ISODate | null): void {
  if (value && value >= minDate.value && value <= maxDate.value) date.value = value
}

const students = computed<BoardStudent[]>(() => board.value?.students ?? [])
const initialLoading = computed(() => loading.value && board.value === null)
const loadFailed = computed(() => !loading.value && board.value === null && error.value !== null)

const visibleStudents = computed<BoardStudent[]>(() => {
  const q = keyword.value.trim().toLowerCase()
  return students.value.filter(
    (s) =>
      !(hideAway.value && s.attendance_status && AWAY_STATUSES.has(s.attendance_status)) &&
      (summaryFilter.value === 'all' || s.progress.overall_status === summaryFilter.value) &&
      (!q || s.name.toLowerCase().includes(q) || s.student_no.toLowerCase().includes(q)),
  )
})

/** 依班級分組（沿用後端的班級順序），組內依學號 */
const groups = computed<ClassGroup[]>(() => {
  const map = new Map<string, ClassGroup>()
  for (const s of visibleStudents.value) {
    const key = s.class_id ?? ''
    let group = map.get(key)
    if (!group) {
      group = { key, name: s.class_name ?? '未分班', students: [] }
      map.set(key, group)
    }
    group.students.push(s)
  }
  for (const g of map.values()) {
    g.students.sort((a, b) => (a.student_no < b.student_no ? -1 : a.student_no > b.student_no ? 1 : 0))
  }
  return [...map.values()]
})

const selectedClassName = computed(() => {
  const id = classId.value
  if (!id) return ''
  return (
    students.value.find((s) => s.class_id === id)?.class_name ??
    classOptions.value.find((o) => o.value === id)?.label ??
    ''
  )
})

const summaryCards = computed(() =>
  SUMMARY_CARDS.map((c) => ({ ...c, value: c.key === 'all' ? summary.value.total : summary.value[c.key] })),
)

function toggleSummary(key: SummaryKey): void {
  summaryFilter.value = summaryFilter.value === key || key === 'all' ? 'all' : key
}

function clearFilters(): void {
  keyword.value = ''
  summaryFilter.value = 'all'
  hideAway.value = false
}

// 換日期或班級：清掉摘要篩選
watch([date, classId], () => {
  summaryFilter.value = 'all'
})

// ---- dialog（同一時間只開一個） ----
const activeDialog = ref<DialogKind | null>(null)
const dialogSaving = ref(false)
const dialogError = ref<string | null>(null)
const targetStudent = shallowRef<BoardStudent | null>(null)
const targetItem = shallowRef<HomeworkItem | null>(null)

function openDialog(kind: DialogKind, student: BoardStudent | null, item: HomeworkItem | null = null): void {
  if (activeDialog.value) return
  targetStudent.value = student
  targetItem.value = item
  dialogError.value = null
  activeDialog.value = kind
}

function onDialogModel(kind: DialogKind, open: boolean): void {
  if (!open && activeDialog.value === kind) activeDialog.value = null
}

async function saveDialog(run: () => Promise<void>, fallback: string): Promise<void> {
  if (dialogSaving.value) return
  dialogSaving.value = true
  dialogError.value = null
  try {
    await run()
    activeDialog.value = null
  } catch (err) {
    dialogError.value = errorMessage(err, fallback)
  } finally {
    dialogSaving.value = false
  }
}

// 預計可接送時間
function openEta(student: BoardStudent): void {
  openDialog('eta', student)
}

function submitEta(body: { ready_eta: string | null; note: string | null }): void {
  const student = targetStudent.value
  if (!student) return
  void saveDialog(() => hw.setProgress(student.student_id, body), '儲存預計可接送時間失敗')
}

// 新增 / 編輯單項
function openAddItem(student: BoardStudent): void {
  openDialog('item', student)
}

function openEditItem(item: HomeworkItem): void {
  const student = students.value.find((s) => s.student_id === item.student_id) ?? null
  openDialog('item', student, item)
}

function submitItem(body: { subject_id: string | null; title: string }): void {
  const student = targetStudent.value
  const item = targetItem.value
  if (!student) return
  if (!item) {
    void saveDialog(() => hw.addItem(student.student_id, body), '新增作業失敗')
    return
  }
  const changes: { title?: string; subject_id?: string | null } = {}
  if (body.title !== item.title) changes.title = body.title
  if (body.subject_id !== item.subject_id) changes.subject_id = body.subject_id
  if (Object.keys(changes).length === 0) {
    activeDialog.value = null
    return
  }
  void saveDialog(() => hw.renameItem(item, changes), '更新作業失敗')
}

// 整班新增
const batchStudents = computed(() =>
  students.value
    .filter((s) => s.class_id === classId.value)
    .map((s) => ({ student_id: s.student_id, name: s.name, attendance_status: s.attendance_status })),
)

function openBatch(): void {
  if (classId.value) openDialog('batch', null)
}

function submitBatch(body: { subject_id: string | null; title: string; student_ids?: string[] }): void {
  void saveDialog(async () => {
    const created = await hw.batchAdd(body)
    ElMessage.success(`已新增給 ${created} 位學生`)
  }, '整班新增作業失敗')
}

// ---- 卡片事件 ----
function setStatus(item: HomeworkItem, status: HomeworkItemStatus): void {
  void hw.setItemStatus(item, status)
}

const { confirmDelete } = useConfirmDelete<HomeworkItem>({
  request: (item) => hw.removeItem(item),
  confirmMessage: (item) => `確定要刪除作業「${item.title}」嗎？`,
})

function removeItem(item: HomeworkItem): void {
  void confirmDelete(item)
}

async function setOverall(student: BoardStudent, mode: 'done' | 'auto'): Promise<void> {
  try {
    await hw.setProgress(student.student_id, { overall: mode })
  } catch (err) {
    ElMessage.error(errorMessage(err, '更新整體狀態失敗'))
  }
}
</script>

<template>
  <div class="hw">
    <div class="hw-toolbar">
      <el-date-picker
        :model-value="date"
        class="hw-toolbar__date"
        type="date"
        value-format="YYYY-MM-DD"
        format="YYYY/MM/DD"
        aria-label="日期"
        :clearable="false"
        :disabled-date="outOfRange"
        @update:model-value="onDateChange"
      />
      <el-select
        v-model="classSelection"
        class="hw-toolbar__class"
        placeholder="全部班級"
        aria-label="班級"
        clearable
      >
        <el-option
          v-for="o in classOptions"
          :key="o.value"
          :label="o.label"
          :value="o.value"
        />
      </el-select>
      <label class="hw-toolbar__switch">
        <el-switch v-model="hideAway" />
        隱藏請假 / 缺席 / 已離班
      </label>
      <el-input
        v-model="keyword"
        class="hw-toolbar__search"
        placeholder="搜尋姓名或學號"
        aria-label="搜尋姓名或學號"
        clearable
        :prefix-icon="Search"
      />
      <span class="hw-toolbar__spacer" />
      <el-tooltip
        v-if="canWrite"
        content="請先選擇班級"
        placement="bottom"
        :disabled="!!classId"
      >
        <span>
          <el-button
            type="primary"
            :icon="Plus"
            :disabled="!classId || board === null"
            @click="openBatch"
          >
            整班新增作業
          </el-button>
        </span>
      </el-tooltip>
    </div>

    <el-alert
      v-if="!isToday"
      type="info"
      :closable="false"
      show-icon
      :title="`檢視 ${date}：可修改作業項目，預計可接送時間只能設定今天`"
    />
    <el-alert
      v-if="wsDenied"
      type="warning"
      :closable="false"
      show-icon
      title="沒有即時更新權限，請手動重新整理"
    >
      <el-button
        size="small"
        @click="hw.reload()"
      >
        重新整理
      </el-button>
    </el-alert>

    <EmptyState
      v-if="loadFailed"
      variant="error"
      title="無法載入作業進度"
      :description="error ?? ''"
    >
      <template #action>
        <el-button @click="hw.reload()">
          重試
        </el-button>
      </template>
    </EmptyState>

    <template v-else>
      <div class="hw-summary">
        <StatCard
          v-for="c in summaryCards"
          :key="c.key"
          :label="c.label"
          :value="c.value"
          :tone="c.tone"
          :loading="initialLoading"
          clickable
          :active="summaryFilter === c.key"
          @click="toggleSummary(c.key)"
        />
      </div>

      <div
        v-if="initialLoading"
        class="hw-grid"
      >
        <div
          v-for="i in 4"
          :key="i"
          class="hw-skeleton"
        >
          <el-skeleton
            :rows="4"
            animated
          />
        </div>
      </div>

      <EmptyState
        v-else-if="students.length === 0"
        :title="classId ? `${selectedClassName} 目前沒有在學學生` : '沒有學生資料'"
      />
      <EmptyState
        v-else-if="groups.length === 0"
        variant="inline"
        title="沒有符合條件的學生"
        description="試著調整搜尋文字、摘要篩選或「隱藏請假 / 缺席 / 已離班」"
      >
        <template #action>
          <el-button
            size="small"
            @click="clearFilters"
          >
            清除篩選
          </el-button>
        </template>
      </EmptyState>

      <template v-else>
        <section
          v-for="g in groups"
          :key="g.key"
        >
          <h3
            v-if="!classId"
            class="hw-group__title"
          >
            {{ g.name }}（{{ g.students.length }}）
          </h3>
          <div class="hw-grid">
            <HomeworkStudentCard
              v-for="s in g.students"
              :key="s.student_id"
              :student="s"
              :can-write="canWrite"
              :is-today="isToday"
              :pending-item-ids="pendingItemIds"
              @set-status="setStatus"
              @add-item="openAddItem"
              @edit-item="openEditItem"
              @remove-item="removeItem"
              @edit-eta="openEta"
              @set-overall="setOverall"
            />
          </div>
        </section>
      </template>
    </template>

    <ReadyEtaDialog
      v-if="targetStudent"
      :model-value="activeDialog === 'eta'"
      :student-name="targetStudent.name"
      :progress="targetStudent.progress"
      :loading="dialogSaving"
      :error="dialogError"
      @update:model-value="onDialogModel('eta', $event)"
      @submit="submitEta"
    />
    <HomeworkItemDialog
      v-if="targetStudent"
      :model-value="activeDialog === 'item'"
      :student-name="targetStudent.name"
      :item="targetItem ?? undefined"
      :loading="dialogSaving"
      :error="dialogError"
      @update:model-value="onDialogModel('item', $event)"
      @submit="submitItem"
    />
    <HomeworkBatchAddDialog
      :model-value="activeDialog === 'batch'"
      :class-name="selectedClassName"
      :students="batchStudents"
      :loading="dialogSaving"
      :error="dialogError"
      @update:model-value="onDialogModel('batch', $event)"
      @submit="submitBatch"
    />
  </div>
</template>

<style scoped>
.hw {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 頂部篩選列：平板觸控，控制項一律 44px 高 */
.hw-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.hw-toolbar :deep(.el-input__wrapper),
.hw-toolbar :deep(.el-select__wrapper) {
  min-height: 44px;
}

.hw-toolbar :deep(.el-button) {
  height: 44px;
}

.hw-toolbar :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* el-date-picker 的根節點不帶本元件的 scoped 屬性，從工具列往下選（稿：190px，平板 1024 寬時篩選列維持單行）；
   根節點高度同 44px，否則 44px 的內層會溢出 Element Plus 預設 32px 的根節點、比同列控制項低 6px */
.hw-toolbar :deep(.hw-toolbar__date.el-date-editor) {
  width: 190px;
  height: 44px;
}

.hw-toolbar__class {
  width: 160px;
}

.hw-toolbar__search {
  width: 180px;
}

.hw-toolbar__switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 4px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
}

.hw-toolbar__spacer {
  flex: 1;
}

.hw-summary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.hw-group__title {
  margin: 4px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.hw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 12px;
}

.hw-skeleton {
  padding: 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}
</style>
