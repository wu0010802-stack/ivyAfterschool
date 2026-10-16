<script setup lang="ts">
// FRONTEND-129：請假列表（/leaves，leaves:read）。設計稿：docs/mockups/page-leaves.html。
// 移植 ivy FE:src/views/StudentLeavesListView.vue 的篩選 + 表格 + 學生連結；去掉學期班級標籤（classroomTerm）。
// - 篩選列沿用 AdminListToolbar 的版面樣式但不使用該元件（GET /admin/leaves 沒有關鍵字參數）：學生（StudentSelect）、
//   班級、狀態（沒有「全部」，預設生效中）、假別、建立者、日期區間（預設今天起 30 天，可清除 = 不限日期）、「重設」。
// - usePagedList（syncQuery，每頁 20）+ listLeaves；任何篩選變更回到第 1 頁。「不限日期」在網址以
//   date_from=all&date_to=all 表示（不送 API）：usePagedList 會把空值從 query 拿掉，空字串無法與「沒帶參數 = 預設區間」區分。
// - 「取消紀錄」欄只在本頁有已取消的列時出現；「操作」欄只在有 leaves:write 且本頁有生效中的列時出現
//   （沒有資料時依狀態篩選決定，表頭不會在載入前後跳動）。
// - 附件以 el-table expand 展開（預設箭頭欄隱藏，只由附件欄按鈕觸發）；展開區固定在表格可視寬度內。
// - 不訂閱 ws：代登記、取消成功後重新整理；取消失敗則在 dialog 關閉後重新整理。
// - el-table-column 是泛型元件，每欄前的 `@vue-generic {Leave}` 註解讓 slot 的 row 型別為 Leave（vue-tsc 專用）。
import { ArrowDown, Paperclip, Plus, Refresh } from '@element-plus/icons-vue'
import { computed, ref, shallowRef, watch } from 'vue'
import type { StudentListItem } from '@/api/students'
import { listLeaves, type Leave, type LeaveQuery } from '@/api/leaves'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import LeaveAttachmentList from '@/components/leaves/LeaveAttachmentList.vue'
import LeaveCancelDialog from '@/components/leaves/LeaveCancelDialog.vue'
import LeaveFormDialog from '@/components/leaves/LeaveFormDialog.vue'
import StudentSelect, { type StudentSelectInitialOption } from '@/components/student/StudentSelect.vue'
import { usePagedList } from '@/composables/usePagedList'
import { PERMISSIONS } from '@/constants/permissions'
import { LEAVE_STATUS_META, LEAVE_TYPE_META } from '@/shared/constants/statusLabels'
import {
  ACTOR_CREATED_BY_TYPES,
  LEAVE_STATUSES,
  LEAVE_TYPES,
  type ActorCreatedByType,
  type ISODate,
  type LeaveStatus,
  type LeaveType,
} from '@/shared/types/api'
import { addDays, formatDateTime, todayTaipei } from '@/shared/utils/datetime'
import { useLookupsStore } from '@/stores/lookups'
import { currentAcademicYear } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

const PAGE_SIZE = 20
/** el-select 把空字串當成「未選」，「全部」用哨兵值 */
const ALL = '__all__'
/** 網址上的「不限日期」標記，不會送到 API */
const ALL_DATES = 'all'
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DEFAULT_RANGE_DAYS = 30
const ACTOR_LABELS: Record<ActorCreatedByType, string> = { parent: '家長', staff: '員工' }

/** 全部以字串存：usePagedList 依初始值型別還原網址 query，空字串 = 全部（送出前會被去掉） */
interface LeaveFilters extends Record<string, unknown> {
  student_id: string
  class_id: string
  status: string
  leave_type: string
  created_by_type: string
  date_from: string
  date_to: string
}

const lookups = useLookupsStore()
const { can } = usePermission()
const canReadStudents = computed(() => can(PERMISSIONS.STUDENTS_READ))
const canWrite = computed(() => can(PERMISSIONS.LEAVES_WRITE))
/** 代登記的 StudentSelect 需要 GET /admin/students（students:read） */
const canCreate = computed(() => canWrite.value && canReadStudents.value)

