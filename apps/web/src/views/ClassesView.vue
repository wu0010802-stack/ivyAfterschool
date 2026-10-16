<script setup lang="ts">
// FRONTEND-097：班級管理頁（/classes，classes:read）。移植 ivy FE:src/views/ClassroomView.vue 的班級表格、學年度切換、
// 新增 / 編輯 / 封存流程；去掉容量、預留名額、招生計畫、學期、班級異動紀錄抽屜、年級表。
// 設計稿：docs/mockups/page-classes.html。班級數量少，不分頁；篩選（學年度 / 只看我的班 / 含已封存）存在網址 query。
// 篩選列沿用 AdminListToolbar 的版面樣式，但本頁沒有關鍵字搜尋，不使用該元件。
// el-table-column 是泛型元件，每欄前的 `@vue-generic {ClassItem}` 註解讓 slot 的 row 型別為 ClassItem（vue-tsc 專用）。
import { Plus } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { archiveClass, listClasses, type ClassItem, type ClassStaff } from '@/api/classes'
import ClassFormDialog from '@/components/classes/ClassFormDialog.vue'
import ClassStaffDialog from '@/components/classes/ClassStaffDialog.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { PERMISSIONS } from '@/constants/permissions'
import { isApiError } from '@/shared/types/api'
import { formatDate } from '@/shared/utils/datetime'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'
import { useLookupsStore } from '@/stores/lookups'
import { academicYearOptions, currentAcademicYear, gradeLevelsLabel } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

interface ClassFilters {
  academic_year: number
  mine: boolean
  include_archived: boolean
}

const route = useRoute()
const router = useRouter()
const lookups = useLookupsStore()
const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.CLASSES_WRITE))

const currentYear = currentAcademicYear()
const yearOptions = academicYearOptions(currentYear)

/** 網址的學年度不在選項內（或格式不對）時用目前學年度 */
function parseYear(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const year = Number(value)
  return yearOptions.some((o) => o.value === year) ? year : null
}

const filters = computed<ClassFilters>(() => ({
  academic_year: parseYear(route.query.academic_year) ?? currentYear,
  mine: route.query.mine === 'true',
  include_archived: route.query.include_archived === 'true',
}))

function setFilters(patch: Partial<ClassFilters>): void {
  const next = { ...filters.value, ...patch }
  void router.replace({
    query: {
      ...route.query,
      academic_year: String(next.academic_year),
      mine: String(next.mine),
      include_archived: String(next.include_archived),
    },
  })
}

const academicYear = computed({
  get: () => filters.value.academic_year,
  set: (v: number) => setFilters({ academic_year: v }),
})
const mine = computed({
  get: () => filters.value.mine,
  set: (v: boolean) => setFilters({ mine: v }),
})
const includeArchived = computed({
  get: () => filters.value.include_archived,
  set: (v: boolean) => setFilters({ include_archived: v }),
})

