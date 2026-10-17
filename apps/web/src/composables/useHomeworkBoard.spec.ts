import { flushPromises, mount } from '@vue/test-utils'
import type { AxiosRequestConfig } from 'axios'
import type MockAdapter from 'axios-mock-adapter'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import type { BoardStudent, HomeworkBoard, HomeworkItem, Progress } from '@/api/homework'
import { adminHttp } from '@/api/http'
import { useAdminWsStore } from '@/stores/adminWs'
import { createApiMock } from '@/test/helpers'
import { useHomeworkBoard } from './useHomeworkBoard'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'

/** 後端事件封包（type + data + sent_at） */
function serverMessage(socket: FakeWebSocket, type: string, data: unknown): void {
  socket.message({ type, data, sent_at: '2026-10-02T08:00:00Z' })
}

const BOARD_URL = '/admin/homework/board'
const DATE = '2026-10-02'

function makeItem(overrides: Partial<HomeworkItem> = {}): HomeworkItem {
  return {
    id: 'h1',
    student_id: 's1',
    service_date: DATE,
    subject_id: null,
    subject_name: null,
    title: '數學習作 p.12-13',
    status: 'todo',
    sort_order: 1,
    updated_at: '2026-10-02T06:00:00Z',
    ...overrides,
  }
}

function makeProgress(overrides: Partial<Progress> = {}): Progress {
  return {
    student_id: 's1',
    service_date: DATE,
    overall_status: 'not_started',
    ready_eta: null,
    note: null,
    eta_updated_at: null,
    eta_updated_by_name: null,
    ...overrides,
  }
}

function makeStudent(overrides: Partial<BoardStudent> = {}): BoardStudent {
  return {
    student_id: 's1',
    student_no: 'S11301',
    name: '王小明',
    class_id: 'c1',
    class_name: '中年級班',
    attendance_status: 'present',
    items: [],
    progress: makeProgress(),
    ...overrides,
  }
}

function boardOf(students: BoardStudent[], date = DATE): HomeworkBoard {
  return {
    date,
    window: { past_days: 30, future_days: 7 },
    summary: { total: 0, done: 0, in_progress: 0, not_started: 0 },
    students,
  }
}

const H1 = makeItem({ id: 'h1', status: 'todo', sort_order: 1 })
const H2 = makeItem({ id: 'h2', title: '國語生字第 5 課', status: 'done', sort_order: 2 })
/** s1：h1 todo、h2 done → in_progress */
const S1 = makeStudent({ items: [H1, H2], progress: makeProgress({ overall_status: 'in_progress' }) })

type Board = ReturnType<typeof useHomeworkBoard>

let mock: MockAdapter
let pinia: Pinia

function socket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1)
  if (!s) throw new Error('尚未建立 socket')
  return s
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountBoard(date: Ref<string> = ref(DATE), classId: Ref<string | null> = ref(null)): Promise<Board> {
  let result: Board | null = null
  const Page = defineComponent({
    setup() {
      result = useHomeworkBoard({ date, classId })
      return () => h('div')
    },
  })
  mount(Page, { global: { plugins: [pinia] } })
  await settle()
  if (!result) throw new Error('setup 未執行')
  return result
}

function studentOf(board: Board, studentId = 's1'): BoardStudent | undefined {
  return board.board.value?.students.find((s) => s.student_id === studentId)
}

function itemOf(board: Board, itemId: string, studentId = 's1'): HomeworkItem | undefined {
  return studentOf(board, studentId)?.items.find((i) => i.id === itemId)
}

function boardGets(): AxiosRequestConfig[] {
  return mock.history.get.filter((c) => c.url === BOARD_URL)
}

