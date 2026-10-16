<script setup lang="ts">
// FRONTEND-127：月出勤報表與匯出（/attendance/monthly，attendance:read）。設計稿：docs/mockups/page-attendance-monthly.html。
// 移植 ivy FE:src/views/StudentAttendanceView.vue 的 fetchMonthly + downloadFile 匯出流程；去掉圖表、學期、連缺告警、
// 出席率卡與前端姓名搜尋。月份與班級存在網址 query（month、class_id），改任一個立即重抓；
// 重抓期間保留舊表格並蓋 loading（不閃回 skeleton）。篩選列沿用 AdminListToolbar 的版面樣式，但本頁沒有關鍵字搜尋，不使用該元件。
// 合計列的「營業日」以 days 計算：totals.service_days 是全部學生應出勤日的加總（應出勤人次），不是營業日數。
import { Calendar, Download, QuestionFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import {
  exportMonthlyAttendance,
  fetchMonthlyAttendance,
  type MonthlyAttendance,
  type MonthlyAttendanceParams,
} from '@/api/attendance'
import MonthlyAttendanceGrid from '@/components/attendance/MonthlyAttendanceGrid.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import { saveBlobResponse } from '@/shared/http/download'
import { monthOf, todayTaipei } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'
import { useLookupsStore } from '@/stores/lookups'

interface MonthlyFilters {
  month: string
  /** null = 全部班級 */
  classId: string | null
}

/** el-select 把空字串當成「未選」，「全部」用哨兵值 */
const ALL = '__all__'
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

const route = useRoute()
const router = useRouter()
const lookups = useLookupsStore()

const today = todayTaipei()
const currentMonth = monthOf(today)
const todayLabel = `${today.slice(5, 7)}/${today.slice(8, 10)}`

lookups.ensure('classes').catch(() => {
  // 班級清單載入失敗時下拉只剩「全部」，報表照常可看
})

/** 格式不對或晚於本月 → null（改用本月） */
function parseMonth(value: unknown): string | null {
  return typeof value === 'string' && MONTH_RE.test(value) && value <= currentMonth ? value : null
}

function parseClassId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

const filters = computed<MonthlyFilters>(() => ({
  month: parseMonth(route.query.month) ?? currentMonth,
  classId: parseClassId(route.query.class_id),
}))

function setFilters(patch: Partial<MonthlyFilters>): void {
  const next = { ...filters.value, ...patch }
  const query: LocationQueryRaw = { ...route.query, month: next.month }
  if (next.classId) query.class_id = next.classId
  else delete query.class_id
  void router.replace({ query })
}

const month = computed({
  get: () => filters.value.month,
  set: (v: string) => setFilters({ month: v }),
})
const classSelection = computed({
  get: () => filters.value.classId ?? ALL,
  set: (v: string) => setFilters({ classId: v === ALL ? null : v }),
})
const classOptions = computed(() => lookups.classOptions())

function isFutureMonth(d: Date): boolean {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` > currentMonth
}

function queryParams(): MonthlyAttendanceParams {
  const { month: m, classId } = filters.value
  return classId ? { month: m, class_id: classId } : { month: m }
}

const report = shallowRef<MonthlyAttendance | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
let loadSeq = 0

async function load(): Promise<void> {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = null
  try {
    const res = await fetchMonthlyAttendance(queryParams())
    if (seq === loadSeq) report.value = res
  } catch (err) {
    if (seq === loadSeq) loadError.value = errorMessage(err, '請稍後再試一次')
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch([() => filters.value.month, () => filters.value.classId], () => void load(), { immediate: true })

const hasStudents = computed(() => (report.value?.students.length ?? 0) > 0)
const initialLoading = computed(() => loading.value && report.value === null)
const refetching = computed(() => loading.value && report.value !== null)

const serviceDayCount = computed(() => report.value?.days.filter((d) => d.is_service_day).length ?? 0)
const isCurrentMonth = computed(() => report.value?.month === currentMonth)
const elapsedServiceDays = computed(
  () => report.value?.days.filter((d) => d.is_service_day && d.date <= today).length ?? 0,
)

/** 選了班級時的班級名稱：以回應為準，回應尚未帶到時查 lookups */
const selectedClassName = computed<string | null>(() => {
  const classId = filters.value.classId
  if (!classId) return null
  if (report.value?.class_id === classId && report.value.class_name) return report.value.class_name
  return classOptions.value.find((o) => o.value === classId)?.label ?? null
})

function monthLabel(ym: string): string {
  return `${ym.slice(0, 4)} 年 ${Number(ym.slice(5, 7))} 月`
}

const emptyDescription = computed(
  () => `${selectedClassName.value ?? '全部班級'}在 ${monthLabel(report.value?.month ?? filters.value.month)}沒有學生與出勤紀錄`,
)

// ---- 匯出 ----
const exporting = ref(false)
const canExport = computed(() => hasStudents.value && !loading.value && loadError.value === null)

async function exportExcel(): Promise<void> {
  if (!canExport.value || exporting.value) return
  const params = queryParams()
  const fallback = `出勤月報_${params.class_id ? (selectedClassName.value ?? '班級') : '全部'}_${params.month}.xlsx`
  exporting.value = true
  try {
    saveBlobResponse(await exportMonthlyAttendance(params), fallback)
  } catch (err) {
    ElMessage.error(errorMessage(err, '匯出失敗，請稍後再試'))
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="monthly-page">
    <PageHeader
      title="月出勤報表"
      subtitle="每位學生每天的出勤狀態與本月統計"
    >
      <template #actions>
        <el-button
          :loading="exporting"
          :icon="exporting ? undefined : Download"
          :disabled="!canExport"
          @click="exportExcel"
        >
          {{ exporting ? '匯出中…' : '匯出 Excel' }}
        </el-button>
      </template>
    </PageHeader>

    <section class="monthly-page__panel">
      <div class="list-toolbar">
        <div
          class="list-toolbar__filter"
          data-test="filter-month"
        >
          <span class="list-toolbar__filter-label">月份</span>
          <el-date-picker
            v-model="month"
            class="monthly-page__month"
            type="month"
            value-format="YYYY-MM"
            format="YYYY 年 M 月"
            :clearable="false"
            :disabled-date="isFutureMonth"
            aria-label="月份"
          />
        </div>
        <div
          class="list-toolbar__filter"
          data-test="filter-class"
        >
          <span class="list-toolbar__filter-label">班級</span>
          <el-select
            v-model="classSelection"
            class="monthly-page__class"
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
        <span class="list-toolbar__spacer" />
        <span
          v-if="report && hasStudents && loadError === null"
          class="list-toolbar__count"
          data-test="student-count"
        >共 {{ report.students.length }} 位學生</span>
      </div>

      <EmptyState
        v-if="loadError !== null"
        variant="error"
        title="無法載入出勤月報"
        :description="loadError"
      >
        <template #action>
          <el-button @click="load">
            重試
          </el-button>
        </template>
      </EmptyState>

      <div
        v-else-if="initialLoading"
        class="monthly-page__skeleton"
        aria-busy="true"
      >
        <el-skeleton animated>
          <template #template>
            <el-skeleton-item
              class="monthly-page__skeleton-bar"
              variant="rect"
            />
          </template>
        </el-skeleton>
        <el-skeleton
          :rows="8"
          animated
        />
      </div>

      <EmptyState
        v-else-if="report && !hasStudents"
        :icon="Calendar"
        title="此月份沒有出勤資料"
        :description="emptyDescription"
      />

      <template v-else-if="report">
        <div
          class="mr-summary"
          role="group"
          aria-label="本月合計"
          data-test="monthly-summary"
        >
          <span class="mr-summary__item"><span class="mr-summary__label">營業日</span> <span class="mr-summary__value">{{ serviceDayCount }}</span> <span class="mr-summary__unit">天<template v-if="isCurrentMonth">（統計到 {{ todayLabel }}，已過 {{ elapsedServiceDays }} 天）</template></span></span>
          <span class="mr-summary__item">
            <span class="mr-summary__label">應出勤</span> <span class="mr-summary__value">{{ report.totals.service_days }}</span> <span class="mr-summary__unit">人次</span>
            <el-tooltip
              placement="top"
              :show-after="200"
              content="每位學生在本月（到今天為止、入班日之後）的營業日數加總；出席 + 缺席 + 請假 + 未登記 = 應出勤"
            >
              <el-icon
                class="mr-summary__help"
                aria-label="應出勤的算法"
                tabindex="0"
              ><QuestionFilled /></el-icon>
            </el-tooltip>
          </span>
          <span class="mr-summary__item"><span class="mr-summary__label">出席</span> <span class="mr-summary__value tone-success">{{ report.totals.attended }}</span> <span class="mr-summary__unit">人次</span></span>
          <span class="mr-summary__item"><span class="mr-summary__label">缺席</span> <span :class="['mr-summary__value', { 'tone-danger': report.totals.absent > 0 }]">{{ report.totals.absent }}</span> <span class="mr-summary__unit">人次</span></span>
          <span class="mr-summary__item"><span class="mr-summary__label">請假</span> <span class="mr-summary__value">{{ report.totals.leave }}</span> <span class="mr-summary__unit">人次</span></span>
          <span class="mr-summary__item"><span class="mr-summary__label">未登記</span> <span :class="['mr-summary__value', { 'tone-warning': report.totals.unrecorded > 0 }]">{{ report.totals.unrecorded }}</span> <span class="mr-summary__unit">人次</span></span>
        </div>

        <MonthlyAttendanceGrid
          :data="report"
          :today="today"
          :hide-class-column="filters.classId !== null"
          :loading="refetching"
        />
      </template>
    </section>
  </div>
</template>

<style scoped>
.monthly-page__panel {
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

/* el-date-picker 的根節點不帶本元件的 scoped 屬性，從工具列往下選 */
.list-toolbar :deep(.monthly-page__month.el-date-editor) {
  width: 150px;
}

.monthly-page__class {
  width: 150px;
}

.monthly-page__skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.monthly-page__skeleton-bar {
  width: 100%;
  height: 44px;
  border-radius: 6px;
}

/* 本月合計列 */
.mr-summary {
  display: flex;
  flex-wrap: wrap;
  row-gap: 8px;
  align-items: center;
  padding: 10px 4px;
  margin-bottom: 12px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}

.mr-summary__item {
  display: inline-flex;
  gap: 6px;
  align-items: baseline;
  padding: 0 14px;
  white-space: nowrap;
  border-left: 1px solid var(--el-border-color);
}

.mr-summary__item:first-child {
  border-left: none;
}

.mr-summary__label {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.mr-summary__value {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  color: var(--el-text-color-primary);
}

.mr-summary__value.tone-success {
  color: var(--el-color-success-dark-2);
}

.mr-summary__value.tone-warning {
  color: var(--el-color-warning-dark-2);
}

.mr-summary__value.tone-danger {
  color: var(--el-color-danger);
}

.mr-summary__unit {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.mr-summary__help {
  align-self: center;
  font-size: 14px;
  color: var(--el-text-color-placeholder);
  cursor: help;
}
</style>