const items = ref<ClassItem[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
let loadSeq = 0

async function load(): Promise<void> {
  const seq = ++loadSeq
  const { academic_year, include_archived, mine: onlyMine } = filters.value
  loading.value = true
  loadError.value = null
  try {
    const list = await listClasses({ academic_year, include_archived, mine: onlyMine })
    if (seq === loadSeq) items.value = list
  } catch (err) {
    if (seq === loadSeq) loadError.value = errorMessage(err, '請稍後再試一次')
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(
  () => [filters.value.academic_year, filters.value.mine, filters.value.include_archived] as const,
  () => void load(),
  { immediate: true },
)

const rows = computed(() =>
  [...items.value].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-Hant')),
)

/** 負責老師在前、協助老師在後（各自保留後端順序） */
function orderedStaff(row: ClassItem): ClassStaff[] {
  return [...row.staff.filter((s) => s.role === 'lead'), ...row.staff.filter((s) => s.role !== 'lead')]
}

function rowClass({ row }: { row: ClassItem }): string {
  return row.archived_at ? 'cls-row-archived' : ''
}

function goStudents(row: ClassItem): void {
  void router.push({ path: '/students', query: { class_id: row.id } })
}

// ---- 新增 / 編輯 / 指派老師 ----
const formOpen = ref(false)
const editing = ref<ClassItem | undefined>(undefined)
const staffOpen = ref(false)
const staffKlass = ref<ClassItem | null>(null)

function openCreate(): void {
  editing.value = undefined
  formOpen.value = true
}

function openEdit(row: ClassItem): void {
  editing.value = row
  formOpen.value = true
}

function openStaff(row: ClassItem): void {
  staffKlass.value = row
  staffOpen.value = true
}

function afterWrite(): void {
  lookups.invalidate('classes')
  void load()
}

// ---- 封存 ----
const archiving = ref(false)

/** 409 class_has_students 的人數用 details.student_count（後端含暫停中的學生），沒有時退回表格人數 */
function blockingStudentCount(err: unknown, row: ClassItem): number {
  const count = isApiError(err) ? (err.details as { student_count?: unknown } | null)?.student_count : undefined
  return typeof count === 'number' ? count : row.student_count
}

async function showHasStudents(err: unknown, row: ClassItem): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `班級仍有 ${blockingStudentCount(err, row)} 位在學學生，請先將學生調班或退班`,
      '無法封存',
      { type: 'warning', confirmButtonText: '查看班上學生', cancelButtonText: '關閉' },
    )
  } catch {
    return
  }
  goStudents(row)
}

