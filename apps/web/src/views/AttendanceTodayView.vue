<script setup lang="ts">
// FRONTEND-122：今日出勤頁（/attendance，attendance:read，meta.tablet）。設計稿：docs/mockups/page-attendance-today.html。
// 移植 ivy FE:src/views/StudentAttendanceView.vue 的班級篩選 + 日期切換 + 統計摘要；點名改為逐生到班 / 離班 / 缺席
// 即時送出 + 批次到班，去掉圖表、學期與教師端整班一次儲存的批次表單。
// - 資料、逐生操作、批次到班與 ws 即時合併由 useAttendanceBoard（FRONTEND-126）負責；本頁只處理篩選與畫面狀態。
// - 班級存在 route.query.class_id（後端篩選）；摘要 chip 與搜尋只做前端過濾，不重新請求。
// - 非今天只能改判：隱藏「批次到班」與卡片上的到班 / 缺席 / 離班按鈕，⋮ 改判照常。
// - 平板為主：工具列控制項、批次列按鈕高度 ≥ 44px。
import { Calendar, Finished, InfoFilled, Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import type { AttendanceRow, BatchCheckInSkip } from '@/api/attendance'
import AttendanceAmendDialog from '@/components/attendance/AttendanceAmendDialog.vue'
import AttendanceStudentCard from '@/components/attendance/AttendanceStudentCard.vue'
import AttendanceSummaryBar from '@/components/attendance/AttendanceSummaryBar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useAttendanceBoard } from '@/composables/useAttendanceBoard'
import type { AttendanceStatus, ISODate } from '@/shared/types/api'
import { todayTaipei } from '@/shared/utils/datetime'
import { useLookupsStore } from '@/stores/lookups'
import { currentAcademicYear } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

interface ClassGroup {
  key: string
  name: string
  rows: AttendanceRow[]
}

interface SkippedItem extends BatchCheckInSkip {
  student_name: string
}

/** el-select 把空字串當成「未選」，「全部班級」用哨兵值 */
const ALL = '__all__'
const SELECTABLE: ReadonlySet<AttendanceStatus> = new Set(['expected', 'absent'])

const route = useRoute()
const router = useRouter()
const lookups = useLookupsStore()
const { can } = usePermission()

const today = todayTaipei()
const academicYear = currentAcademicYear()

lookups.ensure('classes').catch(() => {
  // 班級清單載入失敗時下拉只剩「全部班級」，出勤照常可看
})
const classOptions = computed(() => lookups.classOptions(academicYear))

// ---- 篩選 ----
const date = ref<ISODate>(today)
const classId = computed<string | null>(() => {
  const value = route.query.class_id
  return typeof value === 'string' && value !== '' ? value : null
})
const classSelection = computed({
  get: () => classId.value ?? ALL,
  set: (value: string) => {
    const query: LocationQueryRaw = { ...route.query }
    if (value === ALL) delete query.class_id
    else query.class_id = value
    void router.replace({ query })
  },
})
const keyword = ref('')
const activeStatus = ref<AttendanceStatus | null>(null)

const isToday = computed(() => date.value === today)
const canOperate = computed(() => can('attendance:operate') && isToday.value)
const canAmend = computed(() => can('attendance:amend'))

function isFutureDate(d: Date): boolean {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` > today
}

function onDateChange(value: ISODate | null): void {
  if (value && value <= today) date.value = value
}

// ---- 資料 ----
const board = useAttendanceBoard({ date, classId })
const { data, loading, error, busyIds, wsDenied } = board

const rows = computed<AttendanceRow[]>(() => data.value?.items ?? [])
const initialLoading = computed(() => loading.value && data.value === null)
const loadFailed = computed(() => !loading.value && data.value === null && error.value !== null)
const isClosedDay = computed(() => data.value !== null && !data.value.is_service_day && rows.value.length === 0)
const isEmptyRoster = computed(() => data.value !== null && data.value.is_service_day && rows.value.length === 0)
const summary = computed(
  () => data.value?.summary ?? { total: 0, expected: 0, present: 0, left: 0, absent: 0, leave: 0 },
)

const visibleRows = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return rows.value.filter(
    (r) =>
      (activeStatus.value === null || r.status === activeStatus.value) &&
      (!q || r.student_name.toLowerCase().includes(q) || r.student_no.toLowerCase().includes(q)),
  )
})

/** 全部班級時依班級分組（沿用後端的班級順序）；選了班級時只有一組、不顯示標題 */
const groups = computed<ClassGroup[]>(() => {
  const map = new Map<string, ClassGroup>()
  for (const r of visibleRows.value) {
    const key = r.class_id ?? ''
    let group = map.get(key)
    if (!group) {
      group = { key, name: r.class_name ?? '未分班', rows: [] }
      map.set(key, group)
    }
    group.rows.push(r)
  }
  return [...map.values()]
})

const selectedClassName = computed(() => {
  const id = classId.value
  if (!id) return ''
  return rows.value.find((r) => r.class_id === id)?.class_name ?? classOptions.value.find((o) => o.value === id)?.label ?? ''
})

async function refresh(): Promise<void> {
  await board.reload()
  if (error.value && data.value) ElMessage.error(error.value)
}

// ---- 批次到班 ----
const selecting = ref(false)
const selected = shallowRef<ReadonlySet<string>>(new Set())
const batchSaving = ref(false)
const skippedOpen = ref(false)
const skippedSucceeded = ref(0)
const skippedItems = shallowRef<SkippedItem[]>([])

const selectableVisible = computed(() => visibleRows.value.filter((r) => SELECTABLE.has(r.status)))

function startBatch(): void {
  selecting.value = true
  selected.value = new Set()
}

function cancelBatch(): void {
  selecting.value = false
  selected.value = new Set()
}

function toggleSelect(row: AttendanceRow): void {
  if (!SELECTABLE.has(row.status)) return
  const next = new Set(selected.value)
  if (next.has(row.student_id)) next.delete(row.student_id)
  else next.add(row.student_id)
  selected.value = next
}

/** 只選目前畫面上（套用班級、chip、搜尋後）可選的學生 */
function selectAllAbsent(): void {
  selected.value = new Set(selectableVisible.value.map((r) => r.student_id))
}

async function confirmBatch(): Promise<void> {
  const ids = [...selected.value]
  if (!ids.length || batchSaving.value) return
  const names = new Map(rows.value.map((r) => [r.student_id, r.student_name]))
  batchSaving.value = true
  try {
    const result = await board.batchCheckIn(ids)
    ElMessage.success(`已到班 ${result.succeeded.length} 位`)
    cancelBatch()
    if (result.skipped.length) {
      skippedSucceeded.value = result.succeeded.length
      skippedItems.value = result.skipped.map((s) => ({ ...s, student_name: names.get(s.student_id) ?? '學生' }))
      skippedOpen.value = true
    }
  } catch {
    // useAttendanceBoard 已顯示錯誤；保留選取讓使用者重試
  } finally {
    batchSaving.value = false
  }
}

// 換日期或班級：離開選取模式；換日期另清除狀態篩選
watch(date, () => {
  activeStatus.value = null
  cancelBatch()
})
watch(classId, () => cancelBatch())

// ---- 改判 ----
const amendRow = shallowRef<AttendanceRow | null>(null)
const amendOpen = ref(false)

function openAmend(row: AttendanceRow): void {
  amendRow.value = row
  amendOpen.value = true
}
</script>

<template>
  <div
    class="att"
    :class="{ 'is-selecting': selecting }"
  >
    <div class="att__toolbar">
      <el-date-picker
        :model-value="date"
        class="att__date touch"
        type="date"
        size="large"
        value-format="YYYY-MM-DD"
        format="YYYY-MM-DD"
        aria-label="日期"
        :clearable="false"
        :disabled-date="isFutureDate"
        @update:model-value="onDateChange"
      />
      <el-select
        v-model="classSelection"
        class="att__class touch"
        size="large"
        aria-label="班級"
      >
        <el-option
          label="全部班級"
          :value="ALL"
        />
        <el-option
          v-for="o in classOptions"
          :key="o.value"
          :label="o.label"
          :value="o.value"
        />
      </el-select>
      <el-input
        v-model="keyword"
        class="att__search touch"
        size="large"
        placeholder="姓名或學號"
        aria-label="搜尋姓名或學號"
        clearable
        :prefix-icon="Search"
      />
      <span class="att__spacer" />
      <el-button
        class="touch"
        size="large"
        :icon="Refresh"
        :loading="loading && data !== null"
        @click="refresh"
      >
        重新整理
      </el-button>
      <el-button
        v-if="canOperate && !selecting"
        class="touch"
        size="large"
        type="primary"
        plain
        :icon="Finished"
        :disabled="!rows.length"
        @click="startBatch"
      >
        批次到班
      </el-button>
    </div>

    <el-alert
      v-if="!isToday"
      type="info"
      :closable="false"
      show-icon
      :title="`檢視 ${date}，僅可改判`"
    />
    <el-alert
      v-if="wsDenied"
      type="warning"
      :closable="false"
      show-icon
      title="沒有即時更新權限，請手動重新整理"
    />

    <EmptyState
      v-if="loadFailed"
      variant="error"
      title="無法載入出勤資料"
      :description="error ?? ''"
    >
      <template #action>
        <el-button
          class="touch"
          @click="board.reload()"
        >
          重試
        </el-button>
      </template>
    </EmptyState>

    <EmptyState
      v-else-if="isClosedDay"
      :icon="Calendar"
      :title="`${date} 不是營業日`"
    />

    <template v-else>
      <AttendanceSummaryBar
        v-model:active="activeStatus"
        :summary="summary"
        :loading="initialLoading"
      />

      <div
        v-if="selecting"
        class="batch-hint"
      >
        <el-icon><InfoFilled /></el-icon>
        <span>點選要到班的學生（只能選「預計到班」或「缺席」）</span>
        <span class="att__spacer" />
        <el-button
          type="primary"
          plain
          @click="selectAllAbsent"
        >
          全選未到（{{ selectableVisible.length }}）
        </el-button>
      </div>

      <div
        v-if="initialLoading"
        class="att__grid"
        aria-busy="true"
      >
        <div
          v-for="i in 8"
          :key="i"
          class="acard-skeleton"
        >
          <el-skeleton
            :rows="3"
            animated
          />
        </div>
      </div>

      <EmptyState
        v-else-if="isEmptyRoster"
        title="沒有出勤名單"
        :description="`${selectedClassName}目前沒有在學學生`"
      />

      <EmptyState
        v-else-if="!visibleRows.length"
        variant="inline"
        title="沒有符合條件的學生"
        description="試著調整搜尋文字或狀態篩選"
      />

      <template v-else>
        <section
          v-for="g in groups"
          :key="g.key"
          class="att__group"
        >
          <h3
            v-if="!classId"
            class="att__group-title"
          >
            {{ g.name }}<span class="att__group-count">{{ g.rows.length }} 位</span>
          </h3>
          <div class="att__grid">
            <AttendanceStudentCard
              v-for="r in g.rows"
              :key="r.student_id"
              :row="r"
              :can-operate="canOperate"
              :can-amend="canAmend"
              :selectable="selecting"
              :selected="selected.has(r.student_id)"
              :busy="busyIds.has(r.student_id)"
              @check-in="board.checkIn"
              @check-out="board.checkOut"
              @mark-absent="board.markAbsent"
              @amend="openAmend"
              @toggle-select="toggleSelect"
            />
          </div>
        </section>
      </template>

      <div
        v-if="selecting"
        class="batch-bar"
      >
        <span class="batch-bar__count">已選 {{ selected.size }} 位</span>
        <span class="att__spacer" />
        <el-button
          :disabled="batchSaving"
          @click="cancelBatch"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :disabled="!selected.size"
          :loading="batchSaving"
          @click="confirmBatch"
        >
          確認到班
        </el-button>
      </div>
    </template>

    <AttendanceAmendDialog
      v-if="amendRow"
      v-model="amendOpen"
      :row="amendRow"
      @amended="board.applyRow"
    />

    <el-dialog
      v-model="skippedOpen"
      title="部分學生未到班"
      width="420px"
      append-to-body
    >
      <div>已到班 {{ skippedSucceeded }} 位；以下學生未登記：</div>
      <ul class="skipped-list">
        <li
          v-for="s in skippedItems"
          :key="s.student_id"
        >
          {{ s.student_name }}：{{ s.message }}
        </li>
      </ul>
      <template #footer>
        <el-button
          class="touch"
          type="primary"
          @click="skippedOpen = false"
        >
          知道了
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* 與 AdminLayout 主內容區的 padding 一致（批次列貼齊內容區左右與底緣） */
.att {
  --att-gutter: 20px;

  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100%;
}

@media (max-width: 1024px) {
  .att {
    --att-gutter: 16px;
  }
}

@media (max-width: 767px) {
  .att {
    --att-gutter: 12px;
  }
}

.att__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.att__toolbar .el-button + .el-button {
  margin-left: 0;
}

.att__spacer {
  flex: 1;
}

/* 平板觸控：工具列控制項一律 44px 高 */
.touch.el-button {
  min-height: 44px;
  padding-right: 16px;
  padding-left: 16px;
}

.touch :deep(.el-input__wrapper),
.touch :deep(.el-select__wrapper),
.att__toolbar :deep(.att__date .el-input__wrapper) {
  min-height: 44px;
}

/* el-date-picker 的 class 由內層元素接收（沒有 scope 屬性），以 :deep 指定 */
.att__toolbar :deep(.att__date) {
  --el-date-editor-width: 160px;

  width: 160px;
  height: 44px;
}

.att__toolbar .att__class {
  width: 160px;
}

.att__toolbar .att__search {
  width: 180px;
}

.att__group-title {
  margin: 8px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.att__group-count {
  margin-left: 4px;
  font-size: 13px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.att__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.acard-skeleton {
  box-sizing: border-box;
  min-height: 148px;
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.batch-hint {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--el-color-primary-dark-2);
  background: var(--el-color-primary-light-9);
  border-radius: 6px;
}

.batch-hint .el-button {
  min-height: 44px;
}

/* 底部固定列：黏在內容區底緣，左右與底部延伸到主內容區的 padding 外緣 */
.batch-bar {
  position: sticky;
  bottom: calc(-1 * var(--att-gutter));
  z-index: 5;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 10px var(--att-gutter);
  margin: auto calc(-1 * var(--att-gutter)) calc(-1 * var(--att-gutter));
  background: var(--el-bg-color);
  border-top: 1px solid var(--el-border-color-light);
  box-shadow: var(--el-box-shadow-light);
}

.batch-bar__count {
  font-size: 15px;
  font-weight: 600;
}

.batch-bar .el-button {
  min-width: 112px;
  min-height: 44px;
  margin-left: 0;
}

.skipped-list {
  padding-left: 20px;
  margin: 8px 0 0;
  line-height: 1.9;
}
</style>
