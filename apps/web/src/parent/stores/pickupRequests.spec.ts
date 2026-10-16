import type MockAdapter from 'axios-mock-adapter'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock } from '@/test/helpers'
import { parentHttp } from '../api/http'
import type { ParentPickupRequest } from '../api/pickupRequests'
import { useParentWsStore } from './parentWs'
import { usePickupRequestsStore } from './pickupRequests'

// 最小假 WebSocket：只做 parentWs store 需要的 open / message
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  close(): void {
    this.readyState = 3
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverMessage(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

function lastSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1)
  if (!s) throw new Error('尚未建立 socket')
  return s
}

// 時間固定在台北 2026-10-02 16:00
const NOW = new Date('2026-10-02T08:00:00Z')
const TODAY = '2026-10-02'
const YESTERDAY = '2026-10-01'
const SENT_AT = '2026-10-02T08:00:00Z'
const TODAY_URL = '/parent/pickup/requests/today'
const CREATE_URL = '/parent/pickup/requests'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器發生錯誤', details: null } }

function apiError(code: string, message: string, details: unknown = null) {
  return { error: { code, message, details } }
}

function request(id: string, overrides: Partial<ParentPickupRequest> = {}): ParentPickupRequest {
  return {
    id,
    student_id: 's1',
    student_name: '王小明',
    service_date: TODAY,
    status: 'pending',
    expected_arrival_at: null,
    reply_ready_eta: null,
    reply_message: '已通知老師，稍後回覆預計時間',
    reply_source: 'auto',
    replied_at: '2026-10-02T07:00:05Z',
    arrived_at: null,
    completed_at: null,
    picked_up_by_name: null,
    cancelled_at: null,
    created_at: '2026-10-02T07:00:00Z',
    can_cancel: true,
    can_mark_arrived: true,
    ...overrides,
  }
}

const R1 = request('r1', { status: 'cancelled', created_at: '2026-10-02T07:00:00Z', cancelled_at: '2026-10-02T07:10:00Z', can_cancel: false, can_mark_arrived: false })
const R2 = request('r2', { status: 'pending', created_at: '2026-10-02T08:00:00Z' })
const R3 = request('r3', { student_id: 's2', student_name: '王小華', status: 'arrived', arrived_at: '2026-10-02T07:50:00Z', created_at: '2026-10-02T07:40:00Z', can_mark_arrived: false })

