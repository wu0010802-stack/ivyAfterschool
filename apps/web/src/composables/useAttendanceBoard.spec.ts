import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { AxiosRequestConfig } from 'axios'
import type MockAdapter from 'axios-mock-adapter'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import type { AttendanceRow, DailyAttendance } from '@/api/attendance'
import { adminHttp } from '@/api/http'
import { useAdminWsStore } from '@/stores/adminWs'
import { createApiMock } from '@/test/helpers'
import { useAttendanceBoard } from './useAttendanceBoard'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  sent: string[] = []
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverMessage(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, sent_at: '2026-10-02T08:00:00Z' }) } as MessageEvent)
  }
}

const DAILY_URL = '/admin/attendance/daily'
const DATE = '2026-10-02'

function makeRow(overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    id: 'a1',
    student_id: 's1',
    student_no: 'S11301',
    student_name: '王小明',
    grade_level: 3,
    class_id: 'c1',
    class_name: '中年級班',
    service_date: DATE,
    status: 'expected',
    check_in_at: null,
    check_in_source: null,
    check_out_at: null,
    check_out_source: null,
    leave: null,
    note: null,
    updated_at: '2026-10-02T05:00:00Z',
    ...overrides,
  }
}

const S1 = makeRow()
const S2 = makeRow({ id: 'a2', student_id: 's2', student_no: 'S11302', student_name: '陳小美' })

function daily(items: AttendanceRow[], date = DATE): DailyAttendance {
  const summary = { total: items.length, expected: 0, present: 0, left: 0, absent: 0, leave: 0 }
  for (const r of items) summary[r.status] += 1
  return { date, is_service_day: true, summary, items }
}

type Board = ReturnType<typeof useAttendanceBoard>

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

async function mountBoard(
  date: Ref<string> = ref(DATE),
  classId: Ref<string | null> = ref(null),
): Promise<{ wrapper: VueWrapper; board: Board }> {
  let board: Board | null = null
  const Page = defineComponent({
    setup() {
      board = useAttendanceBoard({ date, classId })
      return () => h('div')
    },
  })
  const wrapper = mount(Page, { global: { plugins: [pinia] } })
  await settle()
  if (!board) throw new Error('setup 未執行')
  return { wrapper, board }
}

function statusOf(board: Board, studentId: string): string | undefined {
  return board.data.value?.items.find((r) => r.student_id === studentId)?.status
}

function dailyGets(): AxiosRequestConfig[] {
  return mock.history.get.filter((c) => c.url === DAILY_URL)
}

