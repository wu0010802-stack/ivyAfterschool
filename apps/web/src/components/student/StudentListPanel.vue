<script setup lang="ts">
// FRONTEND-086：學生列表（搜尋、篩選、分頁、批次功能入口）。移植 ivy FE:src/components/student/workbench/StudentListPanel.vue
// 的工具列 + 表格 + 分頁 + query 記憶；去掉 dismissal 快速發起、bonus impact、匯出、學期篩選、更多欄位切換。
// 設計稿：docs/mockups/page-students.html（StudentListPanel 段）。
// - 篩選與頁碼經 usePagedList（syncQuery）同步到網址。狀態預設「在學」；選「全部」在網址記成 status=all
//   （query 沒有 status 時會還原成預設「在學」），送 API 時不帶 status。
// - usePagedList 以 initialFilters 的型別轉換 query；這裡的篩選初始值是 undefined，所以送出前自己轉型。
// - el-table-column 是泛型元件，每欄前的 `@vue-generic {StudentListItem}` 註解讓 slot 的 row 有型別（vue-tsc 專用）。
import { ArrowDown, Plus, Top, Upload } from '@element-plus/icons-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { listStudents, type StudentDetail, type StudentListItem, type StudentListParams } from '@/api/students'
import AdminListToolbar, { type FilterGroup } from '@/components/common/AdminListToolbar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import GradePromotionDialog from '@/components/student/GradePromotionDialog.vue'
import StudentFormDialog from '@/components/student/StudentFormDialog.vue'
import StudentImportDialog from '@/components/student/StudentImportDialog.vue'
import { usePagedList } from '@/composables/usePagedList'
import { PERMISSIONS } from '@/constants/permissions'
import { STUDENT_STATUS_META } from '@/shared/constants/statusLabels'
import type { StudentStatus } from '@/shared/types/api'
import { useLookupsStore } from '@/stores/lookups'
import { currentAcademicYear, GRADE_OPTIONS, gradeLabel } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

const props = withDefaults(defineProps<{ selectedId?: string | null }>(), { selectedId: null })

const emit = defineEmits<{ select: [id: string] }>()

const ALL_STATUS = 'all'
const DEFAULT_STATUS: StudentStatus = 'active'

interface StudentFilters extends Record<string, unknown> {
  q?: string
  class_id?: string
  grade_level?: number | string
  /** StudentStatus 或 'all'（全部） */
  status?: string
  school_id?: string
  include_archived?: boolean | string
}

function defaultFilters(): StudentFilters {
  return {
    q: undefined,
    class_id: undefined,
    grade_level: undefined,
    status: DEFAULT_STATUS,
    school_id: undefined,
    include_archived: undefined,
  }
}

function isStudentStatus(v: unknown): v is StudentStatus {
  return typeof v === 'string' && Object.hasOwn(STUDENT_STATUS_META, v)
}

/** 網址還原的值都是字串：年級轉數字、含封存轉布林；不認得的狀態視為預設 */
function normalized(f: StudentFilters) {
  const grade = Number(f.grade_level)
  const status = f.status === ALL_STATUS ? ALL_STATUS : isStudentStatus(f.status) ? f.status : DEFAULT_STATUS
  return {
    q: typeof f.q === 'string' && f.q ? f.q : undefined,
    class_id: typeof f.class_id === 'string' && f.class_id ? f.class_id : undefined,
    grade_level: f.grade_level !== undefined && f.grade_level !== '' && Number.isInteger(grade) ? grade : undefined,
    status,
    school_id: typeof f.school_id === 'string' && f.school_id ? f.school_id : undefined,
    include_archived: f.include_archived === true || f.include_archived === 'true',
  }
}

function toApiParams(f: StudentFilters & { page: number; page_size: number }): StudentListParams {
  const n = normalized(f)
  const params: StudentListParams = { page: f.page, page_size: f.page_size }
  if (n.q) params.q = n.q
  if (n.class_id) params.class_id = n.class_id
  if (n.grade_level !== undefined) params.grade_level = n.grade_level
  if (n.status !== ALL_STATUS) params.status = n.status
  if (n.school_id) params.school_id = n.school_id
  if (n.include_archived) params.include_archived = true
  return params
}

const list = usePagedList<StudentListItem, StudentFilters>({
  fetch: (params) => listStudents(toApiParams(params)),
  initialFilters: defaultFilters(),
  syncQuery: true,
})
const { items, total, page, pageSize, filters, loading, error } = list

