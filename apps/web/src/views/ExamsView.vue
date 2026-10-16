<script setup lang="ts">
// FRONTEND-231：考試列表（/exams，exams:read）。新做（domain_spec §4 / M8）。設計稿：docs/mockups/page-exams.html。
// - AdminListToolbar：搜尋名稱、狀態 / 類型 / 班級（目前學年度）/ 年級下拉；日期區間放 extra-filters（預設近 90 天到未來 30 天，
//   可清除 = 不限日期）。usePagedList（syncQuery）+ listExams，後端依 exam_date desc 排序，不提供欄位排序。
// - 整列可點進考試頁；名稱是 RouterLink（鍵盤可聚焦、可在新分頁開）。有 exams:write 才有「建立考試」與草稿列的 ⋮ 刪除；
//   列表沒有編輯入口（編輯在考試頁 header「編輯資訊」）。
// - el-table-column 是泛型元件，每欄前的 `@vue-generic {Exam}` 註解讓 slot 的 row 型別為 Exam（vue-tsc 專用）。
import { Delete, MoreFilled, Plus } from '@element-plus/icons-vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { deleteExam, listExams, type Exam, type ExamListParams } from '@/api/exams'
import AdminListToolbar, { type FilterGroup } from '@/components/common/AdminListToolbar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import ExamFormDialog from '@/components/exams/ExamFormDialog.vue'
import { useConfirmDelete } from '@/composables/useConfirmDelete'
import { usePagedList } from '@/composables/usePagedList'
import { PERMISSIONS } from '@/constants/permissions'
import { EXAM_STATUS_META } from '@/shared/constants/statusLabels'
import { EXAM_STATUSES, type ExamStatus } from '@/shared/types/api'
import { addDays, formatDateTime, formatDateWithWeekday, todayTaipei } from '@/shared/utils/datetime'
import { useLookupsStore } from '@/stores/lookups'
import { currentAcademicYear, GRADE_OPTIONS, gradeLabel } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

const PAGE_SIZE = 20
const DEFAULT_PAST_DAYS = 90
const DEFAULT_FUTURE_DAYS = 30

/** 全部以字串存：usePagedList 依初始值型別還原網址 query，空字串 = 不限（送出前會被去掉） */
interface ExamFilters extends Record<string, unknown> {
  q: string
  status: string
  exam_type_id: string
  class_id: string
  grade_level: string
  date_from: string
  date_to: string
}

const router = useRouter()
const lookups = useLookupsStore()
const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.EXAMS_WRITE))

const today = todayTaipei()
const todayYear = today.slice(0, 4)
const academicYear = currentAcademicYear()

function defaultRange(): [string, string] {
  return [addDays(today, -DEFAULT_PAST_DAYS), addDays(today, DEFAULT_FUTURE_DAYS)]
}

function defaultFilters(): ExamFilters {
  const [from, to] = defaultRange()
  return { q: '', status: '', exam_type_id: '', class_id: '', grade_level: '', date_from: from, date_to: to }
}

function isExamStatus(v: string): v is ExamStatus {
  return (EXAM_STATUSES as readonly string[]).includes(v)
}

/** usePagedList 已去掉空值；這裡只負責型別轉換與丟掉網址帶來的無效值 */
function toApiParams(params: ExamFilters & { page: number; page_size: number }): ExamListParams {
  const out: ExamListParams = { page: params.page, page_size: params.page_size }
  if (params.q) out.q = params.q
  if (params.status && isExamStatus(params.status)) out.status = params.status
  if (params.exam_type_id) out.exam_type_id = params.exam_type_id
  if (params.class_id) out.class_id = params.class_id
  const grade = Number(params.grade_level)
  if (params.grade_level && Number.isInteger(grade)) out.grade_level = grade
  if (params.date_from) out.date_from = params.date_from
  if (params.date_to) out.date_to = params.date_to
  return out
}

const list = usePagedList<Exam, ExamFilters>({
  fetch: (params) => listExams(toApiParams(params)),
  initialFilters: defaultFilters(),
  pageSize: PAGE_SIZE,
  syncQuery: true,
})
const { items, total, page, filters, loading, error } = list

