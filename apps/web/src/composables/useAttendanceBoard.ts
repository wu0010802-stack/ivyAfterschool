// FRONTEND-126：今日出勤頁（FRONTEND-122）的資料擁有者：載入每日清單、逐生操作、批次到班與 ws 即時合併。
// - date / classId 變更時重新載入；以序號防護，只採用最新一次請求的回應。
// - summary 一律由 items 重算（total = 列數、各狀態計數），與後端未帶 status 篩選時一致。
// - 同一學生操作進行中再呼叫直接忽略；失敗以 ElMessage 提示後端訊息，畫面過期類的 409 另重抓當日資料。
// - ws（FRONTEND-038）：attendance.updated / batch_updated 只合併「同日且（全部班級或同班）」的列，
//   不在清單中的列依班級（沿用清單既有的班級順序）與學號插入；bulk_updated 的 dates 含目前日期時重抓。
//   改判過去日期也會推播，所以不論 date 是否為今天都訂閱。
import { ElMessage } from 'element-plus'
import { ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import {
  batchCheckIn as apiBatchCheckIn,
  checkIn as apiCheckIn,
  checkOut as apiCheckOut,
  fetchDailyAttendance,
  markAbsent as apiMarkAbsent,
  type AttendanceRow,
  type BatchCheckInResult,
  type DailyAttendance,
  type DailyAttendanceParams,
  type DailySummary,
} from '@/api/attendance'
import { isApiError } from '@/shared/types/api'
import { errorMessage } from '@/shared/utils/errorMessage'
import type { WsStatus } from '@/shared/ws/createWsClient'
import { useAdminWsTopic } from './useAdminWsTopic'

export interface AttendanceBoardParams {
  date: Ref<string>
  /** null（或空字串）= 全部班級 */
  classId: Ref<string | null>
}

export interface AttendanceBoard {
  data: Ref<DailyAttendance | null>
  loading: Ref<boolean>
  /** 最近一次載入失敗的訊息；成功後清為 null */
  error: Ref<string | null>
  /** 操作中的 student_id */
  busyIds: Ref<ReadonlySet<string>>
  reload(): Promise<void>
  checkIn(row: AttendanceRow): Promise<void>
  checkOut(row: AttendanceRow): Promise<void>
  markAbsent(row: AttendanceRow): Promise<void>
  /** 成功列直接套用；失敗時已以 ElMessage 提示，並 reject 原錯誤（呼叫端只需決定畫面狀態） */
  batchCheckIn(studentIds: string[]): Promise<BatchCheckInResult>
  /** 以 student_id 取代（不在清單中則依班級、學號插入）並重算 summary；與目前資料不同日的列忽略 */
  applyRow(row: AttendanceRow): void
  wsStatus: ComputedRef<WsStatus>
  wsDenied: ComputedRef<boolean>
}

/** 代表畫面已過期的錯誤碼：重抓當日資料修正 */
const STALE_CODES = new Set(['already_checked_in', 'already_checked_out', 'not_checked_in', 'student_on_leave'])

function summarize(items: AttendanceRow[]): DailySummary {
  const summary: DailySummary = { total: items.length, expected: 0, present: 0, left: 0, absent: 0, leave: 0 }
  for (const row of items) summary[row.status] += 1
  return summary
}

/**
 * 新列插入位置：同班最後一位學號不大於它的學生之後；清單中沒有該班時接在最後。
 * 班級之間的順序沿用後端（班級 sort_order、班名），所以只在既有分組內比學號。
 */
function insertionIndex(items: AttendanceRow[], row: AttendanceRow): number {
  let afterLastOfClass = -1
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    if (item.class_id !== row.class_id) continue
    if (item.student_no > row.student_no) return i
    afterLastOfClass = i + 1
  }
  return afterLastOfClass >= 0 ? afterLastOfClass : items.length
}

function isStale(err: unknown): boolean {
  return isApiError(err) && err.status === 409 && STALE_CODES.has(err.code)
}