async function archive(row: ClassItem): Promise<void> {
  if (archiving.value) return
  try {
    await ElMessageBox.confirm(`封存後此班級不會出現在班級選單，確定要封存 ${row.name} 嗎？`, '封存班級', {
      type: 'warning',
      confirmButtonText: '封存',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return
  }
  archiving.value = true
  try {
    await archiveClass(row.id)
  } catch (err) {
    if (errorCode(err) === 'class_has_students') void showHasStudents(err, row)
    else ElMessage.error(errorMessage(err, '封存失敗，請稍後再試'))
    return
  } finally {
    archiving.value = false
  }
  ElMessage.success(`已封存 ${row.name}`)
  afterWrite()
}
</script>

<template>
  <div class="classes-page">
    <PageHeader
      title="班級管理"
      subtitle="安親班內部的班級；學生就讀國小的班級在學生資料裡填寫"
    >
      <template
        v-if="canWrite"
        #actions
      >
        <el-button
          type="primary"
          :icon="Plus"
          :disabled="loading || loadError !== null"
          @click="openCreate"
        >
          新增班級
        </el-button>
      </template>
    </PageHeader>

    <section class="classes-page__panel">
      <div class="list-toolbar">
        <div
          class="list-toolbar__filter"
          data-test="filter-year"
        >
          <span class="list-toolbar__filter-label">學年度</span>
          <el-select
            v-model="academicYear"
            class="classes-page__year"
            aria-label="學年度"
          >
            <el-option
              v-for="o in yearOptions"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </div>
        <el-checkbox v-model="mine">
          只看我的班
        </el-checkbox>
        <el-checkbox v-model="includeArchived">
          含已封存
        </el-checkbox>
        <span class="list-toolbar__spacer" />
        <span
          v-if="!loading && loadError === null"
          class="list-toolbar__count"
          data-test="class-count"
        >共 {{ rows.length }} 班</span>
      </div>

      <EmptyState
        v-if="loadError !== null"
        variant="error"
        title="無法載入班級"
        :description="loadError"
      >
        <template #action>
          <el-button @click="load">
            重試
          </el-button>
        </template>
      </EmptyState>
      <el-table
        v-else
        v-loading="loading"
        :data="rows"
        :row-class-name="rowClass"
      >
        <el-table-column
          prop="name"
          label="班級名稱"
          min-width="120"
          show-overflow-tooltip
        />
        <!-- @vue-generic {ClassItem} -->
        <el-table-column
          label="年級"
          min-width="100"
        >
          <template #default="{ row }: { row: ClassItem }">
            {{ gradeLevelsLabel(row.grade_levels) }}
          </template>
        </el-table-column>
        <!-- @vue-generic {ClassItem} -->
        <el-table-column
          label="在學人數"
          width="90"
          align="right"
        >
          <template #default="{ row }: { row: ClassItem }">
            <el-button
              v-if="row.student_count > 0"
              class="cls-count"
              link
              type="primary"
              @click="goStudents(row)"
            >
              {{ row.student_count }}
            </el-button>
            <span
              v-else
              class="cls-count cls-none"
            >0</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {ClassItem} -->
        <el-table-column
          label="負責老師"
          min-width="160"
        >
          <template #default="{ row }: { row: ClassItem }">
            <span
              v-if="row.staff.length"
              class="cls-staff"
            ><template
              v-for="(s, i) in orderedStaff(row)"
              :key="s.staff_user_id"
            ><template v-if="i">、</template><strong v-if="s.role === 'lead'">{{ s.display_name }}</strong><span v-else>{{ s.display_name }}</span></template></span>
            <span
              v-else
              class="cls-none"
            >尚未指派</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="sort_order"
          label="排序"
          width="70"
          align="right"
        />
        <!-- @vue-generic {ClassItem} -->
        <el-table-column
          v-if="includeArchived"
          label="狀態"
          width="160"
        >
          <template #default="{ row }: { row: ClassItem }">
            <span
              v-if="row.archived_at"
              class="cls-archived"
            >
              <el-tag
                size="small"
                type="info"
                effect="plain"
                disable-transitions
              >已封存</el-tag>{{ formatDate(row.archived_at) }}
            </span>
            <span
              v-else
              class="cls-none"
            >—</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {ClassItem} -->
        <el-table-column
          v-if="canWrite"
          label="操作"
          width="180"
          fixed="right"
        >
          <template #default="{ row }: { row: ClassItem }">
            <span
              v-if="!row.archived_at"
              class="cls-ops"
            >
              <el-button
                link
                type="primary"
                @click="openEdit(row)"
              >
                編輯
              </el-button>
              <el-button
                link
                type="primary"
                @click="openStaff(row)"
              >
                指派老師
              </el-button>
              <el-button
                link
                type="danger"
                :disabled="archiving"
                @click="archive(row)"
              >
                封存
              </el-button>
            </span>
            <span
              v-else
              class="cls-none"
            >—</span>
          </template>
        </el-table-column>
        <template #empty>
          <template v-if="!loading">
            <EmptyState
              v-if="mine"
              :title="`${academicYear} 學年度沒有你負責的班級`"
              description="負責老師由有「管理班級」權限的人在「指派老師」設定"
            >
              <template #action>
                <el-button @click="mine = false">
                  顯示全部班級
                </el-button>
              </template>
            </EmptyState>
            <EmptyState
              v-else
              :title="`${academicYear} 學年度還沒有班級`"
            >
              <template
                v-if="canWrite"
                #action
              >
                <el-button
                  type="primary"
                  :icon="Plus"
                  @click="openCreate"
                >
                  新增班級
                </el-button>
              </template>
            </EmptyState>
          </template>
          <span v-else />
        </template>
      </el-table>
    </section>

    <template v-if="canWrite">
      <ClassFormDialog
        v-model="formOpen"
        :klass="editing"
        :default-academic-year="academicYear"
        @saved="afterWrite"
      />
      <ClassStaffDialog
        v-if="staffKlass"
        v-model="staffOpen"
        :klass="staffKlass"
        @saved="afterWrite"
      />
    </template>
  </div>
</template>

<style scoped>
.classes-page__panel {
  padding: 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

/* 版面同 AdminListToolbar（FRONTEND-041） */
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

.list-toolbar__filter-label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.list-toolbar__spacer {
  flex: 1 1 auto;
}

.list-toolbar__count {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.classes-page__year {
  width: 130px;
}

.cls-staff strong {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.cls-none {
  color: var(--el-text-color-placeholder);
}

.classes-page__panel :deep(.cls-row-archived td .cell) {
  color: var(--el-text-color-secondary);
}

.cls-archived {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.cls-count {
  font-variant-numeric: tabular-nums;
}

.cls-ops {
  display: inline-flex;
  gap: 12px;
}

.cls-ops .el-button + .el-button {
  margin-left: 0;
}
</style>
