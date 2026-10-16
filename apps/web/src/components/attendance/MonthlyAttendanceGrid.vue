<script setup lang="ts">
// FRONTEND-128：月出勤報表的日期 × 學生格狀表。設計稿：docs/mockups/page-attendance-monthly.html（MonthlyAttendanceGrid 段）。
// - 左側固定學號 / 姓名 / 班級，中間每日一欄（32px、表頭「日」/「週」），右側固定出席 / 缺席 / 請假 / 未登記。
// - 表格一律固定高度（max-height 撐滿可視區，視窗 resize 時重算）+ 捲動：表頭、左右固定欄與合計列不動；學生多時也不做虛擬捲動。
// - 符號：present ● / left ✓ / absent ✕ / leave 假 / expected ○；null 且營業日 —；null 且非營業日留白（整欄灰底）。
// - 合計列：學號欄「合計」、每日欄 = 當天 present + left 人數（只算不晚於今天的營業日）、統計欄 = totals。
// - 統計欄可點表頭前端排序（升冪 / 降冪 / 取消），其他欄維持後端順序（學號）。
import type { TableColumnCtx } from 'element-plus'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { MonthDay, MonthlyAttendance, MonthlyStats, MonthlyStudentRow } from '@/api/attendance'
import { ATTENDANCE_STATUS_META } from '@/shared/constants/statusLabels'
import type { AttendanceStatus } from '@/shared/types/api'
import { todayTaipei } from '@/shared/utils/datetime'

const props = withDefaults(
  defineProps<{
    data: MonthlyAttendance
    /** YYYY-MM-DD，預設台北今天 */
    today?: string
    /** view 選了班級時為 true */
    hideClassColumn?: boolean
    /** 重抓時保留舊表格並蓋 loading 遮罩 */
    loading?: boolean
  }>(),
  { today: () => todayTaipei(), hideClassColumn: false, loading: false },
)

type StatKey = Exclude<keyof MonthlyStats, 'service_days'>

/** MonthDay.weekday：0 = 週一 */
const WEEKDAY = ['一', '二', '三', '四', '五', '六', '日'] as const
const STATUS_SYMBOL: Record<AttendanceStatus, string> = {
  present: '●',
  left: '✓',
  absent: '✕',
  leave: '假',
  expected: '○',
}
const STAT_COLUMNS: { key: StatKey; label: string }[] = [
  { key: 'attended', label: '出席' },
  { key: 'absent', label: '缺席' },
  { key: 'leave', label: '請假' },
  { key: 'unrecorded', label: '未登記' },
]
const DAY_PROP_PREFIX = 'day_'
/** 表格底部到視窗底部的留白（頁面 padding + 面板 padding） */
const BOTTOM_GAP = 40
const MIN_TABLE_HEIGHT = 240

const tableWrap = ref<HTMLElement | null>(null)
const maxHeight = ref(MIN_TABLE_HEIGHT)

function fitViewport(): void {
  const top = tableWrap.value?.getBoundingClientRect().top ?? 0
  maxHeight.value = Math.max(MIN_TABLE_HEIGHT, Math.floor(window.innerHeight - top - BOTTOM_GAP))
}

onMounted(() => {
  fitViewport()
  window.addEventListener('resize', fitViewport)
})
onBeforeUnmount(() => window.removeEventListener('resize', fitViewport))

function isFuture(d: MonthDay): boolean {
  return d.date > props.today
}

function dayClass(d: MonthDay): string {
  const classes = ['mg-day']
  if (!d.is_service_day) classes.push('is-closed')
  if (d.date === props.today) classes.push('is-today')
  if (isFuture(d)) classes.push('is-future')
  return classes.join(' ')
}

function dayNumber(d: MonthDay): number {
  return Number(d.date.slice(8, 10))
}

/** 非營業日且沒有狀態：整格留白（灰底由欄 class 提供） */
function showMark(d: MonthDay, status: AttendanceStatus | null): boolean {
  return status !== null || d.is_service_day
}

function markText(status: AttendanceStatus | null): string {
  return status ? STATUS_SYMBOL[status] : '—'
}

