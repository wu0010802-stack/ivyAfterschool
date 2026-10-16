// FRONTEND-237：成績格變更佇列、防抖批次 upsert、逐格狀態與重試（domain_spec M8：逐格自動儲存；api_index §11：只送有變動的格子）。
// - edit 標 dirty 並重設 debounce；到期後把所有 dirty 格一次 PUT（最多 2000 格，超過分批、依序送）。
// - 同一時間只有一個 PUT：以單一 running promise 序列化；請求結束後若仍有 dirty（進行中又有編輯、422 後的重送）立刻再送。
// - 每格有版本號（note 與分數共用）：送出時記下 sentVersion，回應只在版本未變時才標 saved / error；
//   請求中再被編輯的格子回應後維持 dirty、下一輪以最新值重送，基準不會被較舊的回應覆蓋。
// - 每格的值是 {score, is_absent, note}：送出時一律帶 note（沒有就是 null），不省略也不帶 undefined；
//   edit 省略 note 時沿用目前的 note。成功後該格的值即新基準；initial 重新載入時丟掉 idle / saved 的格子改用新資料。
// - notifyParents 為 null（已發布且尚未選擇）時不送出，awaitingNotifyChoice 為 true；選擇後立即送出。
import { computed, getCurrentScope, onScopeDispose, reactive, watch, type ComputedRef, type Ref } from 'vue'
import { saveScores, type InvalidScoreCell, type ScoreCell, type ScoreCellInput } from '@/api/exams'
import { isApiError } from '@/shared/types/api'

export interface ScoreCellValue {
  score: number | null
  is_absent: boolean
  note: string | null
}

/** edit 的輸入：note 省略（undefined）時沿用目前的 note；給字串或 null 就改成該值 */
export interface ScoreCellEdit {
  score: number | null
  is_absent: boolean
  note?: string | null
}

export type ScoreCellState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface UseScoreAutosaveOptions {
  examId: Ref<string>
  initial: Ref<ScoreCell[]>
  /** 已發布考試：null = 尚未選擇（此時暫不送出，等待選擇）；草稿固定 false */
  notifyParents: Ref<boolean | null>
  /** 預設 800 */
  debounceMs?: number
}

export interface UseScoreAutosave {
  cellValue: (studentId: string, subjectId: string) => ScoreCellValue
  cellState: (studentId: string, subjectId: string) => ScoreCellState
  cellError: (studentId: string, subjectId: string) => string | undefined
  edit: (studentId: string, subjectId: string, value: ScoreCellEdit) => void
  /** 送出所有未儲存的格子並等請求結束（notifyParents 為 null 時不送） */
  flush: () => Promise<void>
  /** 把 error 的格子改回 dirty 並重新送出 */
  retryFailed: () => Promise<void>
  /** dirty / saving / error 任一 */
  hasUnsaved: ComputedRef<boolean>
  failedCount: ComputedRef<number>
  saving: ComputedRef<boolean>
  awaitingNotifyChoice: ComputedRef<boolean>
}

export const DEFAULT_DEBOUNCE_MS = 800
/** saved 標記停留時間，之後轉 idle */
export const SAVED_MS = 1000
/** PUT /exams/{id}/scores 的 cells 上限（BACKEND-474） */
export const MAX_CELLS_PER_REQUEST = 2000
export const SAVE_FAILED_MESSAGE = '儲存失敗，請重試'

/** 422 invalid_score_cells 的 code → 訊息；未知 code 顯示 code 本身 */
const CELL_ERROR_MESSAGES: Record<string, string> = {
  score_out_of_range: '分數超出 0~滿分',
  student_not_in_exam: '學生不在應考名單',
  subject_not_in_exam: '此科目不在考試中',
}

const EMPTY_VALUE: ScoreCellValue = { score: null, is_absent: false, note: null }

interface CellRecord {
  studentId: string
  subjectId: string
  value: ScoreCellValue
  state: ScoreCellState
  error: string | undefined
  /** 每次 edit +1（note 與分數共用同一個版本號） */
  version: number
  /** 進行中的請求所帶的版本 */
  sentVersion: number
  /** 422 後已以「未寫入」身分重送過一次 */
  retriedAfterInvalid: boolean
  savedTimer: ReturnType<typeof setTimeout> | null
}