lookups.ensure('examTypes', 'classes').catch(() => {
  // 下拉載入失敗時只剩搜尋與日期可用；列表本身不受影響
})

// ---- 工具列 ----
const search = computed({
  get: () => filters.q,
  set: (v: string) => list.setFilters({ q: v }),
})

const toolbarFilters = computed<FilterGroup[]>(() => [
  {
    key: 'status',
    label: '狀態',
    options: EXAM_STATUSES.map((s) => ({ label: EXAM_STATUS_META[s].label, value: s })),
  },
  { key: 'exam_type_id', label: '考試類型', options: lookups.examTypeOptions },
  { key: 'class_id', label: '班級', options: lookups.classOptions(academicYear) },
  { key: 'grade_level', label: '年級', options: GRADE_OPTIONS },
])

/** 下拉的值：undefined = 全部；年級在 filters 存字串，下拉用數字對應 GRADE_OPTIONS */
const toolbarValues = computed<Record<string, unknown>>({
  get: () => ({
    status: filters.status || undefined,
    exam_type_id: filters.exam_type_id || undefined,
    class_id: filters.class_id || undefined,
    grade_level: filters.grade_level ? Number(filters.grade_level) : undefined,
  }),
  set: (v) =>
    list.setFilters({
      status: typeof v.status === 'string' ? v.status : '',
      exam_type_id: typeof v.exam_type_id === 'string' ? v.exam_type_id : '',
      class_id: typeof v.class_id === 'string' ? v.class_id : '',
      grade_level: v.grade_level === undefined || v.grade_level === null ? '' : String(v.grade_level),
    }),
})

const dateRange = computed({
  get: (): [string, string] | null => (filters.date_from && filters.date_to ? [filters.date_from, filters.date_to] : null),
  set: (v: [string, string] | null) => list.setFilters({ date_from: v?.[0] ?? '', date_to: v?.[1] ?? '' }),
})

/** 台北日期 → 本地時區同一天的 00:00（日期選擇器以本地時區格式化 value-format） */
function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function academicYearRange(year: number): [Date, Date] {
  return [localDate(`${year + 1911}-08-01`), localDate(`${year + 1912}-07-31`)]
}

const dateShortcuts = [
  { text: '預設區間', value: () => defaultRange().map(localDate) as [Date, Date] },
  { text: '本學年度', value: () => academicYearRange(academicYear) },
  { text: '上學年度', value: () => academicYearRange(academicYear - 1) },
]

const isDefaultFilters = computed(() => {
  const d = defaultFilters()
  return (Object.keys(d) as (keyof ExamFilters)[]).every((k) => filters[k] === d[k])
})

const toolbarTotal = computed(() => (loading.value || error.value ? undefined : total.value))

// ---- 表格 ----
function examYear(row: Exam): string | null {
  const year = row.exam_date.slice(0, 4)
  return year === todayYear ? null : year
}

/** 「三年級」「低年級A班」「低年級A班・二年級」 */
function targetLabel(row: Exam): string {
  const parts: string[] = []
  if (row.class) parts.push(row.class.name)
  if (row.grade_level !== null) parts.push(gradeLabel(row.grade_level))
  return parts.join('・') || '—'
}

function detailPath(row: Exam): string {
  return `/exams/${encodeURIComponent(row.id)}`
}

function goDetail(row: Exam): void {
  void router.push(detailPath(row))
}

// ---- 建立 ----
const formOpen = ref(false)

function openCreate(): void {
  formOpen.value = true
}

function onCreated(exam: Exam): void {
  void router.push({ path: detailPath(exam), query: { tab: 'scores' } })
}

// ---- 刪除（只限草稿） ----
const { confirmDelete } = useConfirmDelete<Exam>({
  request: (row) => deleteExam(row.id),
  confirmMessage: (row) => `刪除後已輸入的成績會一併刪除，確定要刪除「${row.name}」嗎？`,
  onSuccess: () => void list.reload(),
})