const today = todayTaipei()
const academicYear = currentAcademicYear()

function defaultFilters(): LeaveFilters {
  return {
    student_id: '',
    class_id: '',
    status: 'active',
    leave_type: '',
    created_by_type: '',
    date_from: today,
    date_to: addDays(today, DEFAULT_RANGE_DAYS),
  }
}

function includes<T extends string>(values: readonly T[], v: string): v is T {
  return (values as readonly string[]).includes(v)
}

/** 兩端都是合法日期才有日期區間；「不限日期」標記、空值或手改網址的無效值都視為不限 */
function dateRangeOf(f: Pick<LeaveFilters, 'date_from' | 'date_to'>): [ISODate, ISODate] | null {
  return ISO_DATE_RE.test(f.date_from) && ISO_DATE_RE.test(f.date_to) ? [f.date_from, f.date_to] : null
}

/** usePagedList 已去掉空值；這裡只負責型別轉換與丟掉網址帶來的無效值 */
function toApiParams(params: LeaveFilters & { page: number; page_size: number }): LeaveQuery {
  const out: LeaveQuery = { page: params.page, page_size: params.page_size }
  if (params.student_id) out.student_id = params.student_id
  if (params.class_id) out.class_id = params.class_id
  out.status = params.status && includes<LeaveStatus>(LEAVE_STATUSES, params.status) ? params.status : 'active'
  if (params.leave_type && includes<LeaveType>(LEAVE_TYPES, params.leave_type)) out.leave_type = params.leave_type
  if (params.created_by_type && includes<ActorCreatedByType>(ACTOR_CREATED_BY_TYPES, params.created_by_type)) {
    out.created_by_type = params.created_by_type
  }
  const range = dateRangeOf({ date_from: params.date_from ?? '', date_to: params.date_to ?? '' })
  if (range) {
    out.date_from = range[0]
    out.date_to = range[1]
  }
  return out
}

const list = usePagedList<Leave, LeaveFilters>({
  fetch: (params) => listLeaves(toApiParams(params)),
  initialFilters: defaultFilters(),
  pageSize: PAGE_SIZE,
  syncQuery: true,
})
const { items, total, page, filters, loading, error } = list

lookups.ensure('classes').catch(() => {
  // 班級清單載入失敗時下拉只剩「全部」，列表本身不受影響
})
const classOptions = computed(() => lookups.classOptions(academicYear))

// ---- 篩選列 ----
function allSelect(key: 'class_id' | 'leave_type' | 'created_by_type') {
  return computed({
    get: () => filters[key] || ALL,
    set: (v: string) => list.setFilters({ [key]: v === ALL ? '' : v } as Partial<LeaveFilters>),
  })
}

const classSelection = allSelect('class_id')
const leaveTypeSelection = allSelect('leave_type')
const creatorSelection = allSelect('created_by_type')
const statusSelection = computed({
  get: () => (includes<LeaveStatus>(LEAVE_STATUSES, filters.status) ? filters.status : 'active'),
  set: (v: string) => list.setFilters({ status: v }),
})

/** 篩選中的學生：StudentSelect 選取時帶完整資料；從網址還原時由本頁資料補上，讓下拉顯示姓名 */
const filterStudent = shallowRef<StudentSelectInitialOption | null>(null)
const studentSelectKey = ref(0)

const studentSelection = computed({
  get: () => filters.student_id || null,
  set: (v: string | null) => list.setFilters({ student_id: v ?? '' }),
})

function onStudentChange(student: StudentListItem | null): void {
  filterStudent.value = student
    ? { id: student.id, name: student.name, student_no: student.student_no, class_name: student.class?.name ?? null }
    : null
}

const studentInitialOption = computed<StudentSelectInitialOption | undefined>(() => {
  const id = filters.student_id
  if (!id) return undefined
  if (filterStudent.value?.id === id) return filterStudent.value
  const row = items.value.find((l) => l.student.id === id)
  return row ? { ...row.student } : undefined
})