function keyOf(studentId: string, subjectId: string): string {
  return `${studentId}\u0000${subjectId}`
}

function isInvalidCell(v: unknown): v is InvalidScoreCell {
  if (v === null || typeof v !== 'object') return false
  const item = v as Partial<InvalidScoreCell>
  return typeof item.student_id === 'string' && typeof item.subject_id === 'string' && typeof item.code === 'string'
}

/** 422 invalid_score_cells → details；其他錯誤回 null */
function invalidCellsOf(err: unknown): InvalidScoreCell[] | null {
  if (!isApiError(err) || err.code !== 'invalid_score_cells') return null
  return Array.isArray(err.details) ? err.details.filter(isInvalidCell) : []
}

export function useScoreAutosave(opts: UseScoreAutosaveOptions): UseScoreAutosave {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const cells = reactive(new Map<string, CellRecord>())

  const baseByKey = computed(() => {
    const map = new Map<string, ScoreCellValue>()
    for (const c of opts.initial.value) {
      map.set(keyOf(c.student_id, c.subject_id), { score: c.score, is_absent: c.is_absent, note: c.note })
    }
    return map
  })

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null

  function clearDebounce(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = null
  }

  function clearSavedTimer(rec: CellRecord): void {
    if (rec.savedTimer !== null) clearTimeout(rec.savedTimer)
    rec.savedTimer = null
  }

  function records(): CellRecord[] {
    return Array.from(cells.values())
  }

  function collectDirty(): CellRecord[] {
    return records().filter((r) => r.state === 'dirty')
  }

  function cellValue(studentId: string, subjectId: string): ScoreCellValue {
    const key = keyOf(studentId, subjectId)
    return { ...(cells.get(key)?.value ?? baseByKey.value.get(key) ?? EMPTY_VALUE) }
  }

  function cellState(studentId: string, subjectId: string): ScoreCellState {
    return cells.get(keyOf(studentId, subjectId))?.state ?? 'idle'
  }

  function cellError(studentId: string, subjectId: string): string | undefined {
    return cells.get(keyOf(studentId, subjectId))?.error
  }

  function edit(studentId: string, subjectId: string, v: ScoreCellEdit): void {
    const key = keyOf(studentId, subjectId)
    const current = cellValue(studentId, subjectId)
    const value: ScoreCellValue = {
      score: v.score,
      is_absent: v.is_absent,
      note: v.note === undefined ? current.note : v.note,
    }
    if (!cells.has(key)) {
      cells.set(key, {
        studentId,
        subjectId,
        value,
        state: 'dirty',
        error: undefined,
        version: 0,
        sentVersion: -1,
        retriedAfterInvalid: false,
        savedTimer: null,
      })
    }
    // 一律透過 reactive 代理修改，直接改放進 Map 的原始物件不會觸發更新
    const rec = cells.get(key)!
    clearSavedTimer(rec)
    rec.value = value
    rec.version += 1
    rec.state = 'dirty'
    rec.error = undefined
    rec.retriedAfterInvalid = false
    clearDebounce()
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void kick()
    }, debounceMs)
  }

  function onSuccess(batch: CellRecord[]): void {
    for (const rec of batch) {
      // 回應前又被編輯：維持 dirty，下一輪以最新值重送
      if (rec.version !== rec.sentVersion) continue
      rec.state = 'saved'
      rec.error = undefined
      rec.retriedAfterInvalid = false
      clearSavedTimer(rec)
      rec.savedTimer = setTimeout(() => {
        rec.savedTimer = null
        if (rec.state === 'saved') rec.state = 'idle'
      }, SAVED_MS)
    }
  }

  function onFailure(batch: CellRecord[], err: unknown): void {
    const invalid = invalidCellsOf(err)
    if (invalid === null) {
      // 網路錯誤 / 5xx / 其他：送出的格子全部標錯，等 retryFailed
      for (const rec of batch) {
        if (rec.version !== rec.sentVersion) continue
        rec.state = 'error'
        rec.error = SAVE_FAILED_MESSAGE
      }
      return
    }
    const codeByKey = new Map(invalid.map((i) => [keyOf(i.student_id, i.subject_id), i.code]))
    for (const rec of batch) {
      if (rec.version !== rec.sentVersion) continue
      const code = codeByKey.get(keyOf(rec.studentId, rec.subjectId))
      if (code !== undefined) {
        rec.state = 'error'
        rec.error = CELL_ERROR_MESSAGES[code] ?? code
        rec.retriedAfterInvalid = false
      } else if (rec.retriedAfterInvalid) {
        // 已重送過一次仍被整批退回：標錯，不再自動重送
        rec.state = 'error'
        rec.error = SAVE_FAILED_MESSAGE
      } else {
        // 整批未寫入：維持 dirty，下一輪重送一次
        rec.state = 'dirty'
        rec.retriedAfterInvalid = true
      }
    }
  }

  async function sendBatch(batch: CellRecord[]): Promise<void> {
    const inputs: ScoreCellInput[] = []
    for (const rec of batch) {
      rec.state = 'saving'
      rec.error = undefined
      rec.sentVersion = rec.version
      inputs.push({
        student_id: rec.studentId,
        subject_id: rec.subjectId,
        score: rec.value.score,
        is_absent: rec.value.is_absent,
        // 後端 upsert 以請求值覆寫 note，沒帶會洗成 NULL：一律明確帶值
        note: rec.value.note,
      })
    }
    try {
      await saveScores(opts.examId.value, { cells: inputs, notify_parents: opts.notifyParents.value === true })
      onSuccess(batch)
    } catch (err) {
      onFailure(batch, err)
    }
  }

  async function runLoop(): Promise<void> {
    while (opts.notifyParents.value !== null) {
      const dirty = collectDirty()
      if (!dirty.length) return
      for (let i = 0; i < dirty.length; i += MAX_CELLS_PER_REQUEST) {
        await sendBatch(dirty.slice(i, i + MAX_CELLS_PER_REQUEST))
      }
    }
  }

  /** 同一時間只有一個送出迴圈；進行中再呼叫就共用同一個 promise */
  function kick(): Promise<void> {
    if (running === null) {
      running = runLoop().finally(() => {
        running = null
      })
    }
    return running
  }

  async function flush(): Promise<void> {
    clearDebounce()
    await kick()
    // 請求期間又有編輯：再送，直到沒有 dirty 或正在等待通知選擇
    while (opts.notifyParents.value !== null && collectDirty().length > 0) {
      clearDebounce()
      await kick()
    }
  }

  async function retryFailed(): Promise<void> {
    for (const rec of records()) {
      if (rec.state !== 'error') continue
      rec.state = 'dirty'
      rec.error = undefined
      rec.retriedAfterInvalid = false
    }
    await flush()
  }

  const hasUnsaved = computed(() =>
    records().some((r) => r.state === 'dirty' || r.state === 'saving' || r.state === 'error'),
  )
  const failedCount = computed(() => records().filter((r) => r.state === 'error').length)
  const saving = computed(() => records().some((r) => r.state === 'saving'))
  const awaitingNotifyChoice = computed(() => opts.notifyParents.value === null && hasUnsaved.value)

  // 選擇通知與否後立即送出等待中的格子
  watch(opts.notifyParents, (value) => {
    if (value === null || collectDirty().length === 0) return
    clearDebounce()
    void kick()
  })

  // 重新載入成績格：已儲存 / 未動過的格子改用新資料，未送出的編輯保留
  watch(opts.initial, () => {
    for (const [key, rec] of Array.from(cells.entries())) {
      if (rec.state !== 'idle' && rec.state !== 'saved') continue
      clearSavedTimer(rec)
      cells.delete(key)
    }
  })

  if (getCurrentScope()) {
    onScopeDispose(() => {
      clearDebounce()
      for (const rec of records()) clearSavedTimer(rec)
    })
  }

  return {
    cellValue,
    cellState,
    cellError,
    edit,
    flush,
    retryFailed,
    hasUnsaved,
    failedCount,
    saving,
    awaitingNotifyChoice,
  }
}