function onCommand(command: string | number | object, row: Exam): void {
  if (command === 'delete') void confirmDelete(row)
}
</script>

<template>
  <div class="exams-view">
    <PageHeader
      title="考試"
      subtitle="建立考試、輸入各科成績；發布後家長才看得到成績"
    >
      <template
        v-if="canWrite"
        #actions
      >
        <el-button
          type="primary"
          class="exams-view__touch"
          :icon="Plus"
          :disabled="loading || error !== null"
          @click="openCreate"
        >
          建立考試
        </el-button>
      </template>
    </PageHeader>

    <section class="exams-view__panel">
      <AdminListToolbar
        v-model:search="search"
        v-model:filter-values="toolbarValues"
        search-placeholder="搜尋考試名稱"
        :filters="toolbarFilters"
        :total="toolbarTotal"
      >
        <template #extra-filters>
          <div class="exams-view__date">
            <span class="exams-view__date-label">日期</span>
            <el-date-picker
              v-model="dateRange"
              type="daterange"
              value-format="YYYY-MM-DD"
              format="YYYY/MM/DD"
              unlink-panels
              range-separator="～"
              start-placeholder="開始日期"
              end-placeholder="結束日期"
              :shortcuts="dateShortcuts"
              aria-label="考試日期區間"
            />
          </div>
        </template>
      </AdminListToolbar>

      <EmptyState
        v-if="error !== null"
        variant="error"
        title="無法載入考試"
        :description="error"
      >
        <template #action>
          <el-button
            data-test="retry"
            @click="list.reload()"
          >
            重試
          </el-button>
        </template>
      </EmptyState>
      <template v-else>
        <el-table
          v-loading="loading"
          class="exam-table"
          :data="items"
          row-key="id"
          row-class-name="exam-row"
          @row-click="goDetail"
        >
          <!-- @vue-generic {Exam} -->
          <el-table-column
            label="考試日期"
            width="122"
          >
            <template #default="{ row }: { row: Exam }">
              <span class="exam-date"><span
                v-if="examYear(row)"
                class="exam-date__year"
              >{{ examYear(row) }}</span>{{ formatDateWithWeekday(row.exam_date) }}</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {Exam} -->
          <el-table-column
            label="名稱"
            min-width="160"
            show-overflow-tooltip
          >
            <template #default="{ row }: { row: Exam }">
              <RouterLink
                :to="detailPath(row)"
                class="exam-name"
                @click.stop
              >
                {{ row.name }}
              </RouterLink>
            </template>
          </el-table-column>
          <!-- @vue-generic {Exam} -->
          <el-table-column
            label="類型"
            width="80"
          >
            <template #default="{ row }: { row: Exam }">
              {{ row.exam_type.name }}
            </template>
          </el-table-column>
          <!-- @vue-generic {Exam} -->
          <el-table-column
            label="對象"
            min-width="140"
            show-overflow-tooltip
          >
            <template #default="{ row }: { row: Exam }">
              {{ targetLabel(row) }}
            </template>
          </el-table-column>
          <!-- @vue-generic {Exam} -->
          <el-table-column
            label="科目數"
            width="78"
            align="right"
          >
            <template #default="{ row }: { row: Exam }">
              <span
                v-if="row.subjects.length"
                class="exam-num"
              >{{ row.subjects.length }}</span>
              <span
                v-else
                class="exam-warn"
              >未設定</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {Exam} -->
          <el-table-column
            label="應考人數"
            width="90"
            align="right"
          >
            <template #default="{ row }: { row: Exam }">
              <span
                class="exam-num"
                :class="{ 'exam-warn': row.roster_count === 0 }"
              >{{ row.roster_count }}</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {Exam} -->
          <el-table-column
            label="狀態"
            width="140"
          >
            <template #default="{ row }: { row: Exam }">
              <div class="exam-status">
                <el-tag
                  :type="EXAM_STATUS_META[row.status].tone"
                  size="small"
                  disable-transitions
                >
                  {{ EXAM_STATUS_META[row.status].label }}
                </el-tag>
                <span
                  v-if="row.status === 'published'"
                  class="exam-status__time"
                >{{ formatDateTime(row.published_at) }}</span>
              </div>
            </template>
          </el-table-column>
          <!-- @vue-generic {Exam} -->
          <el-table-column
            v-if="canWrite"
            label=""
            width="72"
            align="center"
            fixed="right"
            class-name="exam-ops-col"
          >
            <template #default="{ row }: { row: Exam }">
              <span
                v-if="row.status === 'draft'"
                @click.stop
              >
                <el-dropdown
                  trigger="click"
                  @command="(cmd: string | number | object) => onCommand(cmd, row)"
                >
                  <el-button
                    class="exam-more"
                    text
                    :aria-label="`更多操作：${row.name}`"
                  >
                    <el-icon :size="18"><MoreFilled /></el-icon>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item
                        command="delete"
                        class="exams-view__danger-item"
                      >
                        <el-icon><Delete /></el-icon>刪除
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </span>
            </template>
          </el-table-column>
          <template #empty>
            <template v-if="!loading">
              <EmptyState
                v-if="isDefaultFilters"
                title="還沒有考試紀錄"
                description="預設只顯示近 90 天到未來 30 天的考試，更早的考試請調整日期區間"
              >
                <template
                  v-if="canWrite"
                  #action
                >
                  <el-button
                    type="primary"
                    class="exams-view__touch"
                    :icon="Plus"
                    @click="openCreate"
                  >
                    建立考試
                  </el-button>
                </template>
              </EmptyState>
              <EmptyState
                v-else
                variant="inline"
                title="沒有符合條件的考試"
                description="試著調整搜尋文字、篩選條件或日期區間"
              />
            </template>
            <span v-else />
          </template>
        </el-table>
        <div
          v-if="total > 0"
          class="list-pager"
        >
          <el-pagination
            :current-page="page"
            :page-size="PAGE_SIZE"
            :total="total"
            layout="prev, pager, next"
            background
            @update:current-page="list.setPage"
          />
        </div>
      </template>
    </section>

    <ExamFormDialog
      v-if="canWrite"
      v-model="formOpen"
      @saved="onCreated"
    />
  </div>