/** 從網址還原的學生篩選：第一次拿到該生的資料時重建 StudentSelect，讓它以 initialOption 顯示姓名 */
let restoredStudentShown = false
watch(studentInitialOption, (option) => {
  if (restoredStudentShown || !option || filterStudent.value) return
  restoredStudentShown = true
  studentSelectKey.value += 1
})

const dateRange = computed({
  get: (): [ISODate, ISODate] | null => dateRangeOf(filters),
  // 清除 = 不限日期：寫入標記值，網址才還原得回來
  set: (v: [ISODate, ISODate] | null) =>
    list.setFilters(v ? { date_from: v[0], date_to: v[1] } : { date_from: ALL_DATES, date_to: ALL_DATES }),
})

/** 台北日期 → 本地時區同一天的 00:00（日期選擇器以本地時區格式化 value-format） */
function localDate(iso: ISODate): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y!, m! - 1, d!)
}

function monthRange(offset: number): [Date, Date] {
  const [y, m] = today.split('-').map(Number)
  return [new Date(y!, m! - 1 + offset, 1), new Date(y!, m! + offset, 0)]
}

const dateShortcuts = [
  { text: '今天起 30 天', value: () => [localDate(today), localDate(addDays(today, DEFAULT_RANGE_DAYS))] },
  { text: '本月', value: () => monthRange(0) },
  { text: '上個月', value: () => monthRange(-1) },
  { text: '過去 90 天', value: () => [localDate(addDays(today, -89)), localDate(today)] },
]

const isDefaultFilters = computed(() => {
  const d = defaultFilters()
  return (Object.keys(d) as (keyof LeaveFilters)[]).every((k) => filters[k] === d[k])
})

function resetFilters(): void {
  filterStudent.value = null
  studentSelectKey.value += 1
  list.setFilters(defaultFilters())
}

// ---- 表格 ----
const hasRange = computed(() => dateRangeOf(filters) !== null)
const hasCancelled = computed(() =>
  items.value.length ? items.value.some((l) => l.status === 'cancelled') : statusSelection.value === 'cancelled',
)
const hasActive = computed(() =>
  items.value.length ? items.value.some((l) => l.status === 'active') : statusSelection.value === 'active',
)
const showActions = computed(() => canWrite.value && hasActive.value)

function formatRange(start: ISODate, end: ISODate): string {
  return start === end ? start : `${start}~${end}`
}

function isOngoing(l: Leave): boolean {
  return l.status === 'active' && l.start_date <= today && today <= l.end_date
}

function actorLabel(type: ActorCreatedByType | null, name: string | null): string {
  return `${type ? ACTOR_LABELS[type] : '—'}：${name || '—'}`
}

function cancelledNote(l: Leave): string {
  const who = l.cancelled_by_name ? `${actorLabel(l.cancelled_by_type, l.cancelled_by_name)} ` : ''
  return `${who}於 ${formatDateTime(l.cancelled_at)} 取消`
}

function studentSub(l: Leave): string {
  return `${l.student.student_no}・${l.student.class_name || '未分班'}`
}

function studentPath(l: Leave): string {
  return `/students?student=${encodeURIComponent(l.student.id)}`
}

// ---- 附件展開 ----
const expanded = ref<string[]>([])

function toggleAttachments(l: Leave): void {
  expanded.value = expanded.value.includes(l.id)
    ? expanded.value.filter((id) => id !== l.id)
    : [...expanded.value, l.id]
}

// ---- 代登記 ----
const formOpen = ref(false)
const formRendered = ref(false)

function openCreate(): void {
  formRendered.value = true
  formOpen.value = true
}

function onCreated(): void {
  void list.reload()
}

// ---- 取消 ----
const cancelTarget = shallowRef<Leave | null>(null)
const cancelOpen = ref(false)
const cancelKey = ref(0)
let reloadAfterClose = false

