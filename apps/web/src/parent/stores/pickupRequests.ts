// PARENT-093：今日接送請求（全部小孩）、操作與 ws 即時套用。
// 移植 ivy FE:src/parent/views/PickupNoticeView.vue::refresh 的 listSeq 過期回應保護與「409 時先 refresh」同步邏輯，
// 從 view 抽到 store；本專案改由後端 `arrived: true` 一次建立並抵達，409 時才對既有請求呼叫「我到了」。
//
// - 只保留 service_date 為台北今日（FRONTEND-003）的資料：ws 事件與回應的跨日資料一律忽略。
// - 寫入互斥：進行中再呼叫任何寫入動作直接回傳進行中的 promise（防連點）。
// - pickup_request_exists / invalid_pickup_status / 404 pickup_request_not_found → 先 load(true) 同步最新狀態再 rethrow 原錯誤。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  PICKUP_OPEN_STATUSES,
  isApiError,
  type HHMM,
  type PickupRequestStatus,
} from '@/shared/types/api'
import { todayTaipei } from '@/shared/utils/datetime'
import {
  cancelPickupRequest,
  createPickupRequest,
  listTodayPickupRequests,
  markPickupArrived,
  type ParentPickupRequest,
} from '../api/pickupRequests'
import { useParentWsStore } from './parentWs'

const LOAD_ERROR = '接送狀態載入失敗'
/** 寫入失敗後要先同步最新狀態的錯誤碼 */
const RESYNC_CODES = new Set(['pickup_request_exists', 'invalid_pickup_status', 'pickup_request_not_found'])

export type PickupAction = 'create' | 'markArrived' | 'cancel' | 'arriveNow'

const OPEN: ReadonlySet<PickupRequestStatus> = new Set(PICKUP_OPEN_STATUSES)

function isOpen(r: ParentPickupRequest): boolean {
  return OPEN.has(r.status)
}

function byCreatedDesc(a: ParentPickupRequest, b: ParentPickupRequest): number {
  return b.created_at.localeCompare(a.created_at)
}

function isRequest(value: unknown): value is ParentPickupRequest {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<ParentPickupRequest>
  return typeof v.id === 'string' && typeof v.student_id === 'string' && typeof v.service_date === 'string'
}

function needsResync(e: unknown): boolean {
  return isApiError(e) && RESYNC_CODES.has(e.code)
}

function existingRequestId(e: unknown): string | null {
  if (!isApiError(e) || e.code !== 'pickup_request_exists') return null
  const id = (e.details as { request_id?: unknown } | null)?.request_id
  return typeof id === 'string' && id !== '' ? id : null
}

export const usePickupRequestsStore = defineStore('parentPickupRequests', () => {
  const parentWs = useParentWsStore()

  const items = ref<ParentPickupRequest[]>([])
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 進行中的寫入動作；null 表示沒有 */
  const pendingAction = ref<PickupAction | null>(null)

  // 每次 load / clear 遞增；較舊請求的回應一律丟棄（ivy listSeq）
  let listSeq = 0
  let pendingLoad: Promise<void> | null = null
  let pendingWrite: Promise<ParentPickupRequest> | null = null

  const openFor = computed(() => (childId: string): ParentPickupRequest | null => {
    const open = items.value.filter((r) => r.student_id === childId && isOpen(r)).sort(byCreatedDesc)
    return open[0] ?? null
  })

  const latestFor = computed(() => (childId: string): ParentPickupRequest | null => {
    const mine = items.value.filter((r) => r.student_id === childId).sort(byCreatedDesc)
    return mine[0] ?? null
  })

  const historyFor = computed(() => (childId: string): ParentPickupRequest[] => {
    return items.value.filter((r) => r.student_id === childId && !isOpen(r)).sort(byCreatedDesc)
  })

  function isToday(r: ParentPickupRequest): boolean {
    return r.service_date === todayTaipei()
  }

  /** 依 id 取代或加入；跨日資料忽略 */
  function upsert(r: ParentPickupRequest): void {
    if (!isToday(r)) return
    const index = items.value.findIndex((x) => x.id === r.id)
    if (index >= 0) items.value[index] = r
    else items.value = [...items.value, r]
  }

  function load(force = false): Promise<void> {
    if (!force) {
      if (loaded.value) return Promise.resolve()
      if (pendingLoad) return pendingLoad
    }
    const mySeq = ++listSeq
    loading.value = true
    error.value = null
    const request: Promise<void> = listTodayPickupRequests()
      .then(
        (list) => {
          if (mySeq !== listSeq) return
          items.value = list.filter(isToday)
          loaded.value = true
        },
        () => {
          if (mySeq !== listSeq) return
          // 不清空既有 items
          error.value = LOAD_ERROR
        },
      )
      .finally(() => {
        if (mySeq !== listSeq) return
        loading.value = false
        pendingLoad = null
      })
    pendingLoad = request
    return request
  }

  /** 寫入失敗：需要同步的錯誤先 load(true) 再 rethrow 原錯誤 */
  async function failWrite(e: unknown): Promise<never> {
    if (needsResync(e)) await load(true)
    throw e
  }

  /** 同時只允許一個寫入；進行中再呼叫直接回傳進行中的 promise */
  function runWrite(action: PickupAction, fn: () => Promise<ParentPickupRequest>): Promise<ParentPickupRequest> {
    if (pendingWrite) return pendingWrite
    pendingAction.value = action
    const write: Promise<ParentPickupRequest> = fn()
      .then((r) => {
        upsert(r)
        return r
      }, failWrite)
      .finally(() => {
        if (pendingWrite === write) {
          pendingWrite = null
          pendingAction.value = null
        }
      })
    pendingWrite = write
    return write
  }

  function create(childId: string, expectedArrivalAt: HHMM | null): Promise<ParentPickupRequest> {
    return runWrite('create', () => createPickupRequest({ student_id: childId, expected_arrival_at: expectedArrivalAt }))
  }

  function markArrived(id: string): Promise<ParentPickupRequest> {
    return runWrite('markArrived', () => markPickupArrived(id))
  }

  function cancel(id: string, reason?: string): Promise<ParentPickupRequest> {
    return runWrite('cancel', () => cancelPickupRequest(id, reason))
  }

  /**
   * 「我已經到了」捷徑：一次建立並抵達。已有進行中請求（409 pickup_request_exists 帶 request_id）
   * → 改對該請求呼叫「我到了」並以其結果回傳；該次再失敗照一般規則（需要同步的先 load(true)）rethrow。
   */
  function arriveNow(childId: string): Promise<ParentPickupRequest> {
    return runWrite('arriveNow', async () => {
      try {
        return await createPickupRequest({ student_id: childId, arrived: true })
      } catch (e) {
        const existingId = existingRequestId(e)
        if (existingId === null) throw e
        return await markPickupArrived(existingId)
      }
    })
  }

  function clear(): void {
    listSeq += 1
    pendingLoad = null
    pendingWrite = null
    pendingAction.value = null
    items.value = []
    loaded.value = false
    loading.value = false
    error.value = null
  }

  parentWs.on('pickup.request_updated', (data) => {
    if (isRequest(data)) upsert(data)
  })
  parentWs.registerPoller(() => load(true))

  return {
    items,
    loaded,
    loading,
    error,
    pendingAction,
    openFor,
    latestFor,
    historyFor,
    load,
    create,
    markArrived,
    cancel,
    arriveNow,
    clear,
  }
})
