// FRONTEND-152：作業看板（FRONTEND-151）的資料擁有者：載入看板、項目與整體進度的異動、樂觀更新與 ws 即時合併。
// - 伺服器確認過的資料放在 serverBoard；項目狀態的樂觀變更放在 overrides（itemId → status），對外的 board 是兩者疊合。
//   有樂觀變更的學生，overall 依 domain_spec M6 由疊合後的項目重算；項目異動一律覆蓋先前的手動 done，
//   與後端 recompute_progress（BACKEND-375）一致。失敗時移除 override，回到伺服器確認過的狀態（含手動 done）。
// - 同一項目的狀態切換序列化：一次最多一個 PATCH；進行中再切換只記下最新值，完成後若與伺服器狀態不同再送最後一次。
// - ws homework.progress_updated：當日且學生在看板中才套用；該生有進行中的狀態切換時延後，結束後套用最新一筆。
// - 其他 mutation 成功後以回應更新該生；失敗 reject 原錯誤、不顯示訊息（呼叫端依情境：dialog 的 error 或 ElMessage）。
// - reload 晚到不倒退（FRONTEND-305，規則同 FRONTEND-304）：serverBoard 每次更新某生（ws、mutation 回應）記
//   touched[student_id] = ++touchClock，reload 發出時記 startedAt；回應到達時 startedAt 之後更新過的學生保留目前的
//   serverBoard 列，其餘取回應值（看板名單以回應為準）。篩選鍵改變時清空 touched；summary 由合併結果重算。
import { ElMessage } from 'element-plus'
import { computed, ref, shallowRef, watch, type ComputedRef, type Ref } from 'vue'
import {
  batchCreateHomeworkItems,
  createHomeworkItem,
  deleteHomeworkItem,
  fetchHomeworkBoard,
  updateHomeworkItem,
  updateHomeworkProgress,
  type BoardStudent,
  type BoardSummary,
  type HomeworkBatchCreate,
  type HomeworkBoard,
  type HomeworkBoardParams,
  type HomeworkItem,
  type HomeworkItemCreate,
  type HomeworkItemResult,
  type HomeworkProgressUpdate,
  type Progress,
} from '@/api/homework'
import type { HomeworkItemStatus, HomeworkOverallStatus } from '@/shared/types/api'
import { errorMessage } from '@/shared/utils/errorMessage'
import type { WsStatus } from '@/shared/ws/createWsClient'
import { useAdminWsTopic } from './useAdminWsTopic'

export interface HomeworkBoardParamsRefs {
  date: Ref<string>
  /** null（或空字串）= 全部班級 */
  classId: Ref<string | null>
}

export interface UseHomeworkBoard {
  /** 伺服器資料疊上本地樂觀變更（唯讀） */
  board: Readonly<Ref<HomeworkBoard | null>>
  loading: Ref<boolean>
  /** 最近一次載入失敗的訊息；成功後清為 null */
  error: Ref<string | null>
  /** 只計 attendance_status 不是 leave / absent 的學生（與 BACKEND-383 一致） */
  summary: ComputedRef<BoardSummary>
  reload(): Promise<void>
  addItem(studentId: string, body: { subject_id?: string | null; title: string }): Promise<void>
  /** 樂觀更新；失敗還原並 ElMessage.error，不 reject */
  setItemStatus(item: HomeworkItem, status: HomeworkItemStatus): Promise<void>
  renameItem(item: HomeworkItem, body: { title?: string; subject_id?: string | null }): Promise<void>
  removeItem(item: HomeworkItem): Promise<void>
  setProgress(
    studentId: string,
    body: { overall?: 'done' | 'auto'; ready_eta?: string | null; note?: string | null },
  ): Promise<void>
  /** 需先選班級；回傳 created，成功後重新載入看板 */
  batchAdd(body: { subject_id?: string | null; title: string; student_ids?: string[] }): Promise<number>
  /** 狀態切換進行中的項目 id */
  pendingItemIds: Ref<ReadonlySet<string>>
  wsStatus: ComputedRef<WsStatus>
  wsDenied: ComputedRef<boolean>
}

/** ws homework.progress_updated 的 data */
interface ProgressSnapshot {
  student_id: string
  service_date: string
  items: HomeworkItem[]
  progress: Progress
}

interface StatusChain {
  studentId: string
  /** 使用者最後選的狀態 */
  desired: HomeworkItemStatus
  done: Promise<void>
}

/** domain_spec M6：無 item 或全部 todo → not_started；全部 done → done；其餘 in_progress */
export function deriveOverallStatus(items: readonly Pick<HomeworkItem, 'status'>[]): HomeworkOverallStatus {
  if (items.length === 0 || items.every((i) => i.status === 'todo')) return 'not_started'
  if (items.every((i) => i.status === 'done')) return 'done'
  return 'in_progress'
}

function sortItems(items: HomeworkItem[]): HomeworkItem[] {
  return [...items].sort((a, b) => a.sort_order - b.sort_order)
}