function openCancel(l: Leave): void {
  cancelTarget.value = l
  cancelKey.value += 1
  reloadAfterClose = false
  cancelOpen.value = true
}

function onCancelled(): void {
  void list.reload()
}

function onCancelFailed(): void {
  reloadAfterClose = true
}

function onCancelClosed(): void {
  if (!reloadAfterClose) return
  reloadAfterClose = false
  void list.reload()
}
</script>

<template>
  <div class="leaves-view">
    <PageHeader
      title="請假"
      subtitle="家長在 LINE 送出即生效；員工可代登記與取消"
    >
      <template #actions>
        <el-button
          :icon="Refresh"
          :loading="loading"
          @click="list.reload()"
        >
          重新整理
        </el-button>
        <el-button
          v-if="canCreate"
          type="primary"
          :icon="Plus"
          @click="openCreate"
        >
          代登記請假
        </el-button>
      </template>
    </PageHeader>

    <section class="leaves-view__panel">
      <!-- 沿用 AdminListToolbar 的版面樣式（本頁 API 沒有關鍵字搜尋，所以不用該元件） -->
      <div class="list-toolbar">
        <div
          v-if="canReadStudents"
          class="list-toolbar__filter"
        >
          <span class="list-toolbar__filter-label">學生</span>
          <div class="leaves-view__student">
            <StudentSelect
              :key="studentSelectKey"
              v-model="studentSelection"
              :initial-option="studentInitialOption"
              @change="onStudentChange"
            />
          </div>
        </div>
        <div class="list-toolbar__filter">
          <span class="list-toolbar__filter-label">班級</span>
          <el-select
            v-model="classSelection"
            class="leaves-view__class"
            aria-label="班級"
          >
            <el-option
              label="全部"
              :value="ALL"
            />
            <el-option
              v-for="o in classOptions"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </div>
        <div class="list-toolbar__filter">
          <span class="list-toolbar__filter-label">狀態</span>
          <el-select
            v-model="statusSelection"
            class="leaves-view__status"
            aria-label="狀態"
          >
            <el-option
              v-for="s in LEAVE_STATUSES"
              :key="s"
              :label="LEAVE_STATUS_META[s].label"
              :value="s"
            />
          </el-select>
        </div>
        <div class="list-toolbar__filter">
          <span class="list-toolbar__filter-label">假別</span>
          <el-select
            v-model="leaveTypeSelection"
            class="leaves-view__narrow"
            aria-label="假別"
          >
            <el-option
              label="全部"
              :value="ALL"
            />
            <el-option
              v-for="t in LEAVE_TYPES"
              :key="t"
              :label="LEAVE_TYPE_META[t].label"
              :value="t"
            />
          </el-select>
        </div>
        <div class="list-toolbar__filter">
          <span class="list-toolbar__filter-label">建立者</span>
          <el-select
            v-model="creatorSelection"
            class="leaves-view__narrow"
            aria-label="建立者"
          >
            <el-option
              label="全部"
              :value="ALL"
            />
            <el-option
              v-for="t in ACTOR_CREATED_BY_TYPES"
              :key="t"
              :label="ACTOR_LABELS[t]"
              :value="t"
            />
          </el-select>
        </div>
        <div class="list-toolbar__filter">
          <span class="list-toolbar__filter-label">日期</span>
          <el-date-picker
            v-model="dateRange"
            class="leaves-view__range"
            type="daterange"
            value-format="YYYY-MM-DD"
            unlink-panels
            range-separator="~"
            start-placeholder="不限"
            end-placeholder="不限"
            aria-label="日期區間"
            :shortcuts="dateShortcuts"
          />
        </div>
        <el-button
          class="leaves-view__reset"
          text
          type="primary"
          :disabled="isDefaultFilters"
          @click="resetFilters"
        >
          重設
        </el-button>
        <span class="list-toolbar__spacer" />
        <span
          v-if="!error && !(loading && !items.length)"
          class="list-toolbar__count"
        >共 {{ total }} 筆</span>
      </div>

      <EmptyState
        v-if="error !== null"
        variant="error"
        title="無法載入請假紀錄"
        :description="error"
      >
        <template #action>
          <el-button @click="list.reload()">
            重試
          </el-button>
        </template>
      </EmptyState>
      <template v-else>
        <el-table
          v-loading="loading"
          class="leave-table"
          :data="items"
          row-key="id"
          :expand-row-keys="expanded"
        >
          <!-- @vue-generic {Leave} -->
          <el-table-column
            label="學生"
            width="140"
            fixed="left"
          >
            <template #default="{ row }: { row: Leave }">
              <div class="lv-student">
                <RouterLink
                  v-if="canReadStudents"
                  class="lv-student__link"
                  :to="studentPath(row)"
                >
                  {{ row.student.name }}
                </RouterLink>
                <span
                  v-else
                  class="lv-student__name"
                >{{ row.student.name }}</span>
                <span
                  class="lv-sub lv-ellipsis"
                  :title="studentSub(row)"
                >{{ studentSub(row) }}</span>
              </div>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            label="假別"
            width="72"
          >
            <template #default="{ row }: { row: Leave }">
              <el-tag
                :type="LEAVE_TYPE_META[row.leave_type]?.tone ?? 'info'"
                disable-transitions
              >
                {{ row.leave_type_label }}
              </el-tag>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            label="期間"
            width="180"
          >
            <template #default="{ row }: { row: Leave }">
              <div class="lv-period">
                {{ formatRange(row.start_date, row.end_date) }}
              </div>
              <el-tag
                v-if="isOngoing(row)"
                class="lv-period-tag"
                type="primary"
                effect="plain"
                size="small"
                disable-transitions
              >
                進行中
              </el-tag>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            label="原因"
            min-width="110"
            show-overflow-tooltip
          >
            <template #default="{ row }: { row: Leave }">
              <span :class="{ 'lv-none': !row.reason }">{{ row.reason || '—' }}</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            label="建立者"
            width="128"
          >
            <template #default="{ row }: { row: Leave }">
              <div
                class="lv-ellipsis"
                :title="actorLabel(row.created_by_type, row.created_by_name)"
              >
                {{ actorLabel(row.created_by_type, row.created_by_name) }}
              </div>
              <div class="lv-sub">
                {{ formatDateTime(row.created_at) }}
              </div>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            v-if="hasCancelled"
            label="取消紀錄"
            width="170"
          >
            <template #default="{ row }: { row: Leave }">
              <div
                v-if="row.status === 'cancelled'"
                class="lv-cancel-note"
              >
                {{ cancelledNote(row) }}
              </div>
              <span
                v-else
                class="lv-none"
              >—</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            label="附件"
            width="88"
          >
            <template #default="{ row }: { row: Leave }">
              <el-button
                v-if="row.attachments.length"
                class="lv-att-toggle"
                :class="{ 'is-open': expanded.includes(row.id) }"
                link
                type="primary"
                :aria-expanded="expanded.includes(row.id) ? 'true' : 'false'"
                @click="toggleAttachments(row)"
              >
                <el-icon><Paperclip /></el-icon>{{ row.attachments.length }} 個<el-icon class="lv-att-chev">
                  <ArrowDown />
                </el-icon>
              </el-button>
              <span
                v-else
                class="lv-none"
              >—</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            type="expand"
            width="1"
            class-name="leave-expand-col"
          >
            <template #default="{ row }: { row: Leave }">
              <div class="lv-expand">
                <LeaveAttachmentList
                  :leave-id="row.id"
                  :attachments="row.attachments"
                />
              </div>
            </template>
          </el-table-column>
          <!-- @vue-generic {Leave} -->
          <el-table-column
            v-if="showActions"
            label="操作"
            width="84"
            fixed="right"
          >
            <template #default="{ row }: { row: Leave }">
              <template v-if="row.status === 'active'">
                <el-button
                  link
                  type="danger"
                  @click="openCancel(row)"
                >
                  {{ row.end_date >= today ? '取消' : '整筆取消' }}
                </el-button>
              </template>
              <span
                v-else
                class="lv-none"
              >—</span>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState
              v-if="!loading"
              variant="inline"
              :title="hasRange ? '這段期間沒有請假紀錄' : '沒有符合條件的請假紀錄'"
              description="試著調整日期區間或篩選條件"
            />
            <span v-else />
          </template>
        </el-table>
        <div
          v-if="total > 0"
          class="lv-pager"
        >
          <el-pagination
            :current-page="page"
            :page-size="PAGE_SIZE"
            :total="total"
            layout="total, prev, pager, next"
            background
            @current-change="list.setPage"
          />
        </div>
      </template>
    </section>

    <LeaveFormDialog
      v-if="formRendered"
      v-model="formOpen"
      :preset-student="studentInitialOption"
      @created="onCreated"
    />
    <LeaveCancelDialog
      v-if="cancelTarget"
      :key="cancelKey"
      v-model="cancelOpen"
      :leave="cancelTarget"
      @cancelled="onCancelled"
      @failed="onCancelFailed"
      @closed="onCancelClosed"
    />
  </div>