function markClass(status: AttendanceStatus | null): string[] {
  if (!status) return ['is-none']
  const classes = [`tone-${ATTENDANCE_STATUS_META[status].tone}`]
  if (status === 'leave') classes.push('is-leave')
  return classes
}

function cellTitle(row: MonthlyStudentRow, d: MonthDay, status: AttendanceStatus | null): string {
  let what: string
  if (status) what = ATTENDANCE_STATUS_META[status].label + (status === 'expected' ? '（未點名）' : '')
  else what = isFuture(d) ? '尚未到' : '無紀錄'
  return `${d.date.slice(5, 7)}/${d.date.slice(8, 10)}（${WEEKDAY[d.weekday] ?? ''}）${row.name}：${what}`
}

function statClass(key: StatKey, value: number): string {
  if (value === 0) return 'is-zero'
  if (key === 'absent') return 'tone-danger'
  if (key === 'unrecorded') return 'tone-warning'
  return ''
}

function sortBy(key: StatKey): (a: MonthlyStudentRow, b: MonthlyStudentRow) => number {
  return (a, b) => a.stats[key] - b.stats[key]
}

function isStatKey(prop: string): prop is StatKey {
  return STAT_COLUMNS.some((c) => c.key === prop)
}

function attendedOn(index: number): string {
  const d = props.data.days[index]
  if (!d || !d.is_service_day || isFuture(d)) return ''
  const count = props.data.students.filter((s) => s.statuses[index] === 'present' || s.statuses[index] === 'left').length
  return String(count)
}

function summary({ columns }: { columns: TableColumnCtx<MonthlyStudentRow>[] }): string[] {
  return columns.map((column) => {
    const prop = column.property
    if (prop === 'student_no') return '合計'
    if (prop?.startsWith(DAY_PROP_PREFIX)) return attendedOn(Number(prop.slice(DAY_PROP_PREFIX.length)))
    if (prop && isStatKey(prop)) return String(props.data.totals[prop])
    return ''
  })
}
</script>