const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.STUDENTS_WRITE))

// ---- 工具列 ----
const lookups = useLookupsStore()
const academicYear = currentAcademicYear()

onMounted(() => {
  // 下拉選項載入失敗不擋列表；選項維持空的
  lookups.ensure('classes', 'schools').catch(() => undefined)
})

const filterGroups = computed<FilterGroup[]>(() => [
  { key: 'class_id', label: '班級', options: lookups.classOptions(academicYear) },
  { key: 'grade_level', label: '年級', options: GRADE_OPTIONS },
  {
    key: 'status',
    label: '狀態',
    options: Object.entries(STUDENT_STATUS_META).map(([value, meta]) => ({ label: meta.label, value })),
  },
  { key: 'school_id', label: '就讀國小', options: lookups.schoolOptions },
])

const current = computed(() => normalized(filters))

/** AdminListToolbar 的下拉值：狀態「全部」以 undefined 表示 */
const filterValues = computed(() => ({
  class_id: current.value.class_id,
  grade_level: current.value.grade_level,
  status: current.value.status === ALL_STATUS ? undefined : current.value.status,
  school_id: current.value.school_id,
}))

function onFilterValues(next: Record<string, unknown>): void {
  list.setFilters({
    class_id: next.class_id as string | undefined,
    grade_level: next.grade_level as number | undefined,
    status: (next.status as string | undefined) ?? ALL_STATUS,
    school_id: next.school_id as string | undefined,
  })
}

function onSearch(value: string): void {
  const q = value || undefined
  if (q === current.value.q) return
  list.setFilters({ q })
}

const includeArchived = computed({
  get: () => current.value.include_archived,
  set: (v: boolean) => list.setFilters({ include_archived: v ? true : undefined }),
})

/** 狀態維持預設「在學」或選「全部」不算篩選 */
const hasFilter = computed(() => {
  const c = current.value
  const statusFiltered = c.status !== DEFAULT_STATUS && c.status !== ALL_STATUS
  return !!(c.q || c.class_id || c.grade_level !== undefined || c.school_id || c.include_archived || statusFiltered)
})

function clearFilters(): void {
  list.setFilters(defaultFilters())
}

// ---- 表格 ----
function schoolText(row: StudentListItem): string {
  const school = row.school ? row.school.short_name || row.school.name : null
  const text = [school, row.school_class].filter(Boolean).join(' ')
  return text || '—'
}

function rowClass({ row }: { row: StudentListItem }): string {
  return row.archived_at ? 'row-archived' : ''
}

function onRowClick(row: StudentListItem): void {
  emit('select', row.id)
}

/**
 * 選中列以 el-table 的 current row 高亮。current-row-key 在資料非同步載入前設定會被 el-table 清掉，
 * 所以在資料或 selectedId 變動後（DOM 更新後）自己同步。
 */
const table = ref<{ setCurrentRow: (row?: StudentListItem) => void } | null>(null)

watch(
  [items, () => props.selectedId],
  () => {
    table.value?.setCurrentRow(items.value.find((s) => s.id === props.selectedId))
  },
  { flush: 'post' },
)

// ---- 寫入動作 ----
const formOpen = ref(false)
const importOpen = ref(false)
const promotionOpen = ref(false)

function onBatchCommand(command: string | number | object): void {
  if (command === 'import') importOpen.value = true
  else if (command === 'promote') promotionOpen.value = true
}

function onCreated(detail: StudentDetail): void {
  emit('select', detail.id)
  void list.reload()
}

function reload(): Promise<void> {
  return list.reload()
}

defineExpose({ reload })
</script>

