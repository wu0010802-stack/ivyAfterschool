// FRONTEND-185：接送 POS 右欄佇列的合併排序、員工代建 5 秒倒數、本地樂觀項目與取消。
// 移植 ivy FE:src/composables/useDismissalPosQueue.ts 的核心設計：
// - staging Map：倒數期間不打 API，0 秒才 createPickupRequest；finally 以 entry 身分判斷才刪除 staging
//   （await 期間使用者可能取消再重新加入同一學生，新的倒數不可被舊呼叫的 finally 清掉）。
// - 成功以 response 建本地 active 項目，直到外部 queue（ws / 輪詢）出現同 id 才移除，避免卡片短暫消失。
// - WS 比 HTTP 回應先到時以 studentId 去重，同一學生不會同時出現 staging + active 兩張卡。
// - onScopeDispose 清 timer。
// 狀態機為本專案：open = pending / acknowledged / arrived；closed = completed / cancelled / expired。
// 代理核驗不在這裡（FRONTEND-201）。
import { ElMessage } from 'element-plus'
import { computed, onScopeDispose, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import {
  cancelPickupRequest,
  createPickupRequest,
  type PickupQueue,
  type PickupRequest,
} from '@/api/pickupRequests'
import { isApiError } from '@/shared/types/api'
import { errorMessage } from '@/shared/utils/errorMessage'
import { OPEN_PICKUP_STATUSES, openRequestStudentIds } from './useDismissalRoster'

/** 倒數總長度（毫秒） */
export const STAGING_DURATION_MS = 5000

const STAGING_ID_PREFIX = 'staging:'

export type PosQueuePhase = 'staging' | 'active' | 'closed'

export interface PosQueueItem {
  /** staging 為 `staging:{studentId}`，其餘為 PickupRequest.id */
  id: string
  phase: PosQueuePhase
  studentId: string
  studentName: string
  className: string
  /** 只有 staging 有值 */
  countdown: { startedAt: number; durationMs: number } | null
  /** staging 為 null */
  request: PickupRequest | null
}

export interface PosDispatchStudent {
  id: string
  name: string
  className: string
}

interface StagingEntry {
  student: PosDispatchStudent
  startedAt: number
  timer: ReturnType<typeof setTimeout>
}

export interface DismissalPosQueue {
  /** staging → active → closed */
  items: ComputedRef<PosQueueItem[]>
  /** 已在 staging 或已有進行中請求 → false，不重複發起 */
  addToQueue(student: PosDispatchStudent): boolean
  /** staging：純前端移除；active：呼叫 cancel API；closed：直接 false */
  cancel(item: PosQueueItem, reason?: string): Promise<boolean>
  /** 倒數中的 student_id（學生卡顯示「建立中…」） */
  stagingIds: ComputedRef<ReadonlySet<string>>
}

const stagingItemId = (studentId: string): string => `${STAGING_ID_PREFIX}${studentId}`

const timeMs = (iso: string | null): number => {
  if (!iso) return Number.MAX_SAFE_INTEGER
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
}

/** 與後端一致：arrived 在前（arrived_at 早者先），其餘依 expected_arrival_at（null 最後）、created_at */
function compareActive(a: PickupRequest, b: PickupRequest): number {
  const aArrived = a.status === 'arrived'
  const bArrived = b.status === 'arrived'
  if (aArrived !== bArrived) return aArrived ? -1 : 1
  if (aArrived) return timeMs(a.arrived_at) - timeMs(b.arrived_at)
  const ea = a.expected_arrival_at
  const eb = b.expected_arrival_at
  if (ea !== eb) {
    if (!ea) return 1
    if (!eb) return -1
    return ea < eb ? -1 : 1
  }
  return timeMs(a.created_at) - timeMs(b.created_at)
}

/** closed 的排序鍵：結束時間（completed_at / cancelled_at），逾時沒有結束時間時退回 created_at */
const closedAtMs = (r: PickupRequest): number => timeMs(r.completed_at ?? r.cancelled_at ?? r.created_at)

function toItem(request: PickupRequest, phase: 'active' | 'closed'): PosQueueItem {
  return {
    id: request.id,
    phase,
    studentId: request.student.id,
    studentName: request.student.name,
    className: request.student.class_name ?? '',
    countdown: null,
    request,
  }
}

function toStagingItem(studentId: string, entry: StagingEntry): PosQueueItem {
  return {
    id: stagingItemId(studentId),
    phase: 'staging',
    studentId,
    studentName: entry.student.name,
    className: entry.student.className,
    countdown: { startedAt: entry.startedAt, durationMs: STAGING_DURATION_MS },
    request: null,
  }
}

export function useDismissalPosQueue(queue: Ref<PickupQueue | null>): DismissalPosQueue {
  // 以 shallowRef + 換新 Map 的方式觸發更新：entry 保持原物件，finally 的身分比對不受 reactive proxy 影響
  const staging = shallowRef<ReadonlyMap<string, StagingEntry>>(new Map())
  /** submit 成功後的本地樂觀 active 項目（key = request id），外部 queue 出現同 id 前頂替顯示 */
  const localActive = shallowRef<ReadonlyMap<string, PickupRequest>>(new Map())

  function setStaging(mutate: (next: Map<string, StagingEntry>) => void): void {
    const next = new Map(staging.value)
    mutate(next)
    staging.value = next
  }

  function setLocalActive(mutate: (next: Map<string, PickupRequest>) => void): void {
    const next = new Map(localActive.value)
    mutate(next)
    localActive.value = next
  }

  const open = computed<PickupRequest[]>(() => queue.value?.open ?? [])
  const closed = computed<PickupRequest[]>(() => queue.value?.closed ?? [])

  // 外部 queue 一旦含某個 id（不論 open 或 closed），代表 ws / 輪詢已追上，本地樂觀版本不再需要
  watch(
    [open, closed],
    ([openList, closedList]) => {
      if (localActive.value.size === 0) return
      const known = [...openList, ...closedList].filter((r) => localActive.value.has(r.id))
      if (known.length === 0) return
      setLocalActive((next) => {
        for (const r of known) next.delete(r.id)
      })
    },
    { deep: true },
  )

  const items = computed<PosQueueItem[]>(() => {
    const knownIds = new Set([...open.value, ...closed.value].map((r) => r.id))
    const localOnly = [...localActive.value.values()].filter((r) => !knownIds.has(r.id))
    const activeItems = [...open.value, ...localOnly]
      .filter((r) => OPEN_PICKUP_STATUSES.has(r.status))
      .sort(compareActive)
      .map((r) => toItem(r, 'active'))
    const activeStudentIds = new Set(activeItems.map((i) => i.studentId))

    const stagingItems = [...staging.value.entries()]
      .filter(([studentId]) => !activeStudentIds.has(studentId))
      .map(([studentId, entry]) => toStagingItem(studentId, entry))
    const busyStudentIds = new Set([...activeStudentIds, ...stagingItems.map((i) => i.studentId)])

    const closedItems = closed.value
      .filter((r) => !OPEN_PICKUP_STATUSES.has(r.status) && !busyStudentIds.has(r.student.id))
      .sort((a, b) => closedAtMs(b) - closedAtMs(a))
      .map((r) => toItem(r, 'closed'))

    return [...stagingItems, ...activeItems, ...closedItems]
  })

  const stagingIds = computed<ReadonlySet<string>>(() => new Set(staging.value.keys()))

  async function submit(studentId: string): Promise<void> {
    const entry = staging.value.get(studentId)
    if (!entry) return
    const name = entry.student.name
    try {
      const created = await createPickupRequest({ student_id: studentId })
      setLocalActive((next) => next.set(created.id, created))
    } catch (err) {
      if (isApiError(err) && err.code === 'pickup_request_exists') {
        ElMessage.info(`${name} 已有進行中的接送請求`)
      } else {
        ElMessage.error(errorMessage(err, `建立接送請求失敗：${name}`))
      }
    } finally {
      // 只刪自己這一次的 entry：await 期間若已被取消再重新加入，map 裡的是別次倒數
      if (staging.value.get(studentId) === entry) {
        setStaging((next) => next.delete(studentId))
      }
    }
  }

  function hasOpenRequest(studentId: string): boolean {
    if (openRequestStudentIds(open.value).has(studentId)) return true
    return openRequestStudentIds([...localActive.value.values()]).has(studentId)
  }

  function addToQueue(student: PosDispatchStudent): boolean {
    if (staging.value.has(student.id) || hasOpenRequest(student.id)) return false
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      void submit(student.id)
    }, STAGING_DURATION_MS)
    setStaging((next) => next.set(student.id, { student, startedAt, timer }))
    return true
  }

  async function cancel(item: PosQueueItem, reason?: string): Promise<boolean> {
    if (item.phase === 'closed') return false
    if (item.phase === 'staging') {
      const entry = staging.value.get(item.studentId)
      if (!entry) return false
      clearTimeout(entry.timer)
      setStaging((next) => next.delete(item.studentId))
      return true
    }
    try {
      await cancelPickupRequest(item.id, reason)
      setLocalActive((next) => next.delete(item.id))
      return true
    } catch (err) {
      ElMessage.error(errorMessage(err, `取消失敗：${item.studentName}`))
      return false
    }
  }

  onScopeDispose(() => {
    for (const entry of staging.value.values()) clearTimeout(entry.timer)
    staging.value = new Map()
    localActive.value = new Map()
  })

  return { items, addToQueue, cancel, stagingIds }
}