</template>

<style scoped>
.leaves-view__panel {
  padding: 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

/* 沿用 AdminListToolbar 的版面樣式 */
.list-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.list-toolbar__filter {
  display: flex;
  gap: 6px;
  align-items: center;
}

.list-toolbar__filter-label,
.list-toolbar__count {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.list-toolbar__spacer {
  flex: 1 1 auto;
}

.leaves-view__student {
  width: 220px;
}

.leaves-view__class {
  width: 130px;
}

.leaves-view__status {
  width: 104px;
}

.leaves-view__narrow {
  width: 96px;
}

/* el-date-picker 的 class 由內層元素接收（沒有 scope 屬性），以 :deep 指定 */
.list-toolbar :deep(.leaves-view__range) {
  --el-date-editor-width: 240px;

  width: 240px;
}

.leaves-view__reset {
  margin-left: -4px;
}

.lv-student {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  line-height: 1.4;
}

.lv-student__link {
  font-weight: 600;
  color: var(--el-color-primary);
  text-decoration: none;
}

.lv-student__link:hover,
.lv-student__link:focus-visible {
  text-decoration: underline;
}

.lv-student__name {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.lv-sub {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.lv-ellipsis {
  display: block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lv-none {
  color: var(--el-text-color-placeholder);
}

.lv-period {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.lv-period-tag {
  margin-top: 2px;
}

.lv-cancel-note {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  color: var(--el-text-color-regular);
}

.lv-att-toggle .lv-att-chev {
  margin-left: 2px;
  transition: transform 0.2s ease;
}

.lv-att-toggle.is-open .lv-att-chev {
  transform: rotate(180deg);
}

/* expand 欄只負責展開列，隱藏預設箭頭 */
.leave-table :deep(.leave-expand-col > .cell) {
  display: none;
}

.leave-table :deep(td.leave-expand-col),
.leave-table :deep(th.leave-expand-col) {
  border-right: none;
}

/* 展開列：內容固定在表格的可視寬度內（sticky + 容器寬），表格橫向捲動時不會被推出畫面。
   表格 body 的捲動容器設為 inline-size 容器，100cqw = 可視寬；不支援容器單位的瀏覽器退回整列寬。 */
.leave-table :deep(.el-table__body-wrapper .el-scrollbar__wrap) {
  container-type: inline-size;
}

.leave-table :deep(td.el-table__expanded-cell) {
  padding: 0;
  background: var(--el-fill-color-lighter);
}

.lv-expand {
  position: sticky;
  left: 0;
  box-sizing: border-box;
  width: 100%;
  width: 100cqw;
  padding: 12px 16px 16px;
}

.lv-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .lv-att-toggle .lv-att-chev {
    transition: none;
  }
}
</style>