function upsertItem(items: HomeworkItem[], item: HomeworkItem): HomeworkItem[] {
  const index = items.findIndex((i) => i.id === item.id)
  if (index < 0) return sortItems([...items, item])
  const next = [...items]
  next[index] = item
  return sortItems(next)
}

function withOverrides(student: BoardStudent, overrides: ReadonlyMap<string, HomeworkItemStatus>): BoardStudent {
  if (!student.items.some((i) => overrides.has(i.id))) return student
  const items = student.items.map((i) => {
    const status = overrides.get(i.id)
    return status === undefined ? i : { ...i, status }
  })
  return { ...student, items, progress: { ...student.progress, overall_status: deriveOverallStatus(items) } }
}

const EXCLUDED_FROM_SUMMARY = new Set(['leave', 'absent'])

export function useHomeworkBoard(params: HomeworkBoardParamsRefs): UseHomeworkBoard {
  const { date, classId } = params
  const serverBoard = shallowRef<HomeworkBoard | null>(null)
  const overrides = shallowRef<ReadonlyMap<string, HomeworkItemStatus>>(new Map())
  const pendingItemIds = shallowRef<ReadonlySet<string>>(new Set())
  const loading = ref(false)
  const error = ref<string | null>(null)

  const chains = new Map<string, StatusChain>()
  const deferredSnapshots = new Map<string, ProgressSnapshot>()

  let seq = 0
  /** serverBoard 對應的篩選；載入失敗時若篩選已換，就不再顯示別的篩選的舊資料 */
  let loadedKey: string | null = null
  /** 本機異動序號：student_id → 最後一次更新該生時的 touchClock；touchedKey 為這份紀錄對應的篩選 */
  let touchClock = 0
  const touched = new Map<string, number>()
  let touchedKey: string | null = null

  const currentClassId = (): string | null => classId.value || null
  const filterKey = (): string => `${date.value}|${currentClassId() ?? ''}`

  const board = computed<HomeworkBoard | null>(() => {
    const current = serverBoard.value
    const ov = overrides.value
    if (!current || ov.size === 0) return current
    return { ...current, students: current.students.map((s) => withOverrides(s, ov)) }
  })

  const summary = computed<BoardSummary>(() => {
    const out: BoardSummary = { total: 0, done: 0, in_progress: 0, not_started: 0 }
    for (const s of board.value?.students ?? []) {
      if (s.attendance_status && EXCLUDED_FROM_SUMMARY.has(s.attendance_status)) continue
      out.total += 1
      out[s.progress.overall_status] += 1
    }
    return out
  })

  async function reload(): Promise<void> {
    const mySeq = ++seq
    const key = filterKey()
    const cls = currentClassId()
    const query: HomeworkBoardParams = cls ? { date: date.value, class_id: cls } : { date: date.value }
    if (touchedKey !== key) {
      touched.clear()
      touchedKey = key
    }
    const startedAt = touchClock
    loading.value = true
    try {
      const res = await fetchHomeworkBoard(query)
      if (mySeq !== seq) return
      serverBoard.value = mergeTouched(res, startedAt)
      loadedKey = key
      error.value = null
    } catch (err) {
      if (mySeq !== seq) return
      error.value = errorMessage(err, '無法載入作業看板')
      if (loadedKey !== key) {
        serverBoard.value = null
        loadedKey = null
      }
    } finally {
      if (mySeq === seq) loading.value = false
    }
  }

  /**
   * 回應與目前 serverBoard 合併：回應中有、且 startedAt 之後更新過的學生保留目前的列。
   * reload 開頭已在篩選鍵改變時清空 touched，所以只換班級時（serverBoard 仍是前一個篩選的看板）也照常合併。
   */
  function mergeTouched(res: HomeworkBoard, startedAt: number): HomeworkBoard {
    const current = serverBoard.value
    if (!current) return res
    const newer = new Map(
      current.students
        .filter((s) => (touched.get(s.student_id) ?? 0) > startedAt)
        .map((s) => [s.student_id, s] as const),
    )
    if (!newer.size) return res
    return { ...res, students: res.students.map((s) => newer.get(s.student_id) ?? s) }
  }

  /** 只更新與看板同日、且在看板中的學生 */
  function patchStudent(studentId: string, serviceDate: string, fn: (s: BoardStudent) => BoardStudent): void {
    const current = serverBoard.value
    if (!current || current.date !== serviceDate) return
    const index = current.students.findIndex((s) => s.student_id === studentId)
    if (index < 0) return
    const students = [...current.students]
    students[index] = fn(students[index]!)
    touched.set(studentId, ++touchClock)
    serverBoard.value = { ...current, students }
  }

  function applyItemResult(res: HomeworkItemResult): void {
    patchStudent(res.item.student_id, res.progress.service_date, (s) => ({
      ...s,
      items: upsertItem(s.items, res.item),
      progress: res.progress,
    }))
  }

  function applyProgress(progress: Progress): void {
    patchStudent(progress.student_id, progress.service_date, (s) => ({ ...s, progress }))
  }

  function applySnapshot(snapshot: ProgressSnapshot): void {
    patchStudent(snapshot.student_id, snapshot.service_date, (s) => ({
      ...s,
      items: sortItems(snapshot.items),
      progress: snapshot.progress,
    }))
  }

  function hasPendingChain(studentId: string): boolean {
    for (const chain of chains.values()) if (chain.studentId === studentId) return true
    return false
  }

  function flushDeferred(studentId: string): void {
    if (hasPendingChain(studentId)) return
    const snapshot = deferredSnapshots.get(studentId)
    if (!snapshot) return
    deferredSnapshots.delete(studentId)
    applySnapshot(snapshot)
  }

  function setOverride(itemId: string, status: HomeworkItemStatus | null): void {
    const next = new Map(overrides.value)
    if (status === null) next.delete(itemId)
    else next.set(itemId, status)
    overrides.value = next
  }

  function setPending(itemId: string, pending: boolean): void {
    const next = new Set(pendingItemIds.value)
    if (pending) next.add(itemId)
    else next.delete(itemId)
    pendingItemIds.value = next
  }

  function serverStatusOf(item: HomeworkItem): HomeworkItemStatus {
    const student = serverBoard.value?.students.find((s) => s.student_id === item.student_id)
    return student?.items.find((i) => i.id === item.id)?.status ?? item.status
  }

  async function runChain(item: HomeworkItem, chain: StatusChain): Promise<void> {
    let confirmed = serverStatusOf(item)
    try {
      while (chain.desired !== confirmed) {
        const res = await updateHomeworkItem(item.id, { status: chain.desired })
        applyItemResult(res)
        confirmed = res.item.status
      }
    } catch (err) {
      ElMessage.error(errorMessage(err, '更新作業狀態失敗'))
    } finally {
      chains.delete(item.id)
      setOverride(item.id, null)
      setPending(item.id, false)
      flushDeferred(chain.studentId)
    }
  }

  function setItemStatus(item: HomeworkItem, status: HomeworkItemStatus): Promise<void> {
    setOverride(item.id, status)
    const existing = chains.get(item.id)
    if (existing) {
      existing.desired = status
      return existing.done
    }
    const chain: StatusChain = { studentId: item.student_id, desired: status, done: Promise.resolve() }
    chains.set(item.id, chain)
    setPending(item.id, true)
    chain.done = runChain(item, chain)
    return chain.done
  }

  async function addItem(studentId: string, body: { subject_id?: string | null; title: string }): Promise<void> {
    const payload: HomeworkItemCreate = { student_id: studentId, service_date: date.value, title: body.title }
    if (body.subject_id) payload.subject_id = body.subject_id
    applyItemResult(await createHomeworkItem(payload))
  }

  async function renameItem(item: HomeworkItem, body: { title?: string; subject_id?: string | null }): Promise<void> {
    applyItemResult(await updateHomeworkItem(item.id, body))
  }

  async function removeItem(item: HomeworkItem): Promise<void> {
    const res = await deleteHomeworkItem(item.id)
    patchStudent(item.student_id, res.progress.service_date, (s) => ({
      ...s,
      items: s.items.filter((i) => i.id !== item.id),
      progress: res.progress,
    }))
  }

  async function setProgress(
    studentId: string,
    body: { overall?: 'done' | 'auto'; ready_eta?: string | null; note?: string | null },
  ): Promise<void> {
    const payload: HomeworkProgressUpdate = { service_date: date.value, ...body }
    applyProgress(await updateHomeworkProgress(studentId, payload))
  }

  async function batchAdd(body: { subject_id?: string | null; title: string; student_ids?: string[] }): Promise<number> {
    const cls = currentClassId()
    if (!cls) throw new Error('整班新增作業需要先選擇班級')
    const payload: HomeworkBatchCreate = { class_id: cls, service_date: date.value, title: body.title }
    if (body.subject_id) payload.subject_id = body.subject_id
    if (body.student_ids) payload.student_ids = body.student_ids
    const res = await batchCreateHomeworkItems(payload)
    await reload()
    return res.created
  }

  function onProgressUpdated(snapshot: ProgressSnapshot): void {
    if (!snapshot || snapshot.service_date !== date.value || !Array.isArray(snapshot.items)) return
    if (!serverBoard.value?.students.some((s) => s.student_id === snapshot.student_id)) return
    if (hasPendingChain(snapshot.student_id)) {
      deferredSnapshots.set(snapshot.student_id, snapshot)
      return
    }
    applySnapshot(snapshot)
  }

  const ws = useAdminWsTopic('homework', { 'homework.progress_updated': onProgressUpdated }, { resync: reload })

  watch([date, classId], () => void reload(), { immediate: true })

  return {
    board,
    loading,
    error,
    summary,
    reload,
    addItem,
    setItemStatus,
    renameItem,
    removeItem,
    setProgress,
    batchAdd,
    pendingItemIds,
    wsStatus: ws.status,
    wsDenied: ws.denied,
  }
}
