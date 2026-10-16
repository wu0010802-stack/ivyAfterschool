import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { ScoreCell, ScoresPutResult } from '@/api/exams'
import { adminHttp } from '@/api/http'
import { createApiMock } from '@/test/helpers'
import { useScoreAutosave } from './useScoreAutosave'

const URL = '/admin/exams/e1/scores'
const RESULT: ScoresPutResult = { written: 1, changed: 1, renotified_students: 0 }

function cell(studentId: string, subjectId: string, score: number | null, note: string | null = null): ScoreCell {
  return {
    student_id: studentId,
    subject_id: subjectId,
    score,
    is_absent: false,
    note,
    updated_at: '2026-10-15T01:00:00Z',
  }
}

function invalidResponse(details: { student_id: string; subject_id: string; code: string }[]) {
  return { error: { code: 'invalid_score_cells', message: '部分格子無效', details } }
}

const v = (score: number | null) => ({ score, is_absent: false })

let mock: MockAdapter

/** 推進 fake timers 並清空 promise（axios 與 watch 只靠 microtask；setImmediate 未被 fake） */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
  await flushPromises()
}

function setup(opts: { initial?: ScoreCell[]; notify?: boolean | null; debounceMs?: number } = {}) {
  const examId = ref('e1')
  const initial = ref<ScoreCell[]>(opts.initial ?? [])
  const notifyParents = ref<boolean | null>(opts.notify ?? false)
  const api = useScoreAutosave({ examId, initial, notifyParents, debounceMs: opts.debounceMs })
  return { api, examId, initial, notifyParents }
}

type PutBody = {
  cells: { student_id: string; subject_id: string; score: number | null; is_absent: boolean; note: string | null }[]
  notify_parents: boolean
}

function putBodies(): PutBody[] {
  return mock.history.put.map((c) => JSON.parse(c.data as string) as PutBody)
}

