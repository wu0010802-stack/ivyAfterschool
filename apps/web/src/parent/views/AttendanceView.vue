<script setup lang="ts">
/**
 * 出勤紀錄（/attendance，「更多」底下）：月份列 → 統計卡 → 單日明細卡 → 月曆卡 → 申請請假。
 * 版面、文案與互動以 docs/mockups/parent-page-attendance.html 為準。
 * 移植 ivy FE:src/parent/views/AttendanceView.vue 的 prevMonth / nextMonth / goToday 與 selectCell；
 * 去掉遲到等 ivy 狀態與 remark 欄位。
 *
 * - 月曆照後端出勤列顯示：未來的請假日沒有出勤列即「無紀錄」，家長到請假頁查看。
 * - 計入統計（in_stats）卻沒有出勤列、或今天以前仍是 expected 的日子，月曆與明細都是「未登記」，與統計卡一致。
 * - 資料以請求序號保護：換月份、換小孩、重試、下拉重新整理都會讓較舊的回應被丟棄。
 * - 「今天」以台北日期為準，在進入頁面時取一次。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ATTENDANCE_STATUS_META, LEAVE_TYPE_META, statusMeta, type StatusMeta } from '@/shared/constants/statusLabels'
import type { ISODate } from '@/shared/types/api'
import { formatDateWithWeekday, formatTime, monthOf, todayTaipei } from '@/shared/utils/datetime'
import { getChildAttendance, type AttendanceDay, type MonthlyAttendance } from '../api/attendance'
import AttendanceCalendar from '../components/attendance/AttendanceCalendar.vue'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import M3Button from '../components/m3/M3Button.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import M3IconButton from '../components/m3/M3IconButton.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import PullToRefresh from '../components/PullToRefresh.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'

type PillTone = StatusMeta['tone'] | 'neutral'

interface DayDetail {
  dateText: string
  isToday: boolean
  pill: { label: string; tone: PillTone } | null
  /** present / left / 今天的 expected：到班、離班時間（null 為「—」） */
  times: { checkIn: string; checkOut: string } | null
  /** leave：假別 */
  leaveType: string | null
  text: string
}

const UNRECORDED_PILL = { label: '未登記', tone: 'neutral' as const }

const children = useChildrenStore()
const snackbar = useSnackbarStore()
const router = useRouter()

const today: ISODate = todayTaipei()
const thisMonth = monthOf(today)

const monthKey = ref(thisMonth)
const selected = ref<ISODate | null>(today)
const status = ref<'loading' | 'ready' | 'error'>('loading')
const data = ref<MonthlyAttendance | null>(null)

// 每次載入 / 重新整理遞增；較舊請求的回應（序號不符）一律丟棄
let requestSeq = 0

// 沒有選中的小孩時不打 API：小孩清單載入中顯示骨架，載入失敗顯示錯誤，載入完成但沒有小孩則沒有出勤紀錄
const view = computed<'loading' | 'data' | 'empty' | 'error'>(() => {
  if (children.selectedId === null) {
    if (children.error && !children.loaded) return 'error'
    return children.loaded ? 'empty' : 'loading'
  }
  if (status.value === 'ready') return 'data'
  return status.value
})

const isThisMonth = computed(() => monthKey.value === thisMonth)
const monthTitle = computed(() => `${Number(monthKey.value.slice(0, 4))} 年 ${Number(monthKey.value.slice(5, 7))} 月`)
const days = computed(() => data.value?.days ?? [])

const statItems = computed(() => {
  const s = data.value?.stats
  if (!s) return []
  return [
    { key: 'service_days', label: '上課日', value: s.service_days },
    { key: 'attended', label: '出席', value: s.attended },
    { key: 'leave', label: '請假', value: s.leave },
    { key: 'absent', label: '缺席', value: s.absent },
    { key: 'unrecorded', label: '未登記', value: s.unrecorded },
  ]
})