export function useAttendanceBoard(params: AttendanceBoardParams): AttendanceBoard {
  const { date, classId } = params
  const data = shallowRef<DailyAttendance | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const busyIds = shallowRef<ReadonlySet<string>>(new Set())

  let seq = 0
  /** data 對應的篩選；載入失敗時若篩選已換，就不再顯示別的篩選的舊資料 */
  let loadedKey: string | null = null

  const currentClassId = (): string | null => classId.value || null
  const filterKey = (): string => `${date.value}|${currentClassId() ?? ''}`

  async function reload(): Promise<void> {
    const mySeq = ++seq
    const key = filterKey()
    const cls = currentClassId()
    const query: DailyAttendanceParams = cls ? { date: date.value, class_id: cls } : { date: date.value }
    loading.value = true
    try {
      const res = await fetchDailyAttendance(query)
      if (mySeq !== seq) return
      data.value = { ...res, summary: summarize(res.items) }
      loadedKey = key
      error.value = null
    } catch (err) {
      if (mySeq !== seq) return
      error.value = errorMessage(err, '無法載入出勤資料')
      if (loadedKey !== key) {
        data.value = null
        loadedKey = null
      }
    } finally {
      if (mySeq === seq) loading.value = false
    }
  }

  function applyRows(rows: AttendanceRow[]): void {
    const current = data.value
    if (!current) return
    const items = [...current.items]
    let changed = false
    for (const row of rows) {
      if (row.service_date !== current.date) continue
      const index = items.findIndex((r) => r.student_id === row.student_id)
      if (index >= 0) items[index] = row
      else items.splice(insertionIndex(items, row), 0, row)
      changed = true
    }
    if (changed) data.value = { ...current, items, summary: summarize(items) }
  }

  function applyRow(row: AttendanceRow): void {
    applyRows([row])
  }

  function setBusy(studentId: string, busy: boolean): void {
    const next = new Set(busyIds.value)
    if (busy) next.add(studentId)
    else next.delete(studentId)
    busyIds.value = next
  }

  async function operate(row: AttendanceRow, call: (studentId: string) => Promise<AttendanceRow>): Promise<void> {
    const studentId = row.student_id
    if (busyIds.value.has(studentId)) return
    setBusy(studentId, true)
    try {
      applyRow(await call(studentId))
    } catch (err) {
      ElMessage.error(errorMessage(err, '操作失敗'))
      if (isStale(err)) await reload()
    } finally {
      setBusy(studentId, false)
    }
  }

  async function batchCheckIn(studentIds: string[]): Promise<BatchCheckInResult> {
    let result: BatchCheckInResult
    try {
      result = await apiBatchCheckIn(studentIds)
    } catch (err) {
      ElMessage.error(errorMessage(err, '批次到班失敗'))
      if (isStale(err)) void reload()
      throw err
    }
    applyRows(result.succeeded)
    if (result.skipped.some((s) => STALE_CODES.has(s.code))) void reload()
    return result
  }

  function matchesFilter(row: AttendanceRow): boolean {
    const cls = currentClassId()
    return row.service_date === date.value && (cls === null || row.class_id === cls)
  }

  const ws = useAdminWsTopic(
    'attendance',
    {
      'attendance.updated': (row: AttendanceRow) => {
        if (matchesFilter(row)) applyRow(row)
      },
      'attendance.batch_updated': (payload: { items?: AttendanceRow[] }) => {
        const items = Array.isArray(payload?.items) ? payload.items : []
        applyRows(items.filter(matchesFilter))
      },
      'attendance.bulk_updated': (payload: { student_id?: string; dates?: string[] }) => {
        if (Array.isArray(payload?.dates) && payload.dates.includes(date.value)) void reload()
      },
    },
    { resync: reload },
  )

  watch([date, classId], () => void reload(), { immediate: true })

  return {
    data,
    loading,
    error,
    busyIds,
    reload,
    checkIn: (row) => operate(row, (id) => apiCheckIn(id)),
    checkOut: (row) => operate(row, (id) => apiCheckOut(id)),
    markAbsent: (row) => operate(row, (id) => apiMarkAbsent(id)),
    batchCheckIn,
    applyRow,
    wsStatus: ws.status,
    wsDenied: ws.denied,
  }
}