describe('useScoreAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
  })

  it('useScoreAutosave debounces and batches dirty cells', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api } = setup()

    api.edit('s1', 'sub1', v(95))
    expect(api.cellState('s1', 'sub1')).toBe('dirty')
    expect(api.cellValue('s1', 'sub1')).toEqual({ score: 95, is_absent: false, note: null })
    expect(api.hasUnsaved.value).toBe(true)
    await tick(300)
    api.edit('s2', 'sub1', v(88))
    await tick(799)
    expect(mock.history.put).toHaveLength(0)
    expect(api.cellState('s1', 'sub1')).toBe('dirty')

    await tick(1)

    expect(mock.history.put).toHaveLength(1)
    expect(mock.history.put[0]?.url).toBe(URL)
    const body = putBodies()[0]!
    expect(body.notify_parents).toBe(false)
    expect(body.cells).toHaveLength(2)
    expect(body.cells).toEqual([
      { student_id: 's1', subject_id: 'sub1', score: 95, is_absent: false, note: null },
      { student_id: 's2', subject_id: 'sub1', score: 88, is_absent: false, note: null },
    ])
    expect(api.cellState('s1', 'sub1')).toBe('saved')
    expect(api.cellState('s2', 'sub1')).toBe('saved')
    expect(api.cellState('s3', 'sub1')).toBe('idle')
    expect(api.cellValue('s3', 'sub1')).toEqual({ score: null, is_absent: false, note: null })
  })

  it('useScoreAutosave serializes requests and keeps newer edits dirty', async () => {
    let inFlight = 0
    let maxInFlight = 0
    mock.onPut(URL).reply(() => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight -= 1
          resolve([200, RESULT])
        }, 500),
      )
    })
    const { api } = setup()

    api.edit('s1', 'sub1', v(95))
    await tick(800)
    expect(mock.history.put).toHaveLength(1)
    expect(api.cellState('s1', 'sub1')).toBe('saving')
    expect(api.saving.value).toBe(true)

    // 送出後 200ms 再編輯同一格
    await tick(200)
    api.edit('s1', 'sub1', v(96))
    expect(api.cellState('s1', 'sub1')).toBe('dirty')
    expect(api.cellValue('s1', 'sub1').score).toBe(96)

    // 第一個回應（t = 1300）：較新的值不得被標成已儲存；結束後才送第二個請求
    await tick(300)
    expect(api.cellState('s1', 'sub1')).not.toBe('saved')
    expect(api.cellState('s1', 'sub1')).not.toBe('idle')
    expect(api.cellValue('s1', 'sub1').score).toBe(96)
    expect(mock.history.put).toHaveLength(2)
    expect(putBodies()[1]!.cells).toEqual([{ student_id: 's1', subject_id: 'sub1', score: 96, is_absent: false, note: null }])
    expect(api.cellState('s1', 'sub1')).toBe('saving')

    await tick(500)
    expect(api.cellState('s1', 'sub1')).toBe('saved')
    expect(api.cellValue('s1', 'sub1').score).toBe(96)
    expect(maxInFlight).toBe(1)
    expect(mock.history.put).toHaveLength(2)
  })

  it('useScoreAutosave marks invalid cells from details', async () => {
    mock
      .onPut(URL)
      .replyOnce(422, invalidResponse([{ student_id: 's1', subject_id: 'sub1', code: 'score_out_of_range' }]))
      .onPut(URL)
      .reply(200, RESULT)
    const { api } = setup()

    api.edit('s1', 'sub1', v(120))
    api.edit('s2', 'sub1', v(88))
    await tick(800)

    expect(api.cellState('s1', 'sub1')).toBe('error')
    expect(api.cellError('s1', 'sub1')).toBe('分數超出 0~滿分')
    expect(api.cellValue('s1', 'sub1').score).toBe(120)
    // 同批其他格視為未寫入、重送一次（第二個 PUT 只含 s2）
    expect(mock.history.put).toHaveLength(2)
    expect(putBodies()[1]!.cells).toEqual([{ student_id: 's2', subject_id: 'sub1', score: 88, is_absent: false, note: null }])
    expect(api.cellState('s2', 'sub1')).toBe('saved')
    expect(api.cellError('s2', 'sub1')).toBeUndefined()
    expect(api.failedCount.value).toBe(1)
    expect(api.hasUnsaved.value).toBe(true)

    // 重送一次仍是 422（details 沒點名）：標錯誤、不無限重送
    mock.resetHistory()
    mock.onPut(URL).reply(422, invalidResponse([{ student_id: 's1', subject_id: 'sub1', code: 'score_out_of_range' }]))
    api.edit('s3', 'sub1', v(70))
    api.edit('s1', 'sub1', v(130))
    await tick(800)
    await tick(800)
    expect(mock.history.put).toHaveLength(2)
    expect(putBodies()[0]!.cells.map((c) => c.student_id)).toEqual(['s1', 's3'])
    expect(putBodies()[1]!.cells.map((c) => c.student_id)).toEqual(['s3'])
    expect(api.cellState('s3', 'sub1')).toBe('error')
    expect(api.cellError('s3', 'sub1')).toBe('儲存失敗，請重試')
    expect(api.failedCount.value).toBe(2)
  })

  it('useScoreAutosave marks network failures and retries', async () => {
    mock.onPut(URL).networkErrorOnce().onPut(URL).reply(200, RESULT)
    const { api } = setup()

    api.edit('s1', 'sub1', v(95))
    api.edit('s2', 'sub1', v(88))
    await tick(800)

    expect(mock.history.put).toHaveLength(1)
    expect(api.failedCount.value).toBe(2)
    expect(api.cellState('s1', 'sub1')).toBe('error')
    expect(api.cellError('s1', 'sub1')).toBe('儲存失敗，請重試')
    expect(api.cellError('s2', 'sub1')).toBe('儲存失敗，請重試')
    expect(api.hasUnsaved.value).toBe(true)
    expect(api.saving.value).toBe(false)
    // 失敗後不會自己重送
    await tick(2000)
    expect(mock.history.put).toHaveLength(1)

    await api.retryFailed()
    await flushPromises()

    expect(mock.history.put).toHaveLength(2)
    expect(putBodies()[1]!.cells.map((c) => [c.student_id, c.score])).toEqual([
      ['s1', 95],
      ['s2', 88],
    ])
    expect(api.failedCount.value).toBe(0)
    expect(api.cellState('s1', 'sub1')).toBe('saved')
    expect(api.cellState('s2', 'sub1')).toBe('saved')
    expect(api.cellError('s1', 'sub1')).toBeUndefined()
    expect(api.hasUnsaved.value).toBe(false)
  })

  it('useScoreAutosave waits for notify choice on published exam', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api, notifyParents } = setup({ notify: null })

    expect(api.awaitingNotifyChoice.value).toBe(false)
    api.edit('s1', 'sub1', v(95))
    await tick(2000)

    expect(mock.history.put).toHaveLength(0)
    expect(api.awaitingNotifyChoice.value).toBe(true)
    expect(api.cellState('s1', 'sub1')).toBe('dirty')
    expect(api.hasUnsaved.value).toBe(true)

    notifyParents.value = true
    await flushPromises()
    await flushPromises()

    expect(mock.history.put).toHaveLength(1)
    expect(putBodies()[0]!.notify_parents).toBe(true)
    expect(putBodies()[0]!.cells).toHaveLength(1)
    expect(api.awaitingNotifyChoice.value).toBe(false)
    expect(api.cellState('s1', 'sub1')).toBe('saved')

    // 草稿（false）照常送出且 notify_parents false
    mock.resetHistory()
    const draft = setup({ notify: false })
    draft.api.edit('s1', 'sub1', v(90))
    expect(draft.api.awaitingNotifyChoice.value).toBe(false)
    await tick(800)
    expect(putBodies()[0]!.notify_parents).toBe(false)
  })

  it('useScoreAutosave saved returns to idle and hasUnsaved', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api } = setup()

    api.edit('s1', 'sub1', v(95))
    expect(api.hasUnsaved.value).toBe(true)
    await tick(800)

    expect(api.cellState('s1', 'sub1')).toBe('saved')
    expect(api.hasUnsaved.value).toBe(false)
    expect(api.saving.value).toBe(false)
    await tick(999)
    expect(api.cellState('s1', 'sub1')).toBe('saved')
    await tick(1)
    expect(api.cellState('s1', 'sub1')).toBe('idle')
    expect(api.cellValue('s1', 'sub1')).toEqual({ score: 95, is_absent: false, note: null })
    expect(api.hasUnsaved.value).toBe(false)
    expect(api.failedCount.value).toBe(0)
  })

  it('useScoreAutosave maps cell error codes', async () => {
    mock.onPut(URL).reply(
      422,
      invalidResponse([
        { student_id: 's1', subject_id: 'sub1', code: 'student_not_in_exam' },
        { student_id: 's2', subject_id: 'sub1', code: 'subject_not_in_exam' },
        { student_id: 's3', subject_id: 'sub1', code: 'absent_with_score' },
      ]),
    )
    const { api } = setup()

    api.edit('s1', 'sub1', v(95))
    api.edit('s2', 'sub1', v(88))
    api.edit('s3', 'sub1', { score: 70, is_absent: true })
    await tick(800)

    expect(mock.history.put).toHaveLength(1)
    expect(api.cellError('s1', 'sub1')).toBe('學生不在應考名單')
    expect(api.cellError('s2', 'sub1')).toBe('此科目不在考試中')
    expect(api.cellError('s3', 'sub1')).toBe('absent_with_score')
    expect(['s1', 's2', 's3'].map((s) => api.cellState(s, 'sub1'))).toEqual(['error', 'error', 'error'])
    expect(api.failedCount.value).toBe(3)
  })

  it('useScoreAutosave echoes the loaded note', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api } = setup({ initial: [cell('s1', 'sub1', 80, '遲到')] })

    expect(api.cellValue('s1', 'sub1')).toEqual({ score: 80, is_absent: false, note: '遲到' })
    expect(api.cellValue('s2', 'sub1')).toEqual({ score: null, is_absent: false, note: null })
    api.edit('s1', 'sub1', v(90))
    api.edit('s2', 'sub1', v(70))
    await tick(800)

    const cells = putBodies()[0]!.cells
    expect(cells[0]).toEqual({ student_id: 's1', subject_id: 'sub1', score: 90, is_absent: false, note: '遲到' })
    expect(cells[1]).toEqual({ student_id: 's2', subject_id: 'sub1', score: 70, is_absent: false, note: null })
    expect(Object.hasOwn(cells[1]!, 'note')).toBe(true)
    expect(cells[1]!.note).toBeNull()
    expect(api.cellValue('s1', 'sub1')).toEqual({ score: 90, is_absent: false, note: '遲到' })
  })

  it('useScoreAutosave edits note with or without score', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api } = setup({ initial: [cell('s1', 'sub1', 80, '遲到')] })

    api.edit('s1', 'sub1', { score: 80, is_absent: false, note: '補考' })
    expect(api.cellState('s1', 'sub1')).toBe('dirty')
    expect(api.hasUnsaved.value).toBe(true)
    await tick(800)
    expect(mock.history.put).toHaveLength(1)
    expect(putBodies()[0]!.cells[0]).toEqual({
      student_id: 's1',
      subject_id: 'sub1',
      score: 80,
      is_absent: false,
      note: '補考',
    })
    expect(api.cellState('s1', 'sub1')).toBe('saved')
    expect(api.cellValue('s1', 'sub1').note).toBe('補考')

    // 省略 note：沿用目前的備註
    api.edit('s1', 'sub1', { score: 85, is_absent: false })
    await tick(800)
    expect(putBodies()[1]!.cells[0]).toEqual({
      student_id: 's1',
      subject_id: 'sub1',
      score: 85,
      is_absent: false,
      note: '補考',
    })

    // note 給 null：清除備註
    api.edit('s1', 'sub1', { score: 85, is_absent: false, note: null })
    await tick(800)
    expect(putBodies()[2]!.cells[0]).toEqual({
      student_id: 's1',
      subject_id: 'sub1',
      score: 85,
      is_absent: false,
      note: null,
    })
    expect(api.cellValue('s1', 'sub1')).toEqual({ score: 85, is_absent: false, note: null })
  })

  it('useScoreAutosave flush sends pending cells without waiting', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api } = setup()

    await api.flush()
    expect(mock.history.put).toHaveLength(0)

    api.edit('s1', 'sub1', v(95))
    const flushed = api.flush()
    await flushPromises()
    await flushPromises()
    await flushed

    expect(mock.history.put).toHaveLength(1)
    expect(api.cellState('s1', 'sub1')).toBe('saved')
    expect(api.hasUnsaved.value).toBe(false)
    // 原本的 debounce 到期後不會再送一次
    await tick(800)
    expect(mock.history.put).toHaveLength(1)
  })

  it('useScoreAutosave splits batches over two thousand cells', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api } = setup()

    for (let i = 0; i < 2001; i += 1) api.edit(`s${i}`, 'sub1', v(1))
    await tick(800)

    expect(mock.history.put).toHaveLength(2)
    expect(putBodies().map((b) => b.cells.length)).toEqual([2000, 1])
    expect(api.hasUnsaved.value).toBe(false)
    expect(api.cellState('s2000', 'sub1')).toBe('saved')
  })

  it('useScoreAutosave rebases untouched cells when initial reloads', async () => {
    mock.onPut(URL).reply(200, RESULT)
    const { api, initial } = setup({ initial: [cell('s1', 'sub1', 80), cell('s2', 'sub1', 60)] })

    api.edit('s1', 'sub1', v(90))
    await tick(800)
    expect(api.cellState('s1', 'sub1')).toBe('saved')
    api.edit('s2', 'sub1', v(65))
    expect(api.cellState('s2', 'sub1')).toBe('dirty')

    initial.value = [cell('s1', 'sub1', 91), cell('s2', 'sub1', 60)]
    await flushPromises()

    // 已儲存的格子以重新載入的值為準；尚未送出的編輯保留
    expect(api.cellValue('s1', 'sub1').score).toBe(91)
    expect(api.cellState('s1', 'sub1')).toBe('idle')
    expect(api.cellValue('s2', 'sub1').score).toBe(65)
    expect(api.cellState('s2', 'sub1')).toBe('dirty')
  })
})