/** 'MM/DD' */
function formatMD(date: ISODate): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`
}

/**
 * 統計卡下方小字：入班前的月份「這個月沒有出勤紀錄」；本月「統計到今天為止」，
 * 今天是營業日卻還沒到班（expected 或沒有出勤列）時說明它先算在未登記（數字照後端，純前端說明）；其他月份不顯示。
 */
const statsNote = computed(() => {
  const d = data.value
  if (!d) return ''
  if (d.stats.service_days === 0) return '這個月沒有出勤紀錄'
  if (!isThisMonth.value) return ''
  const t = d.days.find((x) => x.date === today)
  const pending = !!t && t.is_service_day && (t.status === 'expected' || t.status === null)
  const base = `統計到今天（${formatMD(today)}）為止`
  return pending ? `${base}；今天還沒到班，先算在「未登記」` : base
})

/** 單日明細（狀態判斷與 AttendanceCalendar 同一套規則，兩邊用詞一致） */
function describeDay(date: ISODate, info: AttendanceDay | undefined): DayDetail {
  const base: DayDetail = {
    dateText: formatDateWithWeekday(date),
    isToday: date === today,
    pill: null,
    times: null,
    leaveType: null,
    text: '',
  }
  if (info?.is_service_day === false) return { ...base, text: '安親班休息' }
  const dayStatus = info?.status ?? null
  if (!info || !dayStatus) {
    // 計入統計卻沒有出勤列：統計已把它算成未登記；其餘（今天以後、入學日以前）為無紀錄
    if (info?.in_stats) return { ...base, pill: UNRECORDED_PILL, text: '老師沒有登記這天的到班情形' }
    return { ...base, text: '這天沒有出勤紀錄' }
  }
  if (dayStatus === 'expected' && date < today) {
    return { ...base, pill: UNRECORDED_PILL, text: '老師沒有登記這天的到班情形' }
  }
  const meta = statusMeta(ATTENDANCE_STATUS_META, dayStatus)
  if (dayStatus === 'leave') {
    return { ...base, pill: meta, leaveType: info.leave_type ? statusMeta(LEAVE_TYPE_META, info.leave_type).label : '—' }
  }
  if (dayStatus === 'absent') return { ...base, pill: meta, text: '這天沒有到班，也沒有請假紀錄' }
  // present / left / 今天與之後的 expected
  return { ...base, pill: meta, times: { checkIn: formatTime(info.check_in_at), checkOut: formatTime(info.check_out_at) } }
}

const detail = computed<DayDetail | null>(() => {
  if (!selected.value || !data.value) return null
  const date = selected.value
  return describeDay(
    date,
    data.value.days.find((x) => x.date === date),
  )
})

async function load(): Promise<void> {
  const childId = children.selectedId
  const month = monthKey.value
  const seq = ++requestSeq
  status.value = 'loading'
  data.value = null
  if (childId === null) return
  try {
    const result = await getChildAttendance(childId, month)
    if (seq !== requestSeq) return
    data.value = result
    status.value = 'ready'
  } catch {
    if (seq === requestSeq) status.value = 'error'
  }
}

/** 下拉重新整理：重抓目前小孩與月份，期間保留現有內容；失敗只提示 */
async function refresh(): Promise<void> {
  const childId = children.selectedId
  if (childId === null) return
  const month = monthKey.value
  const seq = ++requestSeq
  try {
    const result = await getChildAttendance(childId, month)
    if (seq !== requestSeq) return
    data.value = result
    status.value = 'ready'
  } catch {
    if (seq === requestSeq) snackbar.show('更新失敗，請稍後再試', { tone: 'error' })
  }
}

function addMonths(month: string, delta: number): string {
  const year = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  const d = new Date(Date.UTC(year, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** 換月份：顯示本月則預設選中今天，否則不選 */
function setMonth(month: string): void {
  monthKey.value = month
  selected.value = month === thisMonth ? today : null
  void load()
}

function shiftMonth(delta: number): void {
  if (delta > 0 && isThisMonth.value) return
  setMonth(addMonths(monthKey.value, delta))
}

function goThisMonth(): void {
  if (isThisMonth.value) return
  setMonth(thisMonth)
}

function onSelectDay(date: string): void {
  selected.value = date
}

function retry(): void {
  if (children.selectedId === null) void children.load(true)
  else void load()
}

function goLeaves(): void {
  void router.push('/leaves')
}

// 換小孩保留目前月份與選中日
watch(() => children.selectedId, load, { immediate: true })

onMounted(() => {
  void children.load()
})
</script>

<template>
  <div class="attendance-view">
    <PullToRefresh
      :on-refresh="refresh"
      :disabled="view === 'loading'"
    >
      <div class="page-stack">
        <ChildContextHeader
          :children="children.items"
          :selected-id="children.selectedId"
          @select="children.select"
        />

        <div
          class="att-month"
          role="group"
          aria-label="切換月份"
        >
          <M3IconButton
            icon="chevron_left"
            label="上個月"
            @click="shiftMonth(-1)"
          />
          <h2
            class="att-month__title m3-title-medium"
            aria-live="polite"
          >
            {{ monthTitle }}
          </h2>
          <M3IconButton
            icon="chevron_right"
            label="下個月"
            :disabled="isThisMonth"
            @click="shiftMonth(1)"
          />
          <span class="att-month__spacer" />
          <M3Button
            variant="text"
            icon="today"
            :disabled="isThisMonth"
            @click="goThisMonth"
          >
            本月
          </M3Button>
        </div>

        <template v-if="view === 'data'">
          <M3Card
            variant="outlined"
            padding="none"
          >
            <dl class="att-stats">
              <div
                v-for="s in statItems"
                :key="s.key"
                class="att-stat"
              >
                <dt class="m3-label-medium">
                  {{ s.label }}
                </dt>
                <dd class="m3-title-large">
                  {{ s.value }}
                </dd>
              </div>
            </dl>
            <p
              v-if="statsNote"
              class="att-stats__note m3-body-small"
            >
              {{ statsNote }}
            </p>
          </M3Card>

          <M3Card
            variant="outlined"
            class="att-detail"
            aria-live="polite"
          >
            <template v-if="detail">
              <div class="att-detail__head">
                <span class="att-detail__date m3-title-medium">{{ detail.dateText }}</span>
                <span
                  v-if="detail.isToday"
                  class="att-detail__today m3-label-medium"
                >今天</span>
                <StatusPill
                  v-if="detail.pill"
                  class="att-detail__pill"
                  :label="detail.pill.label"
                  :tone="detail.pill.tone"
                />
              </div>
              <div class="att-detail__body m3-body-medium">
                <template v-if="detail.times">
                  <span class="att-detail__item">
                    <M3Icon
                      name="login"
                      :size="18"
                    />
                    <span>到班 {{ detail.times.checkIn }}</span>
                  </span>
                  <span class="att-detail__item">
                    <M3Icon
                      name="logout"
                      :size="18"
                    />
                    <span>離班 {{ detail.times.checkOut }}</span>
                  </span>
                </template>
                <span
                  v-else-if="detail.leaveType"
                  class="att-detail__item"
                >
                  <M3Icon
                    name="event_busy"
                    :size="18"
                  />
                  <span>假別 {{ detail.leaveType }}</span>
                </span>
                <span
                  v-else
                  class="att-detail__text"
                >{{ detail.text }}</span>
              </div>
            </template>
            <template v-else>
              <div class="att-detail__head">
                <span class="att-detail__date att-detail__date--muted m3-title-medium">未選擇日期</span>
              </div>
              <div class="att-detail__body m3-body-medium">
                <span class="att-detail__text">點月曆上的日期，查看當天的到班、離班時間</span>
              </div>
            </template>
          </M3Card>

          <M3Card
            variant="outlined"
            padding="none"
            class="att-cal-card"
          >
            <AttendanceCalendar
              :month="monthKey"
              :days="days"
              :today="today"
              :selected-date="selected"
              @select="onSelectDay"
            />
          </M3Card>

          <M3Button
            variant="tonal"
            icon="edit_calendar"
            block
            @click="goLeaves"
          >
            申請請假
          </M3Button>
        </template>
        <template v-else-if="view === 'loading'">
          <SkeletonBlock
            variant="card"
            :count="2"
          />
          <SkeletonBlock
            variant="card"
            height="360px"
          />
        </template>
        <ParentEmptyState
          v-else-if="view === 'error'"
          variant="error"
          title="出勤紀錄載入失敗"
          @action="retry"
        />
        <ParentEmptyState
          v-else
          icon="calendar_month"
          title="目前沒有出勤紀錄"
        />
      </div>
    </PullToRefresh>
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、底部 24px 內距（ParentLayout 不再加） */
.attendance-view {
  padding: 0 16px 24px;
}

/* PARENT-207：月曆卡內距上下 12px、左右 8px，360 寬時月曆格寬仍 ≥ 44px（其他卡片維持 M3Card 的內距）；
   加 .m3-card 提高權重，不依賴 M3Card 與本頁樣式的載入順序 */
.m3-card.att-cal-card {
  padding: 12px 8px;
}

.page-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}

/* 月份列：‹ 月份 › …… 本月 */
.att-month {
  display: flex;
  align-items: center;
  margin: -4px -4px;
}

/* 固定最小寬度置中：切換 9 / 10 月時箭頭不跳動 */
.att-month__title {
  min-width: 7.5em;
  margin: 0;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.att-month__spacer {
  flex: 1;
}

/* 統計卡：5 欄等寬，dt 標籤 / dd 數字，欄間 1px 分隔線 */
.att-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 0;
  padding: 12px 0;
}

.att-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 0;
}

.att-stat + .att-stat {
  border-left: 1px solid var(--m3-outline-variant);
}

.att-stat dt {
  color: var(--m3-on-surface-variant);
  white-space: nowrap;
}

.att-stat dd {
  margin: 0;
  color: var(--m3-on-surface);
  font-variant-numeric: tabular-nums;
}

.att-stats__note {
  margin: 0;
  padding: 8px 16px 12px;
  border-top: 1px solid var(--m3-outline-variant);
  color: var(--m3-on-surface-variant);
  text-align: center;
}

/* 單日明細卡：固定兩行高，點不同日子時下方月曆不會跳動 */
.att-detail {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-height: 92px;
}

.att-detail__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
}

.att-detail__date {
  font-variant-numeric: tabular-nums;
}

.att-detail__date--muted {
  color: var(--m3-on-surface-variant);
}

.att-detail__today {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--m3-shape-extra-small);
  box-shadow: inset 0 0 0 1px var(--m3-primary);
  color: var(--m3-primary);
}

.att-detail__pill {
  margin-left: auto;
}

.att-detail__body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 24px;
  min-height: 24px;
}

.att-detail__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--m3-on-surface);
  font-variant-numeric: tabular-nums;
}

.att-detail__item .m3-icon {
  color: var(--m3-on-surface-variant);
}

.att-detail__text {
  color: var(--m3-on-surface-variant);
}
</style>
