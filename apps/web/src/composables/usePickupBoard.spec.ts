import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { AxiosRequestConfig } from 'axios'
import type MockAdapter from 'axios-mock-adapter'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import type { AttendanceRow } from '@/api/attendance'
import { adminHttp } from '@/api/http'
import type { StaffAuthorization } from '@/api/pickupAuthorizations'
import type { PickupQueue, PickupRequest, PickupRoster, RosterStudent } from '@/api/pickupRequests'
import { useAdminWsStore } from '@/stores/adminWs'
import { createApiMock } from '@/test/helpers'
import { usePickupBoard, type AuthorizationEvent } from './usePickupBoard'

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

  serverControl(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

const QUEUE_URL = '/admin/pickup/queue'
const ROSTER_URL = '/admin/pickup/roster'
const AUTH_URL = '/admin/pickup/authorizations'
const DATE = '2026-10-02'
/** 台北 2026-10-02 17:00 */
const NOW = Date.parse('2026-10-02T09:00:00Z')

function makeRequest(overrides: Partial<PickupRequest> & { studentId?: string; studentName?: string } = {}): PickupRequest {
  const { studentId = 's1', studentName = '王小明', ...rest } = overrides
  return {
    id: 'r1',
    student: { id: studentId, student_no: 'S11301', name: studentName, grade_level: 1, class_id: 'c1', class_name: '低年級A班' },
    service_date: DATE,
    source: 'parent',
    requested_by_type: 'parent',
    requested_by_name: '王媽媽',
    expected_arrival_at: '17:30',
    status: 'pending',
    homework_status_at_request: 'in_progress',
    current_homework_status: 'in_progress',
    current_ready_eta: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    replied_by_name: null,
    needs_reply: true,
    arrived_at: null,
    completed_at: null,
    completed_by_name: null,
    completion_method: null,
    picked_up_by_name: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-10-02T08:00:00Z',
    ...rest,
  }
}

function makeQueue(open: PickupRequest[] = [], closed: PickupRequest[] = []): PickupQueue {
  const counts = { pending: 0, acknowledged: 0, arrived: 0, needs_reply: 0 }
  for (const r of open) {
    if (r.status === 'pending' || r.status === 'acknowledged' || r.status === 'arrived') counts[r.status] += 1
    if (r.needs_reply) counts.needs_reply += 1
  }
  return { date: DATE, open, closed, counts }
}

function makeStudent(overrides: Partial<RosterStudent> = {}): RosterStudent {
  return {
    student_id: 's1',
    student_no: 'S11301',
    name: '王小明',
    grade_level: 1,
    attendance_status: 'present',
    check_in_at: '2026-10-02T06:20:00Z',
    check_out_at: null,
    leave_type: null,
    homework_status: 'in_progress',
    ready_eta: null,
    open_request: null,
    active_authorization_count: 0,
    ...overrides,
  }
}

function makeRoster(students: RosterStudent[]): PickupRoster {
  return { date: DATE, classes: [{ class_id: 'c1', class_name: '低年級A班', students }] }
}

function makeAuthorization(overrides: Partial<StaffAuthorization> = {}): StaffAuthorization {
  return {
    id: 'pa1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 1, class_id: 'c1', class_name: '低年級A班' },
    student_id: 's1',
    service_date: DATE,
    pickup_person_id: null,
    proxy_name: '陳阿姨',
    proxy_phone: '0912-000-456',
    code_last4: '4821',
    status: 'active',
    effective_status: 'active',
    verified_at: null,
    verification_method: null,
    created_at: '2026-10-02T00:00:00Z',
    photo_url: null,
    code_attempts: 0,
    locked: false,
    verified_by_name: null,
    ...overrides,
  }
}

/** ws pickup.authorization_updated 的 data：後端 PickupAuthorizationOut（BACKEND-420），沒有 student / photo_url / code_attempts / locked / verified_by_name */
function makeAuthorizationEvent(overrides: Partial<AuthorizationEvent> = {}): AuthorizationEvent {
  return {
    id: 'pa1',
    student_id: 's1',
    service_date: DATE,
    pickup_person_id: null,
    proxy_name: '陳阿姨',
    proxy_phone: '0912-000-456',
    code_last4: '4821',
    status: 'active',
    effective_status: 'active',
    verified_at: null,
    verification_method: null,
    created_at: '2026-10-02T00:00:00Z',
    ...overrides,
  }
}

function makeAttendanceRow(overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    id: 'a1',
    student_id: 's1',
    student_no: 'S11301',
    student_name: '王小明',
    grade_level: 1,
    class_id: 'c1',
    class_name: '低年級A班',
    service_date: DATE,
    status: 'present',
    check_in_at: '2026-10-02T06:20:00Z',
    check_in_source: 'manual',
    check_out_at: null,
    check_out_source: null,
    leave: null,
    note: null,
    updated_at: '2026-10-02T06:20:00Z',
    ...overrides,
  }
}