/** 手動放行的回應：測試決定 PATCH 何時回來（取代真實延遲，不依賴計時） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('useHomeworkBoard', () => {
  beforeEach(() => {
    installFakeWebSocket()
    pinia = createPinia()
    setActivePinia(pinia)
    mock = createApiMock(adminHttp)
    useAdminWsStore().start()
    socket().open()
  })

  afterEach(() => {
    useAdminWsStore().stop()
    mock.restore()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('useHomeworkBoard optimistic status change recomputes overall', async () => {
    mock.onGet(BOARD_URL).reply(200, boardOf([S1]))
    const gate = deferred<void>()
    mock.onPatch('/admin/homework/items/h1').reply(async () => {
      await gate.promise
      return [
        200,
        {
          item: { ...H1, status: 'done', updated_at: '2026-10-02T07:00:00Z' },
          progress: makeProgress({ overall_status: 'done', ready_eta: '17:30' }),
        },
      ]
    })
    const board = await mountBoard()
    expect(boardGets()[0]?.params).toEqual({ date: DATE })

    const pending = board.setItemStatus(H1, 'done')

    // 樂觀更新：請求回來前就反映在看板上
    expect(itemOf(board, 'h1')?.status).toBe('done')
    expect(studentOf(board)?.progress.overall_status).toBe('done')
    expect(board.pendingItemIds.value.has('h1')).toBe(true)

    gate.resolve()
    await pending
    await settle()

    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({ status: 'done' })
    expect(itemOf(board, 'h1')?.updated_at).toBe('2026-10-02T07:00:00Z')
    expect(studentOf(board)?.progress.ready_eta).toBe('17:30')
    expect(board.pendingItemIds.value.has('h1')).toBe(false)
  })

  it('useHomeworkBoard reverts on failure', async () => {
    mock.onGet(BOARD_URL).reply(200, boardOf([S1]))
    mock.onPatch('/admin/homework/items/h1').reply(500, { error: { code: 'internal_error', message: '伺服器忙碌中' } })
    const board = await mountBoard()

    await board.setItemStatus(H1, 'done')
    await settle()

    expect(itemOf(board, 'h1')?.status).toBe('todo')
    expect(studentOf(board)?.progress.overall_status).toBe('in_progress')
    expect(document.body.textContent).toContain('伺服器忙碌中')
    expect(board.pendingItemIds.value.has('h1')).toBe(false)
  })

  it('useHomeworkBoard reverts to manual done when status change fails', async () => {
    // 手動標記完成（項目推導是 in_progress）：失敗時回到伺服器的整體狀態，不是本地重算
    const manual = makeStudent({ items: [H1, H2], progress: makeProgress({ overall_status: 'done' }) })
    mock.onGet(BOARD_URL).reply(200, boardOf([manual]))
    mock.onPatch('/admin/homework/items/h1').reply(500, { error: { code: 'internal_error', message: '伺服器忙碌中' } })
    const board = await mountBoard()

    const pending = board.setItemStatus(H1, 'doing')
    // 項目異動一律覆蓋手動 done（與後端 recompute_progress 一致）
    expect(studentOf(board)?.progress.overall_status).toBe('in_progress')
    await pending
    await settle()

    expect(itemOf(board, 'h1')?.status).toBe('todo')
    expect(studentOf(board)?.progress.overall_status).toBe('done')
  })

  it('useHomeworkBoard serializes rapid taps on same item', async () => {
    mock.onGet(BOARD_URL).reply(200, boardOf([S1]))
    const gates: { resolve: (v: void) => void }[] = []
    let active = 0
    let maxActive = 0
    mock.onPatch('/admin/homework/items/h1').reply(async (config: AxiosRequestConfig) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const gate = deferred<void>()
      gates.push(gate)
      await gate.promise
      active -= 1
      const status = (JSON.parse(config.data as string) as { status: HomeworkItem['status'] }).status
      return [200, { item: { ...H1, status }, progress: makeProgress({ overall_status: 'in_progress' }) }]
    })
    const board = await mountBoard()

    const calls = [
      board.setItemStatus(H1, 'doing'),
      board.setItemStatus(H1, 'correcting'),
      board.setItemStatus(H1, 'done'),
    ]
    await settle()
    expect(itemOf(board, 'h1')?.status).toBe('done')
    expect(mock.history.patch).toHaveLength(1)

    gates[0]?.resolve()
    await settle()
    expect(mock.history.patch).toHaveLength(2)
    expect(itemOf(board, 'h1')?.status).toBe('done')
    gates[1]?.resolve()
    await Promise.all(calls)
    await settle()

    expect(maxActive).toBe(1)
    expect(mock.history.patch.length).toBeLessThanOrEqual(2)
    expect(JSON.parse(mock.history.patch.at(-1)?.data as string)).toEqual({ status: 'done' })
    expect(itemOf(board, 'h1')?.status).toBe('done')
    expect(board.pendingItemIds.value.size).toBe(0)
  })

  it('useHomeworkBoard applies ws progress for current date only', async () => {
    const other = makeStudent({ student_id: 's2', student_no: 'S11302', name: '陳小美' })
    mock.onGet(BOARD_URL).reply(200, boardOf([S1, other]))
    const board = await mountBoard()

    const threeItems = [
      makeItem({ id: 'h1', status: 'doing', sort_order: 1 }),
      makeItem({ id: 'h2', status: 'done', sort_order: 2 }),
      makeItem({ id: 'h3', title: '英語單字', status: 'todo', sort_order: 3 }),
    ]
    serverMessage(socket(), 'homework.progress_updated', {
      student_id: 's1',
      service_date: DATE,
      items: threeItems,
      progress: makeProgress({ overall_status: 'in_progress', ready_eta: '18:00' }),
    })
    await settle()
    expect(studentOf(board)?.items).toHaveLength(3)
    expect(studentOf(board)?.progress.ready_eta).toBe('18:00')

    serverMessage(socket(), 'homework.progress_updated', {
      student_id: 's1',
      service_date: '2026-10-01',
      items: [],
      progress: makeProgress({ service_date: '2026-10-01', overall_status: 'done', ready_eta: '16:00' }),
    })
    // 不在看板中的學生忽略
    serverMessage(socket(), 'homework.progress_updated', {
      student_id: 's9',
      service_date: DATE,
      items: [makeItem({ id: 'h9', student_id: 's9' })],
      progress: makeProgress({ student_id: 's9' }),
    })
    await settle()
    expect(studentOf(board)?.items).toHaveLength(3)
    expect(studentOf(board)?.progress.ready_eta).toBe('18:00')
    expect(board.board.value?.students.map((s) => s.student_id)).toEqual(['s1', 's2'])
    expect(boardGets()).toHaveLength(1)
  })

  it('useHomeworkBoard defers ws snapshot while item pending', async () => {
    mock.onGet(BOARD_URL).reply(200, boardOf([S1]))
    const gate = deferred<void>()
    mock.onPatch('/admin/homework/items/h1').reply(async () => {
      await gate.promise
      return [200, { item: { ...H1, status: 'done' }, progress: makeProgress({ overall_status: 'done' }) }]
    })
    const board = await mountBoard()

    const pending = board.setItemStatus(H1, 'done')
    // 另一位老師在這期間替 s1 新增了 h3
    serverMessage(socket(), 'homework.progress_updated', {
      student_id: 's1',
      service_date: DATE,
      items: [{ ...H1, status: 'done' }, H2, makeItem({ id: 'h3', title: '英語單字', sort_order: 3 })],
      progress: makeProgress({ overall_status: 'in_progress', ready_eta: '18:30' }),
    })
    await settle()
    expect(studentOf(board)?.items.map((i) => i.id)).toEqual(['h1', 'h2'])
    expect(itemOf(board, 'h1')?.status).toBe('done')

    gate.resolve()
    await pending
    await settle()
    expect(studentOf(board)?.items.map((i) => i.id)).toEqual(['h1', 'h2', 'h3'])
    expect(studentOf(board)?.progress.ready_eta).toBe('18:30')
  })

  it('useHomeworkBoard summary recomputed from students', async () => {
    const withOverall = (id: string, overall: Progress['overall_status'], attendance: BoardStudent['attendance_status']) =>
      makeStudent({
        student_id: id,
        student_no: `S1${id}`,
        attendance_status: attendance,
        progress: makeProgress({ student_id: id, overall_status: overall }),
      })
    mock.onGet(BOARD_URL).reply(200, {
      ...boardOf([
        withOverall('s1', 'done', 'present'),
        withOverall('s2', 'in_progress', 'present'),
        withOverall('s3', 'not_started', 'present'),
        withOverall('s4', 'done', 'present'),
        withOverall('s5', 'done', 'leave'),
        withOverall('s6', 'not_started', 'absent'),
      ]),
      summary: { total: 99, done: 99, in_progress: 99, not_started: 99 },
    })
    const board = await mountBoard()

    expect(board.summary.value).toEqual({ total: 4, done: 2, in_progress: 1, not_started: 1 })
  })

  it('useHomeworkBoard batchAdd reloads board and returns created', async () => {
    mock.onGet(BOARD_URL).reply(200, boardOf([S1]))
    mock.onPost('/admin/homework/items/batch').reply(201, { created: 12, items: [makeItem({ id: 'h7' })] })
    const board = await mountBoard(ref(DATE), ref('c1'))
    expect(boardGets()).toHaveLength(1)

    const created = await board.batchAdd({ subject_id: null, title: '國語第 5 課生字', student_ids: ['s1'] })

    expect(created).toBe(12)
    expect(boardGets()).toHaveLength(2)
    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({
      class_id: 'c1',
      service_date: DATE,
      title: '國語第 5 課生字',
      student_ids: ['s1'],
    })
  })

  it('useHomeworkBoard mutations update student from response', async () => {
    mock.onGet(BOARD_URL).reply(200, boardOf([S1]))
    const added = makeItem({ id: 'h3', title: '英語單字', subject_id: 'sub-en', subject_name: '英語', sort_order: 3 })
    mock.onPost('/admin/homework/items').reply(201, { item: added, progress: makeProgress({ overall_status: 'in_progress' }) })
    mock
      .onPatch('/admin/homework/items/h2')
      .reply(200, { item: { ...H2, title: '國語生字第 6 課' }, progress: makeProgress({ overall_status: 'in_progress' }) })
    mock.onDelete('/admin/homework/items/h1').reply(200, { item: null, progress: makeProgress({ overall_status: 'done' }) })
    mock.onPut('/admin/homework/progress/s1').reply(200, makeProgress({ overall_status: 'done', ready_eta: '17:30' }))
    const board = await mountBoard()

    await board.addItem('s1', { subject_id: 'sub-en', title: '英語單字' })
    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({
      student_id: 's1',
      service_date: DATE,
      subject_id: 'sub-en',
      title: '英語單字',
    })
    expect(studentOf(board)?.items.map((i) => i.id)).toEqual(['h1', 'h2', 'h3'])

    await board.renameItem(H2, { title: '國語生字第 6 課' })
    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({ title: '國語生字第 6 課' })
    expect(itemOf(board, 'h2')?.title).toBe('國語生字第 6 課')

    await board.removeItem(H1)
    expect(mock.history.delete.map((c) => c.url)).toEqual(['/admin/homework/items/h1'])
    expect(studentOf(board)?.items.map((i) => i.id)).toEqual(['h2', 'h3'])
    expect(studentOf(board)?.progress.overall_status).toBe('done')

    await board.setProgress('s1', { ready_eta: '17:30', note: null })
    expect(JSON.parse(mock.history.put[0]?.data as string)).toEqual({ service_date: DATE, ready_eta: '17:30', note: null })
    expect(studentOf(board)?.progress.ready_eta).toBe('17:30')

    // 沒有科目時不送 subject_id；失敗時 reject，由呼叫端顯示訊息
    mock.onPost('/admin/homework/items').reply(422, { error: { code: 'invalid_service_date', message: '日期超出可登記範圍' } })
    await expect(board.addItem('s1', { subject_id: null, title: '自然習作' })).rejects.toMatchObject({
      code: 'invalid_service_date',
    })
    expect(JSON.parse(mock.history.post[1]?.data as string)).toEqual({
      student_id: 's1',
      service_date: DATE,
      title: '自然習作',
    })
    expect(studentOf(board)?.items.map((i) => i.id)).toEqual(['h2', 'h3'])
  })

  it('useHomeworkBoard uses latest response when filters change', async () => {
    const gates: Record<string, () => void> = {}
    mock.onGet(BOARD_URL).reply(async (config: AxiosRequestConfig) => {
      const classId = (config.params as { class_id?: string }).class_id ?? 'all'
      await new Promise<void>((resolve) => {
        gates[classId] = resolve
      })
      const student = makeStudent({ student_id: `s-${classId}`, class_id: classId })
      return [200, boardOf([student])]
    })
    const classId = ref<string | null>(null)
    const board = await mountBoard(ref(DATE), classId)
    gates.all?.()
    await settle()

    classId.value = 'c1'
    await settle()
    classId.value = 'c2'
    await settle()
    expect(board.loading.value).toBe(true)
    gates.c2?.()
    await settle()
    gates.c1?.()
    await settle()

    expect(boardGets().map((c) => c.params)).toEqual([
      { date: DATE },
      { date: DATE, class_id: 'c1' },
      { date: DATE, class_id: 'c2' },
    ])
    expect(board.board.value?.students.map((s) => s.student_id)).toEqual(['s-c2'])
    expect(board.loading.value).toBe(false)
  })

  it('useHomeworkBoard keeps data only for the same filters when load fails', async () => {
    mock
      .onGet(BOARD_URL)
      .replyOnce(200, boardOf([S1]))
      .onGet(BOARD_URL)
      .reply(500, { error: { code: 'internal_error', message: '伺服器忙碌中' } })
    const classId = ref<string | null>(null)
    const board = await mountBoard(ref(DATE), classId)

    await board.reload()
    expect(board.error.value).toBe('伺服器忙碌中')
    expect(board.board.value?.students).toHaveLength(1)

    classId.value = 'c1'
    await settle()
    expect(board.error.value).toBe('伺服器忙碌中')
    expect(board.board.value).toBeNull()
    expect(board.loading.value).toBe(false)
  })

  it('useHomeworkBoard keeps student updated by ws during reload', async () => {
    const S2 = makeStudent({ student_id: 's2', student_no: 'S11302', name: '陳小美' })
    const gate = deferred<void>()
    mock
      .onGet(BOARD_URL)
      .replyOnce(200, boardOf([S1, S2]))
      .onGet(BOARD_URL)
      .reply(async () => {
        await gate.promise
        // 伺服器在 ws 事件之前產生的快照：s1 仍 in_progress；s2 改了預計時間
        return [200, boardOf([S1, { ...S2, progress: makeProgress({ student_id: 's2', ready_eta: '17:30' }) }])]
      })
    const board = await mountBoard()

    const reloading = board.reload()
    await settle()
    const doneItems = [makeItem({ id: 'h1', status: 'done', sort_order: 1 }), { ...H2 }]
    serverMessage(socket(), 'homework.progress_updated', {
      student_id: 's1',
      service_date: DATE,
      items: doneItems,
      progress: makeProgress({ overall_status: 'done' }),
    })
    await settle()
    expect(studentOf(board)?.progress.overall_status).toBe('done')

    gate.resolve()
    await reloading
    await settle()
    expect(studentOf(board)?.progress.overall_status).toBe('done')
    expect(itemOf(board, 'h1')?.status).toBe('done')
    // 沒被動過的 s2 取回應值
    expect(studentOf(board, 's2')?.progress.ready_eta).toBe('17:30')
    expect(board.summary.value).toEqual({ total: 2, done: 1, in_progress: 0, not_started: 1 })
  })

  it('useHomeworkBoard keeps student updated by ws during reload: mutation result applied during reload', async () => {
    const gate = deferred<void>()
    mock
      .onGet(BOARD_URL)
      .replyOnce(200, boardOf([S1]))
      .onGet(BOARD_URL)
      .reply(async () => {
        await gate.promise
        return [200, boardOf([S1])]
      })
    mock.onPut('/admin/homework/progress/s1').reply(200, makeProgress({ overall_status: 'in_progress', ready_eta: '18:10' }))
    const board = await mountBoard()

    const reloading = board.reload()
    await settle()
    await board.setProgress('s1', { ready_eta: '18:10' })
    gate.resolve()
    await reloading
    await settle()
    expect(studentOf(board)?.progress.ready_eta).toBe('18:10')
  })

  it('useHomeworkBoard applies reload students untouched since request', async () => {
    const S2 = makeStudent({ student_id: 's2', student_no: 'S11302', name: '陳小美', items: [makeItem({ id: 'h5', student_id: 's2' })] })
    const S2Next = {
      ...S2,
      items: [makeItem({ id: 'h5', student_id: 's2' }), makeItem({ id: 'h6', student_id: 's2', title: '英語單字', sort_order: 2 })],
    }
    mock.onGet(BOARD_URL).replyOnce(200, boardOf([S1, S2])).onGet(BOARD_URL).reply(200, boardOf([S1, S2Next]))
    const board = await mountBoard()

    // reload 之前 ws 改過 s2；reload 發出後沒有新事件 → 回應整列取代
    serverMessage(socket(), 'homework.progress_updated', {
      student_id: 's2',
      service_date: DATE,
      items: [makeItem({ id: 'h5', student_id: 's2', status: 'doing' })],
      progress: makeProgress({ student_id: 's2', overall_status: 'in_progress' }),
    })
    await settle()
    await board.reload()
    await settle()
    expect(studentOf(board, 's2')?.items).toHaveLength(S2Next.items.length)
    expect(studentOf(board, 's2')?.items.map((i) => i.status)).toEqual(['todo', 'todo'])
    expect(studentOf(board, 's2')?.progress.overall_status).toBe('not_started')
  })

  it('useHomeworkBoard keeps student updated by ws during reload: class filter change', async () => {
    const gate = deferred<void>()
    mock.onGet(BOARD_URL).reply(async (config: AxiosRequestConfig) => {
      if ((config.params as { class_id?: string }).class_id !== 'c1') return [200, boardOf([S1])]
      await gate.promise
      return [200, boardOf([S1])]
    })
    const classId = ref<string | null>(null)
    const board = await mountBoard(ref(DATE), classId)

    // 只換班級（日期不變）：新篩選的 reload 途中收到 ws 快照
    classId.value = 'c1'
    await settle()
    serverMessage(socket(), 'homework.progress_updated', {
      student_id: 's1',
      service_date: DATE,
      items: [H1, H2],
      progress: makeProgress({ overall_status: 'in_progress', ready_eta: '18:20' }),
    })
    await settle()
    expect(studentOf(board)?.progress.ready_eta).toBe('18:20')

    gate.resolve()
    await settle()
    expect(boardGets().at(-1)?.params).toEqual({ date: DATE, class_id: 'c1' })
    expect(studentOf(board)?.progress.ready_eta).toBe('18:20')
  })
})
