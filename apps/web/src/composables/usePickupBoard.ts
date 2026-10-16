// FRONTEND-188：接送 POS（FRONTEND-189）與代理核驗頁（FRONTEND-200）共用的資料擁有者：
// 今日佇列、POS 名單、代理授權、ws 合併與操作。
// 參考 ivy FE:src/views/DismissalQueueView.vue 的 loadCalls 序號防護、handleWsEvent upsert、斷線輪詢（由 FRONTEND-038 接管）。
// - 日期固定 todayTaipei()；每分鐘檢查跨午夜，跨日時以新的一天重新載入。
// - applyRequest：同一筆請求可能同時由 HTTP 回應、ws、輪詢更新，以狀態機順序（pending → acknowledged → arrived → 終態）
//   做單向守衛：終態一旦套用不會被較晚到的 open 訊息蓋回去，較舊的 open 狀態也不會倒退。
// - mutation：成功以回傳值 applyRequest；404 pickup_request_not_found / 409 invalid_pickup_status 提示並 reload、
//   resolve null（呼叫端關 dialog 即可）；其他錯誤 rethrow 給 dialog 顯示。
// - withRoster 另訂閱 attendance / homework 就地更新名單；topic 被拒時改為每 60 秒重抓名單。
// - 授權事件（pickup.authorization_updated）只帶家長端形狀（BACKEND-420 PickupAuthorizationOut），沒有學生摘要、照片、
//   錯誤次數與鎖定：收到當天的事件就重抓 B436 清單（序號防護），不就地合併；沒載入授權清單時不寫入，改重抓名單。
import { ElMessage } from 'element-plus'
import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import type { AttendanceRow } from '@/api/attendance'
import type { Progress } from '@/api/homework'
import { listPickupAuthorizations, type StaffAuthorization } from '@/api/pickupAuthorizations'
import {
  acknowledgePickupRequest,
  completePickupRequest,
  createPickupRequest,
  fetchPickupQueue,
  fetchPickupRoster,
  replyPickupRequest,
  type InvalidPickupStatusDetails,
  type PickupCompleteBody,
  type PickupQueue,
  type PickupQueueCounts,
  type PickupReply,
  type PickupRequest,
  type PickupRequestCreate,
  type PickupRoster,
  type RosterOpenRequest,
  type RosterStudent,
} from '@/api/pickupRequests'
import { PICKUP_REQUEST_STATUS_META, statusMeta } from '@/shared/constants/statusLabels'
import { isApiError, type ISODate, type PickupOpenStatus, type PickupRequestStatus } from '@/shared/types/api'
import { todayTaipei } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'
import type { WsStatus } from '@/shared/ws/createWsClient'
import { useAdminWsTopic } from './useAdminWsTopic'
import { OPEN_PICKUP_STATUSES, patchRosterStudent } from './useDismissalRoster'

/** 跨午夜檢查週期 */
const DAY_CHECK_INTERVAL_MS = 60_000
/** attendance / homework topic 被拒時的名單輪詢週期 */
const ROSTER_POLL_INTERVAL_MS = 60_000

export interface PickupBoardOptions {
  /** 一併載入 POS 名單並訂閱 attendance / homework */
  withRoster?: boolean
  /** 一併載入今日代理授權 */
  withAuthorizations?: boolean
}

export type RequestListener = (req: PickupRequest) => void

/**
 * ws `pickup.authorization_updated` 的 data：後端 PickupAuthorizationOut（docs/tasks/api_index.md §14 的 ParentAuthorization 形狀），
 * 沒有 student / photo_url / code_attempts / locked / verified_by_name，不能當 StaffAuthorization 放進清單。
 */
export type AuthorizationEvent = Omit<
  StaffAuthorization,
  'student' | 'photo_url' | 'code_attempts' | 'locked' | 'verified_by_name'
>