type Board = ReturnType<typeof usePickupBoard>

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

async function mountBoard(opts?: Parameters<typeof usePickupBoard>[0]): Promise<{ wrapper: VueWrapper; board: Board }> {
  let board: Board | null = null
  const Page = defineComponent({
    setup() {
      board = usePickupBoard(opts)
      return () => h('div')
    },
  })
  const wrapper = mount(Page, { global: { plugins: [pinia] } })
  await settle()
  if (!board) throw new Error('setup 未執行')
  return { wrapper, board }
}

function gets(url: string): AxiosRequestConfig[] {
  return mock.history.get.filter((c) => c.url === url)
}

function rosterStudent(board: Board, studentId: string): RosterStudent | undefined {
  return board.roster.value?.classes.flatMap((c) => c.students).find((s) => s.student_id === studentId)
}

function openIds(board: Board): string[] {
  return board.queue.value?.open.map((r) => r.id) ?? []
}

function mockAll(queue: PickupQueue, roster: PickupRoster = makeRoster([]), auths: StaffAuthorization[] = []): void {
  mock.onGet(QUEUE_URL).reply(200, queue)
  mock.onGet(ROSTER_URL).reply(200, roster)
  mock.onGet(AUTH_URL).reply(200, auths)
}

describe('usePickupBoard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
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
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('usePickupBoard loads queue roster and authorizations', async () => {
    const r1 = makeRequest()
    mockAll(makeQueue([r1]), makeRoster([makeStudent()]), [makeAuthorization()])
    const { board } = await mountBoard({ withRoster: true, withAuthorizations: true })

    expect(gets(QUEUE_URL)).toHaveLength(1)
    expect(gets(ROSTER_URL)).toHaveLength(1)
    expect(gets(AUTH_URL)).toHaveLength(1)
    for (const url of [QUEUE_URL, ROSTER_URL, AUTH_URL]) {
      expect((gets(url)[0]?.params as { date?: string }).date).toBe(DATE)
    }
    expect(openIds(board)).toEqual(['r1'])
    expect(rosterStudent(board, 's1')?.name).toBe('王小明')
    expect(board.authorizations.value.map((a) => a.id)).toEqual(['pa1'])
    expect(board.loading.value).toBe(false)
    expect(board.error.value).toBeNull()

    // 只訂閱 pickup + roster 的 attendance / homework
    const subscribed = socket()
      .sent.map((s) => JSON.parse(s) as { action: string; topics: string[] })
      .filter((m) => m.action === 'subscribe')
      .flatMap((m) => m.topics)
    expect([...subscribed].sort()).toEqual(['attendance', 'homework', 'pickup'])
  })

  it('usePickupBoard skips roster and authorizations when not requested', async () => {
    mock.onGet(QUEUE_URL).reply(200, makeQueue())
    const { board } = await mountBoard()

    expect(gets(QUEUE_URL)).toHaveLength(1)
    expect(gets(ROSTER_URL)).toHaveLength(0)
    expect(gets(AUTH_URL)).toHaveLength(0)
    expect(board.roster.value).toBeNull()
    expect(board.authorizations.value).toEqual([])
    const subscribed = socket()
      .sent.map((s) => JSON.parse(s) as { action: string; topics: string[] })
      .filter((m) => m.action === 'subscribe')
      .flatMap((m) => m.topics)
    expect(subscribed).toEqual(['pickup'])
  })

  it('usePickupBoard ws update moves request to closed and patches roster', async () => {
    const r1 = makeRequest()
    const s1 = makeStudent({ open_request: { id: 'r1', status: 'pending', expected_arrival_at: '17:30', needs_reply: true } })
    // 已結束清單原本就有一筆：新的終態要放最前
    const r0 = makeRequest({ id: 'r0', studentId: 's0', status: 'completed', completed_at: '2026-10-02T08:30:00Z' })
    mockAll(makeQueue([r1], [r0]), makeRoster([s1]))
    const { board } = await mountBoard({ withRoster: true })
    expect(board.queue.value?.closed.map((r) => r.id)).toEqual(['r0'])

    socket().serverMessage('pickup.request_updated', {
      ...r1,
      status: 'completed',
      completed_at: '2026-10-02T09:20:00Z',
      completed_by_name: '陳老師',
      completion_method: 'guardian',
      picked_up_by_name: '王媽媽',
      needs_reply: false,
    })
    await settle()

    expect(openIds(board)).not.toContain('r1')
    expect(board.queue.value?.closed.map((r) => r.id)).toEqual(['r1', 'r0'])
    expect(board.queue.value?.closed[0]?.status).toBe('completed')
    expect(rosterStudent(board, 's1')?.open_request).toBeNull()
    expect(rosterStudent(board, 's1')?.attendance_status).toBe('left')
    expect(board.counts.value).toEqual({ pending: 0, acknowledged: 0, arrived: 0, needs_reply: 0 })
  })

  it('usePickupBoard keeps newer open request on roster when an older request ends', async () => {
    const r2 = makeRequest({ id: 'r2', created_at: '2026-10-02T08:30:00Z' })
    const s1 = makeStudent({ open_request: { id: 'r2', status: 'pending', expected_arrival_at: '17:30', needs_reply: true } })
    mockAll(makeQueue([r2]), makeRoster([s1]))
    const { board } = await mountBoard({ withRoster: true })

    // 同一學生稍早那筆（不在佇列）的終態晚到：只收進 closed，不可清掉名單上較新的進行中請求
    socket().serverMessage(
      'pickup.request_updated',
      makeRequest({ id: 'r1', status: 'cancelled', cancelled_at: '2026-10-02T08:50:00Z', created_at: '2026-10-02T07:00:00Z' }),
    )
    await settle()

    expect(board.queue.value?.closed.map((r) => r.id)).toEqual(['r1'])
    expect(openIds(board)).toEqual(['r2'])
    expect(rosterStudent(board, 's1')?.open_request?.id).toBe('r2')
    expect(rosterStudent(board, 's1')?.attendance_status).toBe('present')
  })

  it('usePickupBoard upserts open request into queue and roster', async () => {
    const r1 = makeRequest()
    const s1 = makeStudent({ open_request: { id: 'r1', status: 'pending', expected_arrival_at: '17:30', needs_reply: true } })
    mockAll(makeQueue([r1]), makeRoster([s1]))
    const { board } = await mountBoard({ withRoster: true })

    socket().serverMessage('pickup.request_updated', {
      ...r1,
      status: 'acknowledged',
      needs_reply: false,
      reply_ready_eta: '17:45',
      reply_message: '預計 17:45 可接送',
      reply_source: 'staff',
    })
    await settle()

    expect(board.queue.value?.open).toHaveLength(1)
    expect(board.queue.value?.open[0]?.status).toBe('acknowledged')
    expect(board.queue.value?.open[0]?.reply_message).toBe('預計 17:45 可接送')
    expect(rosterStudent(board, 's1')?.open_request).toEqual({
      id: 'r1',
      status: 'acknowledged',
      expected_arrival_at: '17:30',
      needs_reply: false,
    })
    expect(board.counts.value).toEqual({ pending: 0, acknowledged: 1, arrived: 0, needs_reply: 0 })

    // 非今天的請求忽略
    socket().serverMessage('pickup.request_updated', makeRequest({ id: 'r8', studentId: 's8', service_date: '2026-10-01' }))
    await settle()
    expect(openIds(board)).toEqual(['r1'])
  })

  it('usePickupBoard terminal state is not overwritten by stale open message', async () => {
    const r1 = makeRequest()
    mockAll(makeQueue([r1]))
    const { board } = await mountBoard()

    socket().serverMessage('pickup.request_updated', { ...r1, status: 'completed', completed_at: '2026-10-02T09:20:00Z' })
    await settle()
    socket().serverMessage('pickup.request_updated', { ...r1, status: 'acknowledged', needs_reply: false })
    await settle()

    expect(openIds(board)).toEqual([])
    expect(board.queue.value?.closed.map((r) => r.id)).toEqual(['r1'])
    expect(board.queue.value?.closed[0]?.status).toBe('completed')
    expect(board.counts.value.acknowledged).toBe(0)
  })

  it('usePickupBoard ignores open message older than current open state', async () => {
    const r1 = makeRequest({ status: 'arrived', arrived_at: '2026-10-02T08:50:00Z', needs_reply: false })
    mockAll(makeQueue([r1]))
    const { board } = await mountBoard()

    socket().serverMessage('pickup.request_updated', { ...r1, status: 'acknowledged', arrived_at: null })
    await settle()

    expect(board.queue.value?.open[0]?.status).toBe('arrived')
    expect(board.counts.value).toEqual({ pending: 0, acknowledged: 0, arrived: 1, needs_reply: 0 })
  })

  it('usePickupBoard fires arrived and new request hooks', async () => {
    mockAll(makeQueue([makeRequest()]))
    const { board } = await mountBoard()
    const fa = vi.fn()
    const fn = vi.fn()
    board.onArrived(fa)
    board.onNewRequest(fn)

    const r2 = makeRequest({ id: 'r2', studentId: 's2', studentName: '陳小美' })
    socket().serverMessage('pickup.request_updated', r2)
    await settle()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn.mock.calls[0]?.[0]?.id).toBe('r2')
    expect(fa).not.toHaveBeenCalled()

    // 同一筆 pending 再收到一次（例如回覆更新）不再當新請求
    socket().serverMessage('pickup.request_updated', { ...r2, reply_message: '預計 17:45 可接送', reply_source: 'auto' })
    await settle()
    expect(fn).toHaveBeenCalledTimes(1)

    const arrived = { ...r2, status: 'arrived', arrived_at: '2026-10-02T09:10:00Z', needs_reply: false }
    socket().serverMessage('pickup.request_updated', arrived)
    await settle()
    expect(fa).toHaveBeenCalledTimes(1)
    expect(fa.mock.calls[0]?.[0]?.id).toBe('r2')

    socket().serverMessage('pickup.request_updated', arrived)
    await settle()
    expect(fa).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledTimes(1)

    // 解除後不再呼叫
    const offArrived = board.onArrived(vi.fn())
    offArrived()
    const r3 = makeRequest({ id: 'r3', studentId: 's3', status: 'arrived', arrived_at: '2026-10-02T09:15:00Z' })
    socket().serverMessage('pickup.request_updated', r3)
    await settle()
    expect(fa).toHaveBeenCalledTimes(2)
  })

  it('usePickupBoard handles request created directly as arrived', async () => {
    const s5 = makeStudent({ student_id: 's5', student_no: 'S11305', name: '李承恩' })
    mockAll(makeQueue([makeRequest()]), makeRoster([makeStudent(), s5]))
    const { board } = await mountBoard({ withRoster: true })
    const fa = vi.fn()
    const fn = vi.fn()
    board.onArrived(fa)
    board.onNewRequest(fn)
    expect(board.counts.value.arrived).toBe(0)

    socket().serverMessage('pickup.request_updated', {
      ...makeRequest({ id: 'r5', studentId: 's5', studentName: '李承恩' }),
      status: 'arrived',
      expected_arrival_at: null,
      arrived_at: '2026-10-02T09:00:00Z',
      source: 'parent',
      needs_reply: false,
    })
    await settle()

    expect(openIds(board)).toContain('r5')
    expect(rosterStudent(board, 's5')?.open_request?.status).toBe('arrived')
    expect(fa).toHaveBeenCalledTimes(1)
    expect(fa.mock.calls[0]?.[0]?.id).toBe('r5')
    expect(fn).toHaveBeenCalledTimes(0)
    expect(board.counts.value.arrived).toBe(1)
  })

  it('usePickupBoard mutation applies returned request', async () => {
    const r1 = makeRequest()
    const s1 = makeStudent({ open_request: { id: 'r1', status: 'pending', expected_arrival_at: '17:30', needs_reply: true } })
    mockAll(makeQueue([r1]), makeRoster([s1]))
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, {
      ...r1,
      needs_reply: false,
      reply_ready_eta: '17:45',
      reply_message: '預計 17:45 可接送',
      reply_source: 'staff',
      replied_by_name: '陳老師',
    })
    mock.onPost('/admin/pickup/requests/r1/acknowledge').reply(200, { ...r1, status: 'acknowledged', needs_reply: false })
    mock.onPost('/admin/pickup/requests/r1/complete').reply(200, {
      ...r1,
      status: 'completed',
      completed_at: '2026-10-02T09:20:00Z',
      completion_method: 'guardian',
    })
    mock.onPost('/admin/pickup/requests').reply(201, makeRequest({ id: 'r9', studentId: 's9', source: 'staff' }))
    const { board } = await mountBoard({ withRoster: true })

    const replied = await board.reply('r1', { reply_ready_eta: '17:45' })
    expect(replied?.reply_ready_eta).toBe('17:45')
    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({ reply_ready_eta: '17:45' })
    expect(board.queue.value?.open[0]?.needs_reply).toBe(false)
    expect(board.counts.value.needs_reply).toBe(0)
    expect(rosterStudent(board, 's1')?.open_request?.needs_reply).toBe(false)

    const acked = await board.acknowledge('r1')
    expect(acked?.status).toBe('acknowledged')
    expect(board.counts.value).toEqual({ pending: 0, acknowledged: 1, arrived: 0, needs_reply: 0 })

    const created = await board.create({ student_id: 's9' })
    expect(created?.id).toBe('r9')
    expect(JSON.parse(mock.history.post.at(-1)?.data as string)).toEqual({ student_id: 's9' })
    expect(openIds(board)).toEqual(['r1', 'r9'])

    const completed = await board.complete('r1', { method: 'guardian', guardian_id: 'g1' })
    expect(completed?.status).toBe('completed')
    expect(JSON.parse(mock.history.post.at(-1)?.data as string)).toEqual({ method: 'guardian', guardian_id: 'g1' })
    expect(openIds(board)).toEqual(['r9'])
    expect(board.queue.value?.closed[0]?.id).toBe('r1')
    expect(rosterStudent(board, 's1')?.attendance_status).toBe('left')
    expect(gets(QUEUE_URL)).toHaveLength(1)
  })

  it('usePickupBoard handles invalid status conflict', async () => {
    mockAll(makeQueue([makeRequest()]))
    mock.onPost('/admin/pickup/requests/r1/acknowledge').reply(409, {
      error: { code: 'invalid_pickup_status', message: '請求狀態已變更', details: { current_status: 'cancelled' } },
    })
    const { board } = await mountBoard()
    expect(gets(QUEUE_URL)).toHaveLength(1)

    await expect(board.acknowledge('r1')).resolves.toBeNull()
    await settle()

    expect(document.body.textContent).toContain('此請求狀態已變更（目前：已取消）')
    expect(gets(QUEUE_URL)).toHaveLength(2)
  })

  it('usePickupBoard handles request not found', async () => {
    mockAll(makeQueue([makeRequest()]))
    mock.onPost('/admin/pickup/requests/r1/acknowledge').reply(404, {
      error: { code: 'pickup_request_not_found', message: '找不到接送請求', details: null },
    })
    const { board } = await mountBoard()
    expect(gets(QUEUE_URL)).toHaveLength(1)

    await expect(board.acknowledge('r1')).resolves.toBeNull()
    await settle()

    expect(document.body.textContent).toContain('此接送請求已不存在，已重新整理')
    expect(gets(QUEUE_URL)).toHaveLength(2)
  })

  it('usePickupBoard rethrows other mutation errors', async () => {
    mockAll(makeQueue([makeRequest()]))
    mock.onPost('/admin/pickup/requests/r1/reply').reply(422, {
      error: { code: 'validation_error', message: '至少要填預計時間或訊息', details: [] },
    })
    mock.onPost('/admin/pickup/requests').reply(409, {
      error: { code: 'pickup_request_exists', message: '此學生今天已有進行中的接送請求', details: { request_id: 'r1', status: 'pending' } },
    })
    const { board } = await mountBoard()

    await expect(board.reply('r1', {})).rejects.toMatchObject({ code: 'validation_error' })
    await expect(board.create({ student_id: 's1' })).rejects.toMatchObject({ code: 'pickup_request_exists' })
    expect(gets(QUEUE_URL)).toHaveLength(1)
    expect(document.body.textContent).not.toContain('已重新整理')
  })

  it('usePickupBoard recomputes counts from open list', async () => {
    const queue = makeQueue([
      makeRequest({ id: 'r1', studentId: 's1', status: 'pending', needs_reply: true }),
      makeRequest({ id: 'r2', studentId: 's2', status: 'acknowledged', needs_reply: false }),
      makeRequest({ id: 'r3', studentId: 's3', status: 'arrived', arrived_at: '2026-10-02T08:50:00Z', needs_reply: false }),
    ])
    // 後端回的 counts 故意不一致，確認是由 open 重算
    queue.counts = { pending: 9, acknowledged: 9, arrived: 9, needs_reply: 9 }
    mockAll(queue)
    const { board } = await mountBoard()

    expect(board.counts.value).toEqual({ pending: 1, acknowledged: 1, arrived: 1, needs_reply: 1 })
  })

  it('usePickupBoard patches roster from attendance and homework events', async () => {
    const s1 = makeStudent()
    const s2 = makeStudent({ student_id: 's2', student_no: 'S11302', name: '陳小美', attendance_status: 'expected', check_in_at: null })
    mockAll(makeQueue(), makeRoster([s1, s2]))
    const { board } = await mountBoard({ withRoster: true })

    socket().serverMessage(
      'attendance.updated',
      makeAttendanceRow({ student_id: 's2', status: 'present', check_in_at: '2026-10-02T08:30:00Z' }),
    )
    await settle()
    expect(rosterStudent(board, 's2')?.attendance_status).toBe('present')
    expect(rosterStudent(board, 's2')?.check_in_at).toBe('2026-10-02T08:30:00Z')

    socket().serverMessage('attendance.batch_updated', {
      items: [
        makeAttendanceRow({
          student_id: 's1',
          status: 'leave',
          leave: { id: 'l1', leave_type: 'sick', leave_type_label: '病假', start_date: DATE, end_date: DATE },
        }),
      ],
    })
    await settle()
    expect(rosterStudent(board, 's1')?.attendance_status).toBe('leave')
    expect(rosterStudent(board, 's1')?.leave_type).toBe('sick')

    // 非今天的出勤變動忽略
    socket().serverMessage('attendance.updated', makeAttendanceRow({ student_id: 's2', status: 'absent', service_date: '2026-10-01' }))
    await settle()
    expect(rosterStudent(board, 's2')?.attendance_status).toBe('present')

    socket().serverMessage('homework.progress_updated', {
      student_id: 's2',
      service_date: DATE,
      items: [],
      progress: {
        student_id: 's2',
        service_date: DATE,
        overall_status: 'done',
        ready_eta: '17:20',
        note: null,
        eta_updated_at: null,
        eta_updated_by_name: null,
      },
    })
    await settle()
    expect(rosterStudent(board, 's2')?.homework_status).toBe('done')
    expect(rosterStudent(board, 's2')?.ready_eta).toBe('17:20')

    // 請假套用（bulk_updated）含今天 → 重抓名單
    expect(gets(ROSTER_URL)).toHaveLength(1)
    socket().serverMessage('attendance.bulk_updated', { student_id: 's1', dates: [DATE, '2026-10-03'] })
    await settle()
    expect(gets(ROSTER_URL)).toHaveLength(2)
    expect(gets(QUEUE_URL)).toHaveLength(1)
  })

  it('usePickupBoard falls back to roster polling when homework topic denied', async () => {
    mockAll(makeQueue(), makeRoster([makeStudent()]))
    await mountBoard({ withRoster: true })
    expect(gets(ROSTER_URL)).toHaveLength(1)

    socket().serverControl({ type: 'error', code: 'permission_denied', topics: ['homework'] })
    await settle()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(gets(ROSTER_URL)).toHaveLength(2)
    expect(gets(QUEUE_URL)).toHaveLength(1)
    expect((gets(ROSTER_URL)[1]?.params as { date?: string }).date).toBe(DATE)
  })

  it('usePickupBoard does not poll roster when topics are granted', async () => {
    mockAll(makeQueue(), makeRoster([makeStudent()]))
    await mountBoard({ withRoster: true })

    await vi.advanceTimersByTimeAsync(60_000 * 3)
    expect(gets(ROSTER_URL)).toHaveLength(1)
    expect(gets(QUEUE_URL)).toHaveLength(1)
  })

  it('usePickupBoard refetches authorizations on authorization event', async () => {
    const pa1 = makeAuthorization()
    const pa1Done = makeAuthorization({
      status: 'completed',
      effective_status: 'completed',
      verification_method: 'code',
      verified_by_name: '張主任',
      verified_at: '2026-10-02T09:05:00Z',
    })
    const pa2 = makeAuthorization({ id: 'pa2', proxy_name: '林阿姨', code_last4: '1185', photo_url: 'https://storage/p.jpg', code_attempts: 1 })
    const pa4 = makeAuthorization({ id: 'pa4', proxy_name: '吳伯伯', code_last4: '5531', locked: true, code_attempts: 5 })
    mock.onGet(QUEUE_URL).reply(200, makeQueue())
    mock.onGet(ROSTER_URL).reply(200, makeRoster([makeStudent({ active_authorization_count: 1 })]))
    mock
      .onGet(AUTH_URL)
      .replyOnce(200, [pa1])
      .onGet(AUTH_URL)
      .replyOnce(200, [pa1Done, pa2, pa4])
    const { board } = await mountBoard({ withRoster: true, withAuthorizations: true })
    expect(gets(AUTH_URL)).toHaveLength(1)
    expect(rosterStudent(board, 's1')?.active_authorization_count).toBe(1)

    // 另一台平板核驗成功：後端推的是家長端形狀（沒有 student / photo_url / code_attempts / locked / verified_by_name）
    socket().serverMessage(
      'pickup.authorization_updated',
      makeAuthorizationEvent({ status: 'completed', effective_status: 'completed', verification_method: 'code', verified_at: '2026-10-02T09:05:00Z' }),
    )
    await settle()

    expect(gets(AUTH_URL)).toHaveLength(2)
    expect((gets(AUTH_URL)[1]?.params as { date?: string }).date).toBe(DATE)
    // 清單只採用 436 的回應：學生摘要、照片、錯誤次數、鎖定、核驗人都齊，沒有被事件物件取代
    expect(board.authorizations.value.map((a) => a.id)).toEqual(['pa1', 'pa2', 'pa4'])
    expect(board.authorizations.value.every((a) => a.student?.name === '王小明')).toBe(true)
    expect(board.authorizations.value[0]?.effective_status).toBe('completed')
    expect(board.authorizations.value[0]?.verified_by_name).toBe('張主任')
    expect(board.authorizations.value[1]?.photo_url).toBe('https://storage/p.jpg')
    expect(board.authorizations.value[1]?.code_attempts).toBe(1)
    expect(board.authorizations.value[2]?.locked).toBe(true)
    // roster 以新清單重算：pa2、pa4 為 active
    expect(rosterStudent(board, 's1')?.active_authorization_count).toBe(2)
    expect(gets(ROSTER_URL)).toHaveLength(1)

    // 非今天的授權事件忽略
    socket().serverMessage('pickup.authorization_updated', makeAuthorizationEvent({ id: 'pa3', service_date: '2026-10-03' }))
    await settle()
    expect(gets(AUTH_URL)).toHaveLength(2)
  })

  it('usePickupBoard keeps latest authorization list when refetch responses arrive out of order', async () => {
    mock.onGet(QUEUE_URL).reply(200, makeQueue())
    const gates: Record<number, () => void> = {}
    let calls = 0
    mock.onGet(AUTH_URL).reply(async () => {
      const n = ++calls
      if (n === 1) return [200, [makeAuthorization()]]
      await new Promise<void>((resolve) => {
        gates[n] = resolve
      })
      return [200, [makeAuthorization({ code_attempts: n })]]
    })
    const { board } = await mountBoard({ withAuthorizations: true })
    expect(board.authorizations.value[0]?.code_attempts).toBe(0)

    socket().serverMessage('pickup.authorization_updated', makeAuthorizationEvent())
    socket().serverMessage('pickup.authorization_updated', makeAuthorizationEvent())
    await settle()
    expect(gets(AUTH_URL)).toHaveLength(3)

    // 較新的那次先回
    gates[3]?.()
    await settle()
    expect(board.authorizations.value[0]?.code_attempts).toBe(3)

    // 較舊的那次晚到：不覆蓋
    gates[2]?.()
    await settle()
    expect(board.authorizations.value[0]?.code_attempts).toBe(3)
  })

  it('usePickupBoard refetches roster on authorization event when authorizations are not loaded', async () => {
    mock.onGet(QUEUE_URL).reply(200, makeQueue())
    mock
      .onGet(ROSTER_URL)
      .replyOnce(200, makeRoster([makeStudent({ active_authorization_count: 0 })]))
      .onGet(ROSTER_URL)
      .replyOnce(200, makeRoster([makeStudent({ active_authorization_count: 1 })]))
      .onGet(ROSTER_URL)
      .replyOnce(200, makeRoster([makeStudent({ active_authorization_count: 0 })]))
    mock.onGet(AUTH_URL).reply(200, [makeAuthorization()])
    const first = await mountBoard({ withRoster: true })
    const { board } = first
    expect(rosterStudent(board, 's1')?.active_authorization_count).toBe(0)

    socket().serverMessage('pickup.authorization_updated', makeAuthorizationEvent())
    await settle()

    expect(gets(ROSTER_URL)).toHaveLength(2)
    expect(gets(AUTH_URL)).toHaveLength(0)
    expect(board.authorizations.value).toEqual([])
    expect(rosterStudent(board, 's1')?.active_authorization_count).toBe(1)

    // HTTP 核驗結果同樣不寫進未載入的清單，改重抓名單
    board.applyAuthorization(makeAuthorization({ status: 'completed', effective_status: 'completed' }))
    await settle()
    expect(board.authorizations.value).toEqual([])
    expect(gets(ROSTER_URL)).toHaveLength(3)
    expect(rosterStudent(board, 's1')?.active_authorization_count).toBe(0)
    first.wrapper.unmount()

    // 兩者皆未載入：事件忽略，不寫進清單也不重抓
    const bare = await mountBoard()
    socket().serverMessage('pickup.authorization_updated', makeAuthorizationEvent({ id: 'pa9' }))
    await settle()
    expect(bare.board.authorizations.value).toEqual([])
    expect(gets(ROSTER_URL)).toHaveLength(3)
    expect(gets(AUTH_URL)).toHaveLength(0)
  })

  it('usePickupBoard applies verified authorization and recomputes roster count', async () => {
    const pa1 = makeAuthorization()
    mockAll(makeQueue(), makeRoster([makeStudent({ active_authorization_count: 1 })]), [pa1])
    const { board } = await mountBoard({ withRoster: true, withAuthorizations: true })

    // 本機核驗結果（B437~439 回傳的完整 StaffAuthorization）：就地 upsert，不重抓
    board.applyAuthorization({
      ...pa1,
      status: 'completed',
      effective_status: 'completed',
      verification_method: 'visual_match',
      verified_by_name: '陳老師',
      verified_at: '2026-10-02T09:10:00Z',
    })
    await settle()
    expect(board.authorizations.value).toHaveLength(1)
    expect(board.authorizations.value[0]?.effective_status).toBe('completed')
    expect(rosterStudent(board, 's1')?.active_authorization_count).toBe(0)

    board.applyAuthorization(makeAuthorization({ id: 'pa2', proxy_name: '林阿姨', code_last4: '1185' }))
    await settle()
    expect(board.authorizations.value.map((a) => a.id)).toEqual(['pa1', 'pa2'])
    expect(rosterStudent(board, 's1')?.active_authorization_count).toBe(1)

    // 非今天的授權忽略
    board.applyAuthorization(makeAuthorization({ id: 'pa3', service_date: '2026-10-03' }))
    await settle()
    expect(board.authorizations.value.map((a) => a.id)).toEqual(['pa1', 'pa2'])
    expect(gets(AUTH_URL)).toHaveLength(1)
  })

  it('usePickupBoard reloads for the new day after midnight', async () => {
    mockAll(makeQueue())
    await mountBoard()
    expect(gets(QUEUE_URL)).toHaveLength(1)

    // 台北 23:59 → 00:00
    vi.setSystemTime(Date.parse('2026-10-02T15:59:30Z'))
    await vi.advanceTimersByTimeAsync(60_000)
    await settle()

    expect(gets(QUEUE_URL)).toHaveLength(2)
    expect((gets(QUEUE_URL)[1]?.params as { date?: string }).date).toBe('2026-10-03')
  })

  it('usePickupBoard keeps latest response and reports load errors', async () => {
    mock
      .onGet(QUEUE_URL)
      .replyOnce(200, makeQueue([makeRequest()]))
      .onGet(QUEUE_URL)
      .reply(500, { error: { code: 'internal_error', message: '伺服器忙碌中', details: null } })
    const { board } = await mountBoard()
    expect(openIds(board)).toEqual(['r1'])

    await board.reload()
    expect(board.error.value).toBe('伺服器忙碌中')
    expect(openIds(board)).toEqual(['r1'])
    expect(board.loading.value).toBe(false)
  })
})