</template>

<style scoped>
.exams-view__panel {
  padding: 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

/* 平板：主要按鈕撐到 44px */
.exams-view__touch {
  min-height: 44px;
}

.exams-view__date {
  display: flex;
  gap: 6px;
  align-items: center;
}

.exams-view__date-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.exams-view__date :deep(.el-date-editor) {
  width: 250px;
}

.list-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.exam-table :deep(.exam-row) {
  cursor: pointer;
}

/* 列高 ≥ 48px：平板上點整列進入考試 */
.exam-table :deep(.el-table__body .el-table__cell) {
  padding: 12px 0;
}

.exam-date {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.exam-date__year {
  margin-right: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.exam-name {
  font-weight: 500;
  color: var(--el-color-primary);
  text-decoration: none;
}

.exam-name:hover {
  text-decoration: underline;
}

.exam-name:focus-visible {
  border-radius: 2px;
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.exam-num {
  font-variant-numeric: tabular-nums;
}

.exam-warn {
  color: var(--el-color-warning-dark-2);
}

.exam-status {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
}

.exam-status__time {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

/* 操作欄：72px 寬（扣掉 cell 左右 12px 剛好放得下 44px 的 ⋮ 鈕），不套 el-table cell 預設的 ellipsis */
.exam-table :deep(.exam-ops-col .cell) {
  overflow: visible;
  text-overflow: clip;
}

.exam-more.el-button {
  width: 44px;
  height: 44px;
  margin: -8px 0;
}
</style>

<style>
/* 下拉選單 teleport 到 body，scoped style 碰不到 */
.el-dropdown-menu__item.exams-view__danger-item,
.el-dropdown-menu__item.exams-view__danger-item:not(.is-disabled):hover {
  color: var(--el-color-danger);
}
</style>