export interface PickupBoard {
  queue: Ref<PickupQueue | null>
  roster: Ref<PickupRoster | null>
  authorizations: Ref<StaffAuthorization[]>
  /** 由 queue.open 重算 */
  counts: ComputedRef<PickupQueueCounts>
  loading: Ref<boolean>
  /** 最近一次載入失敗的訊息；成功後清為 null */
  error: Ref<string | null>
  reload(): Promise<void>
  /** 以下 mutation：404 / 409 已提示並重新整理，resolve null；其他錯誤 reject */
  reply(id: string, body: PickupReply): Promise<PickupRequest | null>
  acknowledge(id: string): Promise<PickupRequest | null>
  complete(id: string, body: PickupCompleteBody): Promise<PickupRequest | null>
  create(body: PickupRequestCreate): Promise<PickupRequest | null>
  applyRequest(req: PickupRequest): void
  /** HTTP 核驗結果（B437~439 回傳的完整授權）；ws 授權事件不走這裡，改重抓清單 */
  applyAuthorization(auth: StaffAuthorization): void
  /** 狀態從非 arrived 變成 arrived（含第一次看到就是 arrived）；回傳解除函式 */
  onArrived(fn: RequestListener): () => void
  /** 原本不在 open 的 pending 第一次出現；回傳解除函式 */
  onNewRequest(fn: RequestListener): () => void
  wsStatus: ComputedRef<WsStatus>
  wsDenied: ComputedRef<boolean>
}

/** 狀態機順序：較小的狀態不可覆蓋較大的狀態（終態最大） */
const STATUS_RANK: Record<PickupRequestStatus, number> = {
  pending: 0,
  acknowledged: 1,
  arrived: 2,
  completed: 3,
  cancelled: 3,
  expired: 3,
}

const isOpen = (status: PickupRequestStatus): status is PickupOpenStatus => OPEN_PICKUP_STATUSES.has(status)

function countOpen(open: PickupRequest[]): PickupQueueCounts {
  const counts: PickupQueueCounts = { pending: 0, acknowledged: 0, arrived: 0, needs_reply: 0 }
  for (const r of open) {
    if (isOpen(r.status)) counts[r.status] += 1
    if (r.needs_reply) counts.needs_reply += 1
  }
  return counts
}

function toRosterOpenRequest(req: PickupRequest, status: PickupOpenStatus): RosterOpenRequest {
  return { id: req.id, status, expected_arrival_at: req.expected_arrival_at, needs_reply: req.needs_reply }
}

function upsert<T extends { id: string }>(list: T[], item: T, position: 'keep' | 'front'): T[] {
  const index = list.findIndex((x) => x.id === item.id)
  if (index >= 0) return list.map((x, i) => (i === index ? item : x))
  return position === 'front' ? [item, ...list] : [...list, item]
}

function findStudent(roster: PickupRoster, studentId: string): RosterStudent | undefined {
  for (const c of roster.classes) {
    const s = c.students.find((x) => x.student_id === studentId)
    if (s) return s
  }
  return undefined
}

function runListeners(listeners: Set<RequestListener>, req: PickupRequest): void {
  for (const fn of listeners) {
    try {
      fn(req)
    } catch (err) {
      console.error('[usePickupBoard] listener 執行失敗', err)
    }
  }
}