<template>
  <div class="mg">
    <div
      class="mg-legend"
      aria-label="圖例"
    >
      <span class="mg-legend__item"><span class="mg-mark tone-success">●</span>已到班</span>
      <span class="mg-legend__item"><span class="mg-mark tone-info">✓</span>已離班</span>
      <span class="mg-legend__item"><span class="mg-mark tone-danger">✕</span>缺席</span>
      <span class="mg-legend__item"><span class="mg-mark tone-info is-leave">假</span>請假</span>
      <span class="mg-legend__item"><span class="mg-mark tone-warning">○</span>預計到班（未點名）</span>
      <span class="mg-legend__item"><span class="mg-mark is-none">—</span>無紀錄 / 尚未到</span>
      <span class="mg-legend__item"><span class="mg-legend__swatch is-closed" />非營業日</span>
      <span class="mg-legend__item"><span class="mg-legend__swatch is-today" />今天</span>
    </div>
    <div
      ref="tableWrap"
      data-test="mg-table-wrap"
    >
      <el-table
        v-loading="loading"
        class="mg-table"
        :data="data.students"
        row-key="student_id"
        border
        size="small"
        :max-height="maxHeight"
        show-summary
        :summary-method="summary"
      >
        <el-table-column
          prop="student_no"
          label="學號"
          width="76"
          fixed="left"
        />
        <el-table-column
          prop="name"
          label="姓名"
          width="80"
          fixed="left"
          show-overflow-tooltip
        />
        <!-- @vue-generic {MonthlyStudentRow} -->
        <el-table-column
          v-if="!hideClassColumn"
          prop="class_name"
          label="班級"
          width="96"
          fixed="left"
          show-overflow-tooltip
        >
          <template #default="{ row }: { row: MonthlyStudentRow }">
            {{ row.class_name ?? '未分班' }}
          </template>
        </el-table-column>
        <!-- @vue-generic {MonthlyStudentRow} -->
        <el-table-column
          v-for="(d, i) in data.days"
          :key="d.date"
          :prop="`${DAY_PROP_PREFIX}${i}`"
          width="32"
          align="center"
          :class-name="dayClass(d)"
        >
          <template #header>
            <div class="mg-day-head">
              <span>{{ dayNumber(d) }}</span>
              <span class="mg-day-head__wk">{{ WEEKDAY[d.weekday] }}</span>
            </div>
          </template>
          <template #default="{ row }: { row: MonthlyStudentRow }">
            <span
              v-if="showMark(d, row.statuses[i] ?? null)"
              class="mg-mark"
              :class="markClass(row.statuses[i] ?? null)"
              :title="cellTitle(row, d, row.statuses[i] ?? null)"
            >{{ markText(row.statuses[i] ?? null) }}</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {MonthlyStudentRow} -->
        <el-table-column
          v-for="c in STAT_COLUMNS"
          :key="c.key"
          :prop="c.key"
          :label="c.label"
          width="64"
          fixed="right"
          align="center"
          class-name="mg-stat-col"
          sortable
          :sort-method="sortBy(c.key)"
        >
          <template #default="{ row }: { row: MonthlyStudentRow }">
            <span
              class="mg-stat"
              :class="statClass(c.key, row.stats[c.key])"
            >{{ row.stats[c.key] }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.mg-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  align-items: center;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.mg-legend__item {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.mg-legend__swatch {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 3px;
}

.mg-legend__swatch.is-closed {
  background: var(--el-fill-color-light);
}

.mg-legend__swatch.is-today {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
}

.mg-table {
  --el-table-header-bg-color: var(--el-bg-color);
}

.mg-table :deep(th.el-table__cell) {
  font-weight: 600;
}

.mg-table :deep(.mg-day > .cell) {
  padding: 0 2px;
}

.mg-day-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1.3;
}

.mg-day-head__wk {
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

/* 非營業日整欄（含表頭）灰底、日期轉淡 */
.mg-table :deep(.mg-day.is-closed) {
  background: var(--el-fill-color-light);
}

.mg-table :deep(.mg-day.is-closed .mg-day-head) {
  color: var(--el-text-color-placeholder);
}

/* 今天：表頭主色淡底 + 主色粗體 + 底線，整欄淡底 */
.mg-table :deep(th.mg-day.is-today) {
  background: var(--el-color-primary-light-9);
  box-shadow: inset 0 -2px 0 var(--el-color-primary);
}

.mg-table :deep(th.mg-day.is-today .mg-day-head),
.mg-table :deep(th.mg-day.is-today .mg-day-head__wk) {
  font-weight: 700;
  color: var(--el-color-primary);
}

.mg-table :deep(td.mg-day.is-today) {
  background: var(--el-color-primary-light-9);
}

/* 未來日期內容 40% 透明 */
.mg-table :deep(.mg-day.is-future > .cell) {
  opacity: 0.4;
}

.mg-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 13px;
  line-height: 1;
  cursor: default;
}

.mg-mark.tone-success {
  color: var(--el-color-success);
}

.mg-mark.tone-warning {
  font-weight: 700;
  color: var(--el-color-warning);
}

.mg-mark.tone-danger {
  font-weight: 700;
  color: var(--el-color-danger);
}

.mg-mark.tone-info {
  color: var(--el-color-info);
}

/* 請假：淡灰底小方塊，與 ✓ 區隔 */
.mg-mark.is-leave {
  font-size: 12px;
  color: var(--el-color-info-dark-2);
  background: var(--el-color-info-light-9);
  border-radius: 4px;
}

.mg-mark.is-none {
  color: var(--el-text-color-placeholder);
}

.mg-stat {
  font-variant-numeric: tabular-nums;
}

.mg-stat.is-zero {
  color: var(--el-text-color-placeholder);
}

.mg-stat.tone-danger {
  font-weight: 600;
  color: var(--el-color-danger);
}

.mg-stat.tone-warning {
  font-weight: 600;
  color: var(--el-color-warning-dark-2);
}

.mg-table :deep(.el-table__footer-wrapper td.el-table__cell) {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  background: var(--el-fill-color-light);
}

.mg-table :deep(.el-table__footer-wrapper td.mg-day > .cell) {
  font-size: 12px;
  font-weight: 500;
  color: var(--el-text-color-regular);
}
</style>
