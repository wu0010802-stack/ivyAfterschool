// PARENT-093：今日接送請求（全部小孩）、操作與 ws 即時套用。
// 移植 ivy FE:src/parent/views/PickupNoticeView.vue::refresh 的 listSeq 過期回應保護與「409 時先 refresh」同步邏輯，
// 從 view 抽到 store；本專案改由後端 `arrived: true` 一次建立並抵達，409 時才對既有請求呼叫「我到了」。
//
// - 只保留 service_date 為台北今日（FRONTEND-003）的資料：ws 事件與回應的跨日資料一律忽略。
// - 寫入互斥：同時只有一個寫入在途。同一動作且同參數的重複呼叫共用進行中的 promise（防連點）；
//   不同動作或不同參數排在進行中的寫入之後依序送出，各自回傳自己的結果（不得以別的寫入結果 resolve）。
// - pickup_request_exists / invalid_pickup_status / 404 pickup_request_not_found → 先 load(true) 同步最新狀態再 rethrow 原錯誤。
// - clear()（登出 / 換人）之後：在途寫入的回應不寫回 store、需同步的失敗不再 load(true)，呼叫端的 promise 照常 resolve / reject；
//   排隊中尚未送出的寫入不送出，以 ApiError(0, 'write_cancelled') reject。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  ApiError,
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

/** clear() 之後才輪到送出的寫入：不送出，以此錯誤碼 reject */
export const WRITE_CANCELLED_CODE = 'write_cancelled'

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
  // 寫入：clear() 遞增世代，世代不同的寫入不寫回 store；writeTail 是依序執行的尾巴（writeDepth > 0 表示有寫入在途或排隊）；
  // inflightWrites 依 key 共用 promise
  let writeGeneration = 0
  let writeTail: Promise<unknown> = Promise.resolve()
  let writeDepth = 0
  const inflightWrites = new Map<string, Promise<ParentPickupRequest>>()

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

  /**
   * 同時只允許一個寫入在途。key = 動作 + 參數：相同 key 的重複呼叫共用進行中（或排隊中）的 promise；
   * 其他寫入排在尾巴之後依序送出，各自回傳自己的結果。成功以回應 upsert；需要同步的錯誤先 load(true) 再 rethrow。
   * 寫入開始前記下世代：clear() 之後世代不同 → 尚未送出的不送出（write_cancelled），已送出的結果不寫回、不再同步。
   */
  function runWrite(action: PickupAction, key: string, fn: () => Promise<ParentPickupRequest>): Promise<ParentPickupRequest> {
    const shared = inflightWrites.get(key)
    if (shared) return shared
    const generation = writeGeneration
    const run = async (): Promise<ParentPickupRequest> => {
      if (generation !== writeGeneration) throw new ApiError(0, WRITE_CANCELLED_CODE, '操作已取消，請重新操作')
      pendingAction.value = action
      try {
        const r = await fn()
        if (generation === writeGeneration) upsert(r)
        return r
      } catch (e) {
        if (generation === writeGeneration && needsResync(e)) await load(true)
        throw e
      } finally {
        if (generation === writeGeneration) pendingAction.value = null
      }
    }
    // 沒有寫入在途時立刻開始（請求在同一個 tick 送出）；否則排在尾巴之後，不論前一筆成功或失敗都接著執行
    const write: Promise<ParentPickupRequest> = writeDepth === 0 ? run() : writeTail.then(run, run)
    writeDepth += 1
    writeTail = write.then(
      () => undefined,
      () => undefined,
    )
    inflightWrites.set(key, write)
    const settle = (): void => {
      writeDepth -= 1
      if (inflightWrites.get(key) === write) inflightWrites.delete(key)
    }
    write.then(settle, settle)
    return write
  }

  function writeKey(action: PickupAction, ...params: (string | null | undefined)[]): string {
    return `${action}:${JSON.stringify(params.map((p) => p ?? null))}`
  }

  function create(childId: string, expectedArrivalAt: HHMM | null): Promise<ParentPickupRequest> {
    return runWrite('create', writeKey('create', childId, expectedArrivalAt), () =>
      createPickupRequest({ student_id: childId, expected_arrival_at: expectedArrivalAt }),
    )
  }

  function markArrived(id: string): Promise<ParentPickupRequest> {
    return runWrite('markArrived', writeKey('markArrived', id), () => markPickupArrived(id))
  }

  function cancel(id: string, reason?: string): Promise<ParentPickupRequest> {
    return runWrite('cancel', writeKey('cancel', id, reason), () => cancelPickupRequest(id, reason))
  }

  /**
   * 「我已經到了」捷徑：一次建立並抵達。已有進行中請求（409 pickup_request_exists 帶 request_id）
   * → 改對該請求呼叫「我到了」並以其結果回傳；該次再失敗照一般規則（需要同步的先 load(true)）rethrow。
   */
  function arriveNow(childId: string): Promise<ParentPickupRequest> {
    return runWrite('arriveNow', writeKey('arriveNow', childId), async () => {
      try {
        return await createPickupRequest({ student_id: childId, arrived: true })
      } catch (e) {
        const existingId = existingRequestId(e)
        if (existingId === null) throw e
        return await markPickupArrived(existingId)
      }
    })
  }

  /** 登出 / 換人：在途與排隊中的寫入自此世代失效（見 runWrite），之後的新寫入照常 */
  function clear(): void {
    listSeq += 1
    pendingLoad = null
    writeGeneration += 1
    inflightWrites.clear()
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