export function usePickupBoard(opts: PickupBoardOptions = {}): PickupBoard {
  const withRoster = opts.withRoster === true
  const withAuthorizations = opts.withAuthorizations === true

  const queue = shallowRef<PickupQueue | null>(null)
  const roster = shallowRef<PickupRoster | null>(null)
  const authorizations = shallowRef<StaffAuthorization[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const arrivedListeners = new Set<RequestListener>()
  const newRequestListeners = new Set<RequestListener>()

  let date: ISODate = todayTaipei()
  // 每種資料各自的序號：只採用最新一次請求的回應（reloadRoster 不影響 queue / authorizations）
  let queueSeq = 0
  let rosterSeq = 0
  let authSeq = 0

  const counts = computed<PickupQueueCounts>(() => countOpen(queue.value?.open ?? []))

  async function loadQueue(): Promise<void> {
    const mySeq = ++queueSeq
    const res = await fetchPickupQueue(date)
    if (mySeq === queueSeq) queue.value = res
  }

  async function loadRoster(): Promise<void> {
    const mySeq = ++rosterSeq
    const res = await fetchPickupRoster({ date })
    if (mySeq === rosterSeq) roster.value = res
  }

  /** 回傳這次的回應是否被採用（較新的請求已發出時晚到的回應丟棄） */
  async function loadAuthorizations(): Promise<boolean> {
    const mySeq = ++authSeq
    const res = await listPickupAuthorizations({ date })
    if (mySeq !== authSeq) return false
    authorizations.value = res
    return true
  }

  /** 同時進行的多次 reload：只有最後一次會收尾 loading / error */
  let reloadToken = 0

  async function reload(): Promise<void> {
    const myToken = ++reloadToken
    loading.value = true
    try {
      await Promise.all([
        loadQueue(),
        withRoster ? loadRoster() : Promise.resolve(),
        withAuthorizations ? loadAuthorizations() : Promise.resolve(),
      ])
      if (myToken === reloadToken) error.value = null
    } catch (err) {
      if (myToken === reloadToken) error.value = errorMessage(err, '無法載入接送資料')
    } finally {
      if (myToken === reloadToken) loading.value = false
    }
  }

  async function reloadRoster(): Promise<void> {
    if (!withRoster) return
    try {
      await loadRoster()
    } catch (err) {
      console.error('[usePickupBoard] 重抓名單失敗', err)
    }
  }

  function patchStudent(studentId: string, patch: Partial<RosterStudent>): void {
    if (!roster.value) return
    roster.value = patchRosterStudent(roster.value, studentId, patch)
  }

  function syncRosterRequest(req: PickupRequest): void {
    if (!roster.value) return
    const student = findStudent(roster.value, req.student.id)
    if (!student) return
    if (isOpen(req.status)) {
      patchStudent(student.student_id, { open_request: toRosterOpenRequest(req, req.status) })
      return
    }
    const patch: Partial<RosterStudent> = {}
    // 終態只清掉「這一筆」：名單上若已是另一筆新的進行中請求，不可被舊請求的終態清空
    if (!student.open_request || student.open_request.id === req.id) patch.open_request = null
    if (req.status === 'completed') patch.attendance_status = 'left'
    patchStudent(student.student_id, patch)
  }

  function applyRequest(req: PickupRequest): void {
    if (req.service_date !== date) return
    const current = queue.value ?? { date, open: [], closed: [], counts: countOpen([]) }
    const previous = current.open.find((r) => r.id === req.id) ?? current.closed.find((r) => r.id === req.id)
    if (previous && STATUS_RANK[req.status] < STATUS_RANK[previous.status]) return

    if (isOpen(req.status)) {
      queue.value = {
        ...current,
        open: upsert(current.open, req, 'keep'),
        closed: current.closed.filter((r) => r.id !== req.id),
      }
    } else {
      queue.value = {
        ...current,
        open: current.open.filter((r) => r.id !== req.id),
        closed: upsert(current.closed, req, 'front'),
      }
    }
    syncRosterRequest(req)

    if (req.status === 'arrived' && previous?.status !== 'arrived') runListeners(arrivedListeners, req)
    else if (!previous && req.status === 'pending') runListeners(newRequestListeners, req)
  }

  /** 以目前的授權清單重算名單上每位學生的 active 授權數（只換掉數字有變的學生） */
  function recountAuthorizations(): void {
    const current = roster.value
    if (!current) return
    const active = new Map<string, number>()
    for (const a of authorizations.value) {
      if (a.effective_status === 'active') active.set(a.student_id, (active.get(a.student_id) ?? 0) + 1)
    }
    const countOf = (s: RosterStudent): number => active.get(s.student_id) ?? 0
    if (current.classes.every((c) => c.students.every((s) => s.active_authorization_count === countOf(s)))) return
    roster.value = {
      ...current,
      classes: current.classes.map((c) => ({
        ...c,
        students: c.students.map((s) =>
          s.active_authorization_count === countOf(s) ? s : { ...s, active_authorization_count: countOf(s) },
        ),
      })),
    }
  }

  async function refetchAuthorizations(): Promise<void> {
    try {
      if (await loadAuthorizations()) recountAuthorizations()
    } catch (err) {
      console.error('[usePickupBoard] 重抓代理授權失敗', err)
    }
  }

  function applyAuthorization(auth: StaffAuthorization): void {
    if (auth.service_date !== date) return
    // 沒載入授權清單時不寫入（清單不完整），名單上的計數改由後端重算
    if (!withAuthorizations) {
      void reloadRoster()
      return
    }
    authorizations.value = upsert(authorizations.value, auth, 'keep')
    recountAuthorizations()
  }

  /** 推播只帶家長端形狀：不就地合併（重新產生接送碼會重設錯誤次數與鎖定，推播不帶這兩欄），一律重抓 */
  function onAuthorizationEvent(event: AuthorizationEvent): void {
    if (event?.service_date !== date) return
    if (withAuthorizations) void refetchAuthorizations()
    else void reloadRoster()
  }

  function applyAttendanceRow(row: AttendanceRow): void {
    if (row.service_date !== date) return
    patchStudent(row.student_id, {
      attendance_status: row.status,
      check_in_at: row.check_in_at,
      check_out_at: row.check_out_at,
      leave_type: row.leave?.leave_type ?? null,
    })
  }

  function applyHomeworkProgress(payload: { student_id?: string; service_date?: string; progress?: Progress }): void {
    const progress = payload?.progress
    if (!progress || typeof payload.student_id !== 'string') return
    if ((payload.service_date ?? progress.service_date) !== date) return
    patchStudent(payload.student_id, { homework_status: progress.overall_status, ready_eta: progress.ready_eta })
  }

  function notFound(err: unknown): boolean {
    return isApiError(err) && err.code === 'pickup_request_not_found'
  }

  function statusConflict(err: unknown): boolean {
    return isApiError(err) && err.code === 'invalid_pickup_status'
  }

  async function mutate(call: () => Promise<PickupRequest>): Promise<PickupRequest | null> {
    try {
      const req = await call()
      applyRequest(req)
      return req
    } catch (err) {
      if (notFound(err)) {
        ElMessage.warning('此接送請求已不存在，已重新整理')
        await reload()
        return null
      }
      if (statusConflict(err)) {
        const details = (isApiError(err) ? err.details : null) as Partial<InvalidPickupStatusDetails> | null
        const label = statusMeta(PICKUP_REQUEST_STATUS_META, details?.current_status).label
        ElMessage.warning(`此請求狀態已變更（目前：${label}）`)
        await reload()
        return null
      }
      throw err
    }
  }

  const pickupWs = useAdminWsTopic(
    'pickup',
    {
      'pickup.request_updated': (req: PickupRequest) => applyRequest(req),
      'pickup.authorization_updated': (event: AuthorizationEvent) => onAuthorizationEvent(event),
    },
    { resync: reload },
  )

  if (withRoster) {
    // 斷線 / 重連的補抓由 pickup topic 的 resync（reload）一次涵蓋，這兩個 topic 不另外補抓
    const noResync = (): void => undefined
    const attendanceWs = useAdminWsTopic(
      'attendance',
      {
        'attendance.updated': (row: AttendanceRow) => applyAttendanceRow(row),
        'attendance.batch_updated': (payload: { items?: AttendanceRow[] }) => {
          for (const row of Array.isArray(payload?.items) ? payload.items : []) applyAttendanceRow(row)
        },
        'attendance.bulk_updated': (payload: { dates?: string[] }) => {
          if (Array.isArray(payload?.dates) && payload.dates.includes(date)) void reloadRoster()
        },
      },
      { resync: noResync },
    )
    const homeworkWs = useAdminWsTopic(
      'homework',
      { 'homework.progress_updated': (payload: Parameters<typeof applyHomeworkProgress>[0]) => applyHomeworkProgress(payload) },
      { resync: noResync },
    )

    let rosterPoll: ReturnType<typeof setInterval> | null = null
    watch(
      () => attendanceWs.denied.value || homeworkWs.denied.value,
      (denied) => {
        if (denied && rosterPoll === null) {
          rosterPoll = setInterval(() => void reloadRoster(), ROSTER_POLL_INTERVAL_MS)
        } else if (!denied && rosterPoll !== null) {
          clearInterval(rosterPoll)
          rosterPoll = null
        }
      },
      { immediate: true },
    )
    onScopeDispose(() => {
      if (rosterPoll !== null) clearInterval(rosterPoll)
    })
  }

  const dayTimer = setInterval(() => {
    const today = todayTaipei()
    if (today === date) return
    date = today
    void reload()
  }, DAY_CHECK_INTERVAL_MS)
  onScopeDispose(() => clearInterval(dayTimer))

  void reload()

  return {
    queue,
    roster,
    authorizations,
    counts,
    loading,
    error,
    reload,
    reply: (id, body) => mutate(() => replyPickupRequest(id, body)),
    acknowledge: (id) => mutate(() => acknowledgePickupRequest(id)),
    complete: (id, body) => mutate(() => completePickupRequest(id, body)),
    create: (body) => mutate(() => createPickupRequest(body)),
    applyRequest,
    applyAuthorization,
    onArrived: (fn) => {
      arrivedListeners.add(fn)
      return () => {
        arrivedListeners.delete(fn)
      }
    },
    onNewRequest: (fn) => {
      newRequestListeners.add(fn)
      return () => {
        newRequestListeners.delete(fn)
      }
    },
    wsStatus: pickupWs.status,
    wsDenied: pickupWs.denied,
  }
}