describe('pickupRequestsStore', () => {
  let mock: MockAdapter

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    setActivePinia(createPinia())
    mock = createApiMock(parentHttp)
  })

  afterEach(() => {
    useParentWsStore().disconnect()
    mock.restore()
    vi.useRealTimers()
  })

  function todayRequests(): number {
    return mock.history.get.filter((r) => r.url === TODAY_URL).length
  }

  function postsTo(url: string) {
    return mock.history.post.filter((r) => r.url === url)
  }

  async function loadedStore(items: ParentPickupRequest[] = [R1, R2, R3]) {
    mock.onGet(TODAY_URL).replyOnce(200, items)
    const store = usePickupRequestsStore()
    await store.load()
    return store
  }

  function connectWs(): FakeWebSocket {
    useParentWsStore().connect()
    lastSocket().serverOpen()
    return lastSocket()
  }

  it('pickupRequestsStore openFor picks latest open', async () => {
    const store = await loadedStore()

    expect(store.loaded).toBe(true)
    expect(store.items.map((r) => r.id)).toEqual(['r1', 'r2', 'r3'])
    expect(store.openFor('s1')?.id).toBe('r2')
    expect(store.latestFor('s1')?.id).toBe('r2')
    expect(store.historyFor('s1').map((r) => r.id)).toEqual(['r1'])
    expect(store.openFor('s2')?.id).toBe('r3')
    expect(store.historyFor('s2')).toEqual([])
    expect(store.openFor('s9')).toBeNull()
    expect(store.latestFor('s9')).toBeNull()
  })

  it('pickupRequestsStore openFor prefers newest when two are open', async () => {
    // 後端同一天只允許一筆非終態；舊事件晚到時清單可能短暫同時有兩筆，取 created_at 最新
    const older = request('r4', { status: 'acknowledged', created_at: '2026-10-02T06:00:00Z' })
    const newer = request('r5', { status: 'pending', created_at: '2026-10-02T07:30:00Z' })
    const store = await loadedStore([newer, older])

    expect(store.openFor('s1')?.id).toBe('r5')
    expect(store.latestFor('s1')?.id).toBe('r5')
  })

  it('pickupRequestsStore latestFor and historyFor order by created_at', async () => {
    const older = request('r4', { status: 'expired', created_at: '2026-10-02T05:00:00Z', can_cancel: false, can_mark_arrived: false })
    const newer = request('r5', { status: 'completed', created_at: '2026-10-02T06:30:00Z', completed_at: '2026-10-02T06:40:00Z', picked_up_by_name: '王媽媽', can_cancel: false, can_mark_arrived: false })
    const store = await loadedStore([older, newer])

    expect(store.openFor('s1')).toBeNull()
    expect(store.latestFor('s1')?.id).toBe('r5')
    expect(store.historyFor('s1').map((r) => r.id)).toEqual(['r5', 'r4'])
  })

  it('pickupRequestsStore load shares in-flight request and keeps data on error', async () => {
    mock.onGet(TODAY_URL).replyOnce(200, [R2]).onGet(TODAY_URL).replyOnce(500, SERVER_ERROR)
    const store = usePickupRequestsStore()

    await Promise.all([store.load(), store.load()])
    expect(todayRequests()).toBe(1)
    expect(store.loading).toBe(false)

    // 已載入且非 force：不重抓
    await store.load()
    expect(todayRequests()).toBe(1)

    await store.load(true)
    expect(todayRequests()).toBe(2)
    expect(store.error).toBe('接送狀態載入失敗')
    expect(store.openFor('s1')?.id).toBe('r2')
    expect(store.loading).toBe(false)
  })

  it('pickupRequestsStore load drops stale response', async () => {
    let releaseFirst!: () => void
    mock
      .onGet(TODAY_URL)
      .replyOnce(
        () =>
          new Promise<[number, unknown]>((resolve) => {
            releaseFirst = () => resolve([200, [R1]])
          }),
      )
      .onGet(TODAY_URL)
      .replyOnce(200, [R2])
    const store = usePickupRequestsStore()

    const stale = store.load()
    const fresh = store.load(true)
    await fresh
    expect(store.items.map((r) => r.id)).toEqual(['r2'])

    releaseFirst()
    await stale
    await flushPromises()

    expect(store.items.map((r) => r.id)).toEqual(['r2'])
    expect(store.loading).toBe(false)
  })

  it('pickupRequestsStore create upserts response', async () => {
    const store = await loadedStore([])
    const created = request('r5', { reply_message: '作業已完成，可以接送' })
    mock.onPost(CREATE_URL).reply(201, created)

    const result = await store.create('s1', null)

    expect(result).toEqual(created)
    expect(store.openFor('s1')?.reply_message).toBe('作業已完成，可以接送')
    expect(JSON.parse(postsTo(CREATE_URL)[0]!.data as string)).toEqual({ student_id: 's1' })
    expect(store.pendingAction).toBeNull()
  })

  it('pickupRequestsStore create sends expected arrival time', async () => {
    const store = await loadedStore([])
    mock.onPost(CREATE_URL).reply(201, request('r6', { expected_arrival_at: '17:40' }))

    await store.create('s1', '17:40')

    expect(JSON.parse(postsTo(CREATE_URL)[0]!.data as string)).toEqual({ student_id: 's1', expected_arrival_at: '17:40' })
    expect(store.openFor('s1')?.expected_arrival_at).toBe('17:40')
  })

  it('pickupRequestsStore syncs on conflict', async () => {
    const store = await loadedStore([])
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_request_exists', '今天已有進行中的接送請求'))
    mock.onGet(TODAY_URL).reply(200, [request('r9')])

    await expect(store.create('s1', null)).rejects.toMatchObject({ status: 409, code: 'pickup_request_exists' })

    expect(todayRequests()).toBe(2)
    expect(store.openFor('s1')?.id).toBe('r9')
    expect(store.pendingAction).toBeNull()
  })

  it('pickupRequestsStore other errors do not resync', async () => {
    const store = await loadedStore([])
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_window_closed', '目前不在可發起接送的時段'))

    await expect(store.create('s1', null)).rejects.toMatchObject({ code: 'pickup_window_closed' })

    expect(todayRequests()).toBe(1)
    expect(store.pendingAction).toBeNull()
  })

  it('pickupRequestsStore applies ws update', async () => {
    const store = await loadedStore()
    const socket = connectWs()

    socket.serverMessage({
      type: 'pickup.request_updated',
      data: request('r2', { status: 'acknowledged', reply_ready_eta: '17:45', reply_source: 'staff', created_at: '2026-10-02T08:00:00Z' }),
      sent_at: SENT_AT,
    })

    expect(store.openFor('s1')?.status).toBe('acknowledged')
    expect(store.openFor('s1')?.reply_ready_eta).toBe('17:45')
    expect(store.items).toHaveLength(3)

    // 新的 id：加入
    socket.serverMessage({ type: 'pickup.request_updated', data: request('r7', { student_id: 's3' }), sent_at: SENT_AT })
    expect(store.items).toHaveLength(4)
    expect(store.openFor('s3')?.id).toBe('r7')
  })

  it('pickupRequestsStore ignores other day event', async () => {
    const store = await loadedStore()
    const socket = connectWs()
    const before = JSON.parse(JSON.stringify(store.items))

    socket.serverMessage({
      type: 'pickup.request_updated',
      data: request('r2', { status: 'completed', service_date: YESTERDAY }),
      sent_at: SENT_AT,
    })
    socket.serverMessage({
      type: 'pickup.request_updated',
      data: request('r8', { service_date: YESTERDAY }),
      sent_at: SENT_AT,
    })

    expect(store.items).toEqual(before)
    expect(store.openFor('s1')?.status).toBe('pending')
  })

  it('pickupRequestsStore blocks concurrent writes', async () => {
    const store = await loadedStore()
    let release!: () => void
    const arrived = request('r2', { status: 'arrived', arrived_at: '2026-10-02T08:10:00Z', can_mark_arrived: false, created_at: '2026-10-02T08:00:00Z' })
    mock.onPost('/parent/pickup/requests/r2/arrived').reply(
      () =>
        new Promise<[number, unknown]>((resolve) => {
          release = () => resolve([200, arrived])
        }),
    )

    const first = store.markArrived('r2')
    const second = store.markArrived('r2')
    expect(store.pendingAction).toBe('markArrived')
    release()
    const [a, b] = await Promise.all([first, second])

    expect(postsTo('/parent/pickup/requests/r2/arrived')).toHaveLength(1)
    expect(a).toEqual(arrived)
    expect(b).toBe(a)
    expect(store.openFor('s1')?.status).toBe('arrived')
    expect(store.pendingAction).toBeNull()
  })

  it('pickupRequestsStore cancel upserts and sends reason', async () => {
    const store = await loadedStore()
    const cancelled = request('r2', { status: 'cancelled', cancelled_at: '2026-10-02T08:20:00Z', can_cancel: false, can_mark_arrived: false, created_at: '2026-10-02T08:00:00Z' })
    mock.onPost('/parent/pickup/requests/r2/cancel').reply(200, cancelled)

    const result = await store.cancel('r2', '臨時有事')

    expect(result.status).toBe('cancelled')
    expect(JSON.parse(postsTo('/parent/pickup/requests/r2/cancel')[0]!.data as string)).toEqual({ reason: '臨時有事' })
    expect(store.openFor('s1')).toBeNull()
    expect(store.historyFor('s1').map((r) => r.id)).toEqual(['r2', 'r1'])
  })

  it('pickupRequestsStore arriveNow creates arrived request', async () => {
    const store = await loadedStore([])
    const arrived = request('r8', { status: 'arrived', reply_message: '作業已完成，可以接送', reply_source: 'auto', arrived_at: '2026-10-02T08:00:00Z', can_mark_arrived: false })
    mock.onPost(CREATE_URL).reply(201, arrived)

    const result = await store.arriveNow('s1')

    expect(result).toEqual(arrived)
    expect(JSON.parse(postsTo(CREATE_URL)[0]!.data as string)).toEqual({ student_id: 's1', arrived: true })
    expect(store.openFor('s1')?.status).toBe('arrived')
  })

  it('pickupRequestsStore arriveNow falls back to existing request', async () => {
    const store = await loadedStore([])
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_request_exists', '今天已有進行中的接送請求', { request_id: 'r7' }))
    mock.onPost('/parent/pickup/requests/r7/arrived').reply(200, request('r7', { status: 'arrived', arrived_at: '2026-10-02T08:00:00Z', can_mark_arrived: false }))

    const result = await store.arriveNow('s1')

    expect(result.id).toBe('r7')
    expect(store.openFor('s1')?.status).toBe('arrived')
    expect(todayRequests()).toBe(1)
    expect(store.pendingAction).toBeNull()
  })

  it('pickupRequestsStore arriveNow fallback conflict syncs', async () => {
    const store = await loadedStore([])
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_request_exists', '今天已有進行中的接送請求', { request_id: 'r7' }))
    mock.onPost('/parent/pickup/requests/r7/arrived').reply(409, apiError('invalid_pickup_status', '此請求目前的狀態不允許此操作'))
    mock.onGet(TODAY_URL).reply(200, [request('r7', { status: 'completed', completed_at: '2026-10-02T07:55:00Z', picked_up_by_name: '王爸爸', can_cancel: false, can_mark_arrived: false })])

    await expect(store.arriveNow('s1')).rejects.toMatchObject({ code: 'invalid_pickup_status' })

    expect(todayRequests()).toBe(2)
    expect(store.latestFor('s1')?.status).toBe('completed')
    expect(store.openFor('s1')).toBeNull()
    expect(store.pendingAction).toBeNull()
  })

  it('pickupRequestsStore arriveNow conflict without request id resyncs and rethrows', async () => {
    const store = await loadedStore([])
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_request_exists', '今天已有進行中的接送請求'))
    mock.onGet(TODAY_URL).reply(200, [request('r9', { status: 'acknowledged' })])

    await expect(store.arriveNow('s1')).rejects.toMatchObject({ code: 'pickup_request_exists' })

    expect(postsTo(CREATE_URL)).toHaveLength(1)
    expect(mock.history.post).toHaveLength(1)
    expect(store.openFor('s1')?.id).toBe('r9')
  })

  it('pickupRequestsStore handles not found', async () => {
    const store = await loadedStore()
    mock.onPost('/parent/pickup/requests/r2/arrived').reply(404, apiError('pickup_request_not_found', '找不到接送請求'))
    mock.onGet(TODAY_URL).reply(200, [])

    await expect(store.markArrived('r2')).rejects.toMatchObject({ status: 404, code: 'pickup_request_not_found' })

    expect(todayRequests()).toBe(2)
    expect(store.openFor('s1')).toBeNull()
    expect(store.items).toEqual([])
  })

  it('pickupRequestsStore poller reloads today', async () => {
    const store = await loadedStore()
    mock.onGet(TODAY_URL).reply(200, [request('r2', { status: 'completed', created_at: '2026-10-02T08:00:00Z', completed_at: '2026-10-02T08:30:00Z', picked_up_by_name: '王媽媽', can_cancel: false, can_mark_arrived: false })])

    useParentWsStore().pollNow()
    await flushPromises()

    expect(todayRequests()).toBe(2)
    expect(store.latestFor('s1')?.status).toBe('completed')
    expect(store.openFor('s2')).toBeNull()
  })

  it('pickupRequestsStore clear resets state', async () => {
    const store = await loadedStore()

    store.clear()

    expect(store.items).toEqual([])
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
    expect(store.pendingAction).toBeNull()
    expect(store.openFor('s1')).toBeNull()
  })
})