<template>
  <section class="student-list">
    <AdminListToolbar
      :search="current.q ?? ''"
      search-placeholder="搜尋學號或姓名"
      :filters="filterGroups"
      :filter-values="filterValues"
      :total="loading || error ? undefined : total"
      @update:search="onSearch"
      @update:filter-values="onFilterValues"
    >
      <template #extra-filters>
        <el-checkbox v-model="includeArchived">
          含封存
        </el-checkbox>
      </template>
      <template
        v-if="canWrite"
        #actions
      >
        <el-button
          type="primary"
          :icon="Plus"
          @click="formOpen = true"
        >
          新增學生
        </el-button>
        <el-dropdown
          trigger="click"
          @command="onBatchCommand"
        >
          <el-button>
            批次作業<el-icon class="el-icon--right">
              <ArrowDown />
            </el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="import">
                <el-icon><Upload /></el-icon>匯入 Excel
              </el-dropdown-item>
              <el-dropdown-item command="promote">
                <el-icon><Top /></el-icon>學年升級
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>
    </AdminListToolbar>

    <EmptyState
      v-if="error"
      variant="error"
      title="無法載入學生列表"
      :description="error"
    >
      <template #action>
        <el-button @click="reload">
          重試
        </el-button>
      </template>
    </EmptyState>
    <template v-else>
      <el-table
        ref="table"
        v-loading="loading"
        class="student-list__table"
        :data="items"
        border
        highlight-current-row
        row-key="id"
        :row-class-name="rowClass"
        @row-click="onRowClick"
      >
        <el-table-column
          prop="student_no"
          label="學號"
          width="96"
        />
        <!-- @vue-generic {StudentListItem} -->
        <el-table-column
          label="姓名"
          min-width="104"
        >
          <template #default="{ row }: { row: StudentListItem }">
            {{ row.name }}<el-tag
              v-if="row.archived_at"
              class="archived-tag"
              size="small"
              type="info"
              disable-transitions
            >
              已封存
            </el-tag>
          </template>
        </el-table-column>
        <!-- @vue-generic {StudentListItem} -->
        <el-table-column
          label="年級"
          width="72"
        >
          <template #default="{ row }: { row: StudentListItem }">
            {{ gradeLabel(row.grade_level) }}
          </template>
        </el-table-column>
        <!-- @vue-generic {StudentListItem} -->
        <el-table-column
          label="就讀國小 / 班級"
          min-width="130"
          show-overflow-tooltip
        >
          <template #default="{ row }: { row: StudentListItem }">
            {{ schoolText(row) }}
          </template>
        </el-table-column>
        <!-- @vue-generic {StudentListItem} -->
        <el-table-column
          label="安親班班級"
          min-width="100"
          show-overflow-tooltip
        >
          <template #default="{ row }: { row: StudentListItem }">
            {{ row.class?.name ?? '—' }}
          </template>
        </el-table-column>
        <!-- @vue-generic {StudentListItem} -->
        <el-table-column
          label="狀態"
          width="80"
        >
          <template #default="{ row }: { row: StudentListItem }">
            <el-tag
              :type="STUDENT_STATUS_META[row.status].tone"
              disable-transitions
            >
              {{ STUDENT_STATUS_META[row.status].label }}
            </el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <template v-if="!loading">
            <EmptyState
              v-if="hasFilter"
              variant="inline"
              title="沒有符合條件的學生"
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
            <EmptyState
              v-else
              variant="inline"
              title="還沒有學生"
              :description="canWrite ? '新增第一位學生，或用 Excel 一次匯入' : ''"
            >
              <template
                v-if="canWrite"
                #action
              >
                <el-button
                  size="small"
                  type="primary"
                  @click="formOpen = true"
                >
                  新增學生
                </el-button>
                <el-button
                  size="small"
                  @click="importOpen = true"
                >
                  匯入 Excel
                </el-button>
              </template>
            </EmptyState>
          </template>
          <span v-else />
        </template>
      </el-table>
      <div class="student-list__pager">
        <el-pagination
          :current-page="page"
          :page-size="pageSize"
          :total="total"
          layout="total, prev, pager, next"
          background
          @current-change="list.setPage"
        />
      </div>
    </template>

    <template v-if="canWrite">
      <StudentFormDialog
        v-model="formOpen"
        @saved="onCreated"
      />
      <StudentImportDialog
        v-model="importOpen"
        @imported="reload"
      />
      <GradePromotionDialog
        v-model="promotionOpen"
        @promoted="reload"
      />
    </template>
  </section>
</template>

<style scoped>
.student-list {
  padding: 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.student-list__table {
  width: 100%;
}

.student-list__table :deep(.el-table__row) {
  cursor: pointer;
}

/* 封存學生整列淡化 */
.student-list__table :deep(.row-archived td) {
  opacity: 0.55;
}

/* 選中列主色淡底 */
.student-list__table :deep(.current-row > td.el-table__cell) {
  background: var(--el-color-primary-light-9);
}

.archived-tag {
  margin-left: 6px;
}

.student-list__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