describe('useAttendanceBoard', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    pinia = createPinia()
    setActivePinia(pinia)
    mock = createApiMock(adminHttp)
    const store = useAdminWsStore()
    store.start()
    socket().serverOpen()
  })

  afterEach(() => {
    useAdminWsStore().stop()
    mock.restore()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('useAttendanceBoard check-in applies returned row and recomputes summary', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([S1]))
    const presentS1 = { ...S1, status: 'present', check_in_at: '2026-10-02T06:05:00Z', check_in_source: 'manual' }
    mock.onPost('/admin/attendance/s1/check-in').reply(200, presentS1)
    const { board } = await mountBoard()

    expect(dailyGets()[0]?.params).toEqual({ date: DATE })
    expect(board.data.value?.summary.expected).toBe(1)

    await board.checkIn(S1)

    expect(statusOf(board, 's1')).toBe('present')
    expect(board.data.value?.summary).toEqual({ total: 1, expected: 0, present: 1, left: 0, absent: 0, leave: 0 })
    expect(mock.history.post.map((c) => c.url)).toEqual(['/admin/attendance/s1/check-in'])
  })

  it('useAttendanceBoard ignores duplicate operations while busy', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([S1, S2]))
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.onPost('/admin/attendance/s1/check-in').reply(async () => {
      await gate
      return [200, { ...S1, status: 'present' }]
    })
    const { board } = await mountBoard()

    const first = board.checkIn(S1)
    const second = board.checkIn(S1)
    await settle()

    expect(mock.history.post).toHaveLength(1)
    expect(board.busyIds.value.has('s1')).toBe(true)
    expect(board.busyIds.value.has('s2')).toBe(false)

    release()
    await Promise.all([first, second])
    await settle()

    expect(mock.history.post).toHaveLength(1)
    expect(board.busyIds.value.has('s1')).toBe(false)
    expect(statusOf(board, 's1')).toBe('present')
  })

  it('useAttendanceBoard reloads after conflict', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([S1]))
    mock.onPost('/admin/attendance/s1/check-in').reply(409, {
      error: { code: 'already_checked_in', message: '王小明今天已經到班' },
    })
    mock.onPost('/admin/attendance/s1/mark-absent').reply(422, {
      error: { code: 'validation_error', message: '輸入資料有誤' },
    })
    const { board } = await mountBoard()
    expect(dailyGets()).toHaveLength(1)

    await board.checkIn(S1)
    await settle()

    expect(document.body.textContent).toContain('王小明今天已經到班')
    expect(dailyGets()).toHaveLength(2)
    expect(board.busyIds.value.has('s1')).toBe(false)

    // 非衝突類錯誤只提示，不重抓
    await board.markAbsent(S1)
    await settle()
    expect(document.body.textContent).toContain('輸入資料有誤')
    expect(dailyGets()).toHaveLength(2)
  })

  it('useAttendanceBoard merges ws attendance updates by date and class', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([S1, S2]))
    const { board } = await mountBoard(ref(DATE), ref('c1'))
    expect(dailyGets()[0]?.params).toEqual({ date: DATE, class_id: 'c1' })

    socket().serverMessage('attendance.updated', { ...S2, status: 'present', check_in_at: '2026-10-02T06:10:00Z' })
    await settle()
    expect(statusOf(board, 's2')).toBe('present')
    expect(board.data.value?.summary.present).toBe(1)
    expect(board.data.value?.summary.expected).toBe(1)

    const before = board.data.value?.items
    socket().serverMessage('attendance.updated', { ...S2, class_id: 'c9', status: 'absent' })
    await settle()
    expect(board.data.value?.items).toEqual(before)

    socket().serverMessage('attendance.updated', { ...S2, service_date: '2026-10-01', status: 'left' })
    await settle()
    expect(board.data.value?.items).toEqual(before)

    // batch_updated 逐筆套用同樣的日期 / 班級條件
    socket().serverMessage('attendance.batch_updated', {
      items: [
        { ...S1, status: 'present' },
        { ...S2, class_id: 'c9', status: 'absent' },
      ],
    })
    await settle()
    expect(statusOf(board, 's1')).toBe('present')
    expect(statusOf(board, 's2')).toBe('present')
    expect(board.data.value?.summary).toEqual({ total: 2, expected: 0, present: 2, left: 0, absent: 0, leave: 0 })
    expect(dailyGets()).toHaveLength(1)
  })

  it('useAttendanceBoard inserts unseen ws rows by class and student number', async () => {
    const c1a = makeRow({ id: 'a1', student_id: 's1', student_no: 'S11301', class_id: 'c3', class_name: '中年級班' })
    const c1b = makeRow({ id: 'a3', student_id: 's3', student_no: 'S11303', class_id: 'c3', class_name: '中年級班' })
    const c2a = makeRow({ id: 'a4', student_id: 's4', student_no: 'S11300', class_id: 'c1', class_name: '低年級 A 班' })
    // 後端依班級 sort_order 排序：中年級班在前、低年級 A 班在後
    mock.onGet(DAILY_URL).reply(200, daily([c1a, c1b, c2a]))
    const { board } = await mountBoard()

    socket().serverMessage('attendance.updated', makeRow({ id: 'a5', student_id: 's5', student_no: 'S11302', class_id: 'c3' }))
    socket().serverMessage('attendance.updated', makeRow({ id: 'a6', student_id: 's6', student_no: 'S11399', class_id: 'c1' }))
    socket().serverMessage('attendance.updated', makeRow({ id: 'a7', student_id: 's7', student_no: 'S11201', class_id: 'c8' }))
    await settle()

    expect(board.data.value?.items.map((r) => r.student_id)).toEqual(['s1', 's5', 's3', 's4', 's6', 's7'])
    expect(board.data.value?.summary.total).toBe(6)
  })

  it('useAttendanceBoard reloads on bulk update for current date', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([S1]))
    await mountBoard()
    expect(dailyGets()).toHaveLength(1)

    socket().serverMessage('attendance.bulk_updated', { student_id: 's3', dates: ['2026-10-02', '2026-10-03'] })
    await settle()
    expect(dailyGets()).toHaveLength(2)

    socket().serverMessage('attendance.bulk_updated', { student_id: 's3', dates: ['2026-10-05'] })
    await settle()
    expect(dailyGets()).toHaveLength(2)
  })

  it('useAttendanceBoard uses latest response when filters change', async () => {
    const C1 = makeRow({ student_id: 's1', class_id: 'c1' })
    const C2 = makeRow({ id: 'a9', student_id: 's9', student_no: 'S11309', class_id: 'c2', class_name: '低年級 B 班' })
    const gates: Record<string, () => void> = {}
    mock.onGet(DAILY_URL).reply(async (config: AxiosRequestConfig) => {
      const classId = (config.params as { class_id?: string }).class_id ?? 'all'
      await new Promise<void>((resolve) => {
        gates[classId] = resolve
      })
      if (classId === 'c1') return [200, daily([C1])]
      if (classId === 'c2') return [200, daily([C2])]
      return [200, daily([C1, C2])]
    })
    const classId = ref<string | null>(null)
    const { board } = await mountBoard(ref(DATE), classId)
    gates.all?.()
    await settle()
    expect(board.data.value?.items).toHaveLength(2)

    classId.value = 'c1'
    await settle()
    classId.value = 'c2'
    await settle()
    expect(board.loading.value).toBe(true)

    gates.c2?.()
    await settle()
    gates.c1?.()
    await settle()

    expect(dailyGets().map((c) => c.params)).toEqual([
      { date: DATE },
      { date: DATE, class_id: 'c1' },
      { date: DATE, class_id: 'c2' },
    ])
    expect(board.data.value?.items.map((r) => r.student_id)).toEqual(['s9'])
    expect(board.loading.value).toBe(false)
    expect(board.error.value).toBeNull()
  })

  it('useAttendanceBoard keeps data only for the same filters when load fails', async () => {
    mock
      .onGet(DAILY_URL)
      .replyOnce(200, daily([S1, S2]))
      .onGet(DAILY_URL)
      .reply(500, { error: { code: 'internal_error', message: '伺服器忙碌中' } })
    const classId = ref<string | null>(null)
    const { board } = await mountBoard(ref(DATE), classId)
    expect(board.data.value?.items).toHaveLength(2)

    // 同一篩選重抓失敗（例如斷線輪詢）：保留畫面上的資料
    await board.reload()
    expect(board.error.value).toBe('伺服器忙碌中')
    expect(board.data.value?.items).toHaveLength(2)

    // 換篩選後載入失敗：不再顯示別的篩選的舊資料
    classId.value = 'c1'
    await settle()
    expect(dailyGets().at(-1)?.params).toEqual({ date: DATE, class_id: 'c1' })
    expect(board.error.value).toBe('伺服器忙碌中')
    expect(board.data.value).toBeNull()
    expect(board.loading.value).toBe(false)
  })

  it('useAttendanceBoard batch check-in applies succeeded rows', async () => {
    mock
      .onGet(DAILY_URL)
      .replyOnce(200, daily([S1, S2]))
      .onGet(DAILY_URL)
      .reply(200, daily([{ ...S1, status: 'present' }, { ...S2, status: 'leave' }]))
    mock
      .onPost('/admin/attendance/batch-check-in')
      .replyOnce(200, { succeeded: [{ ...S1, status: 'present' }], skipped: [] })
      .onPost('/admin/attendance/batch-check-in')
      .replyOnce(200, {
        succeeded: [],
        skipped: [{ student_id: 's2', code: 'student_on_leave', message: '學生今日請假' }],
      })
    const { board } = await mountBoard()

    const first = await board.batchCheckIn(['s1'])
    await settle()

    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({ student_ids: ['s1'] })
    expect(first.succeeded.map((r) => r.student_id)).toEqual(['s1'])
    expect(statusOf(board, 's1')).toBe('present')
    expect(board.data.value?.summary.present).toBe(1)
    expect(dailyGets()).toHaveLength(1)

    // 略過原因是畫面過期（學生已請假）：重抓當日資料修正
    const second = await board.batchCheckIn(['s2'])
    await settle()
    expect(second.skipped.map((s) => s.message)).toEqual(['學生今日請假'])
    expect(dailyGets()).toHaveLength(2)
    expect(statusOf(board, 's2')).toBe('leave')
  })

  it('useAttendanceBoard ignores operation result outside current class filter', async () => {
    const C2_S1 = makeRow({ id: 'a1', student_id: 's1', student_no: 'S11301', class_id: 'c2', class_name: '低年級 B 班' })
    const C1_S4 = makeRow({ id: 'a4', student_id: 's4', student_no: 'S11304', class_id: 'c1', class_name: '低年級 A 班' })
    mock.onGet(DAILY_URL).reply((config: AxiosRequestConfig) => {
      const classId = (config.params as { class_id?: string }).class_id
      return [200, classId === 'c1' ? daily([C1_S4]) : daily([C1_S4, C2_S1])]
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.onPost('/admin/attendance/s1/check-in').reply(async () => {
      await gate
      return [200, { ...C2_S1, status: 'present', check_in_at: '2026-10-02T06:05:00Z' }]
    })
    const classId = ref<string | null>(null)
    const { board } = await mountBoard(ref(DATE), classId)

    // 全部班級下對 c2 的 s1 按到班，回應前改選 c1：c1 的清單先回來、到班回應才到
    const pending = board.checkIn(C2_S1)
    classId.value = 'c1'
    await settle()
    expect(board.data.value?.items.map((r) => r.student_id)).toEqual(['s4'])
    release()
    await pending
    await settle()

    expect(board.data.value?.items.map((r) => r.student_id)).toEqual(['s4'])
    expect(board.data.value?.summary).toEqual({ total: 1, expected: 1, present: 0, left: 0, absent: 0, leave: 0 })
    expect(board.busyIds.value.has('s1')).toBe(false)
  })

  it('useAttendanceBoard ignores batch result outside current class filter', async () => {
    const C2_S1 = makeRow({ id: 'a1', student_id: 's1', student_no: 'S11301', class_id: 'c2', class_name: '低年級 B 班' })
    const C1_S4 = makeRow({ id: 'a4', student_id: 's4', student_no: 'S11304', class_id: 'c1', class_name: '低年級 A 班' })
    mock.onGet(DAILY_URL).reply((config: AxiosRequestConfig) => {
      const classId = (config.params as { class_id?: string }).class_id
      return [200, classId === 'c1' ? daily([C1_S4]) : daily([C1_S4, C2_S1])]
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.onPost('/admin/attendance/batch-check-in').reply(async () => {
      await gate
      return [200, { succeeded: [{ ...C2_S1, status: 'present' }, { ...C1_S4, status: 'present' }], skipped: [] }]
    })
    const classId = ref<string | null>(null)
    const { board } = await mountBoard(ref(DATE), classId)

    const pending = board.batchCheckIn(['s1', 's4'])
    classId.value = 'c1'
    await settle()
    release()
    const result = await pending
    await settle()

    // 回傳值照原樣交給呼叫端；清單只套用屬於目前篩選（c1）的列
    expect(result.succeeded.map((r) => r.student_id)).toEqual(['s1', 's4'])
    expect(board.data.value?.items.map((r) => r.student_id)).toEqual(['s4'])
    expect(statusOf(board, 's4')).toBe('present')
    expect(board.data.value?.summary).toEqual({ total: 1, expected: 0, present: 1, left: 0, absent: 0, leave: 0 })
  })

  it('useAttendanceBoard clears error on success and ignores results of another date', async () => {
    const PAST = '2026-10-01'
    const gates: Record<string, () => void> = {}
    let failFirst = true
    mock.onGet(DAILY_URL).reply(async (config: AxiosRequestConfig) => {
      const day = (config.params as { date: string }).date
      if (failFirst) {
        failFirst = false
        return [500, { error: { code: 'internal_error', message: '伺服器忙碌中' } }]
      }
      await new Promise<void>((resolve) => {
        gates[day] = resolve
      })
      return [200, daily([{ ...S1, service_date: day, status: day === PAST ? 'left' : 'expected' }], day)]
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.onPost('/admin/attendance/s1/check-in').reply(async () => {
      await gate
      return [200, { ...S1, status: 'present' }]
    })
    const date = ref(DATE)
    const { board } = await mountBoard(date)
    expect(board.error.value).toBe('伺服器忙碌中')

    const reloading = board.reload()
    await settle()
    gates[DATE]?.()
    await reloading
    expect(board.error.value).toBeNull()
    expect(statusOf(board, 's1')).toBe('expected')

    // 到班回應前切到過去日期（過去日期的清單尚未回來）：2026-10-02 的回傳列不再套用
    const pending = board.checkIn(S1)
    date.value = PAST
    await settle()
    release()
    await pending
    await settle()
    expect(board.data.value?.date).toBe(DATE)
    expect(statusOf(board, 's1')).toBe('expected')

    gates[PAST]?.()
    await settle()
    expect(board.data.value?.date).toBe(PAST)

    // 切回今天、今天的清單尚未回來時收到今天的 ws 列：不套用到畫面上過去日期的清單
    date.value = DATE
    await settle()
    socket().serverMessage('attendance.updated', { ...S2, status: 'present' })
    await settle()
    expect(board.data.value?.date).toBe(PAST)
    expect(board.data.value?.items.map((r) => r.student_id)).toEqual(['s1'])
    gates[DATE]?.()
    await settle()
    expect(board.data.value?.date).toBe(DATE)
  })
})
