// PARENT-052：以 /children/{id}/today（BACKEND-526）取得選中小孩的今日狀態，之後由 ws 即時更新（新寫功能；
// ivy 的 useTodayStatusCache 依賴幼稚園 today-status endpoint，不移植）。
//
// - 只打一支聚合 endpoint；childId 變更立即清空並重抓，以序號丟棄切換前請求的晚到回應。
// - ws 只處理 student_id 為目前小孩、日期為 today.date 的事件；pickup 合併規則與後端「優先取非終態」一致。
// - 斷線補齊由 parentWs poller 負責；頁面重新可見也重抓。卸載時全部解除。
import { onScopeDispose, ref, watch, type Ref } from 'vue'
import {
  PICKUP_OPEN_STATUSES,
  type AttendanceStatus,
  type ISODate,
  type ISODateTime,
  type PickupRequestStatus,
} from '@/shared/types/api'
import { getChildToday, type ChildToday } from '../api/children'
import type { ParentPickupRequest } from '../api/pickupRequests'
import type { HomeworkProgressEvent } from '../stores/homeworkToday'
import { useParentWsStore } from '../stores/parentWs'

const LOAD_ERROR = '今日狀態載入失敗'

export type TodayPickup = NonNullable<ChildToday['pickup_request']> &
  Partial<Pick<ParentPickupRequest, 'replied_at' | 'arrived_at'>>

export type TodayState = Omit<ChildToday, 'pickup_request'> & { pickup_request: TodayPickup | null }

/** `/api/ws/parent` 的 attendance.updated data */
export interface AttendanceUpdatedEvent {
  student_id: string
  service_date: ISODate
  status: AttendanceStatus
  check_in_at: ISODateTime | null
  check_out_at: ISODateTime | null
}

export interface TodayStatus {
  today: Ref<TodayState | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
  /** 以使用者操作的回應立即更新（同 ws 合併規則），不必等 ws */
  applyPickup: (request: ParentPickupRequest) => void
}

const OPEN: ReadonlySet<PickupRequestStatus> = new Set(PICKUP_OPEN_STATUSES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isAttendanceEvent(value: unknown): value is AttendanceUpdatedEvent {
  return isRecord(value) && typeof value.student_id === 'string' && typeof value.service_date === 'string'
}

function isHomeworkEvent(value: unknown): value is HomeworkProgressEvent {
  return (
    isRecord(value) &&
    typeof value.student_id === 'string' &&
    typeof value.date === 'string' &&
    Array.isArray(value.items)
  )
}

function isPickupRequest(value: unknown): value is ParentPickupRequest {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.student_id === 'string' &&
    typeof value.service_date === 'string'
  )
}

function toTodayPickup(r: ParentPickupRequest): TodayPickup {
  return {
    id: r.id,
    status: r.status,
    expected_arrival_at: r.expected_arrival_at,
    reply_ready_eta: r.reply_ready_eta,
    reply_message: r.reply_message,
    reply_source: r.reply_source,
    completed_at: r.completed_at,
    picked_up_by_name: r.picked_up_by_name,
    can_cancel: r.can_cancel,
    can_mark_arrived: r.can_mark_arrived,
    replied_at: r.replied_at,
    arrived_at: r.arrived_at,
  }
}

export function useTodayStatus(childId: Ref<string | null>): TodayStatus {
  const parentWs = useParentWsStore()

  const today = ref<TodayState | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 每次 refresh 遞增；較舊請求（例如切換小孩前）的回應一律丟棄
  let seq = 0

  async function refresh(): Promise<void> {
    const id = childId.value
    const mySeq = ++seq
    error.value = null
    if (id === null) {
      today.value = null
      loading.value = false
      return
    }
    loading.value = true
    try {
      const data = await getChildToday(id)
      if (mySeq !== seq) return
      today.value = data
    } catch {
      if (mySeq !== seq) return
      // 保留既有 today
      error.value = LOAD_ERROR
    } finally {
      if (mySeq === seq) loading.value = false
    }
  }

  /** 事件屬於目前小孩且是 today 這一天 */
  function current(studentId: string, date: string): TodayState | null {
    const state = today.value
    if (state === null || studentId !== childId.value || date !== state.date) return null
    return state
  }

  function mergePickup(r: ParentPickupRequest): void {
    const state = current(r.student_id, r.service_date)
    if (state === null) return
    const existing = state.pickup_request
    // 目前是另一筆非終態、新資料為終態 → 忽略（與後端「優先取非終態」一致）
    if (existing !== null && existing.id !== r.id && OPEN.has(existing.status) && !OPEN.has(r.status)) return
    state.pickup_request = toTodayPickup(r)
  }

  function applyPickup(request: ParentPickupRequest): void {
    mergePickup(request)
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === 'visible') void refresh()
  }

  const offs = [
    parentWs.on('attendance.updated', (data) => {
      if (!isAttendanceEvent(data)) return
      const state = current(data.student_id, data.service_date)
      if (state === null) return
      state.attendance = { status: data.status, check_in_at: data.check_in_at, check_out_at: data.check_out_at }
    }),
    parentWs.on('homework.progress_updated', (data) => {
      if (!isHomeworkEvent(data)) return
      const state = current(data.student_id, data.date)
      if (state === null) return
      state.homework = {
        item_count: data.items.length,
        done_count: data.items.filter((item) => item.status === 'done').length,
        overall_status: data.overall_status,
        ready_eta: data.ready_eta,
        note: data.note,
      }
    }),
    parentWs.on('pickup.request_updated', (data) => {
      if (isPickupRequest(data)) mergePickup(data)
    }),
    parentWs.registerPoller(refresh),
  ]
  document.addEventListener('visibilitychange', onVisibilityChange)

  // 切換小孩：立即清空再重抓
  watch(
    childId,
    () => {
      today.value = null
      void refresh()
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    seq += 1
    for (const off of offs) off()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return { today, loading, error, refresh, applyPickup }
}
