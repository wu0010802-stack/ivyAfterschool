import type MockAdapter from 'axios-mock-adapter'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import type { Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { createApiMock, mountWithApp } from '@/test/helpers'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'
import type { ChildToday } from '../api/children'
import { parentHttp } from '../api/http'
import type { ParentPickupRequest } from '../api/pickupRequests'
import { useParentWsStore } from '../stores/parentWs'
import { useTodayStatus } from './useTodayStatus'

/** ws 事件封包（type + data + sent_at）由伺服器送出 */
function serverMessage(socket: FakeWebSocket, type: string, data: unknown): void {
  socket.message({ type, data, sent_at: SENT_AT })
}

function lastSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1)
  if (!s) throw new Error('尚未建立 socket')
  return s
}

const TODAY = '2026-10-02'
const YESTERDAY = '2026-10-01'
const SENT_AT = '2026-10-02T08:00:00Z'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器發生錯誤', details: null } }

const todayUrl = (id: string) => `/parent/children/${id}/today`

function childToday(studentId: string, overrides: Partial<ChildToday> = {}): ChildToday {
  return {
    student_id: studentId,
    date: TODAY,
    is_service_day: true,
    attendance: { status: 'present', check_in_at: '2026-10-02T07:40:00Z', check_out_at: null },
    on_leave: false,
    leave: null,
    homework: { item_count: 3, done_count: 1, overall_status: 'in_progress', ready_eta: '17:30', note: null },
    pickup_request: null,
    ...overrides,
  }
}

function pickup(id: string, overrides: Partial<NonNullable<ChildToday['pickup_request']>> = {}) {
  return {
    id,
    status: 'pending' as const,
    expected_arrival_at: null,
    reply_ready_eta: '17:30',
    reply_message: '預計 17:30 可接送',
    reply_source: 'auto' as const,
    completed_at: null,
    picked_up_by_name: null,
    can_cancel: true,
    can_mark_arrived: true,
    ...overrides,
  }
}

function request(id: string, overrides: Partial<ParentPickupRequest> = {}): ParentPickupRequest {
  return {
    id,
    student_id: 's1',
    student_name: '王小明',
    service_date: TODAY,
    status: 'pending',
    expected_arrival_at: null,
    reply_ready_eta: '17:30',
    reply_message: '預計 17:30 可接送',
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

type Status = ReturnType<typeof useTodayStatus>

describe('useTodayStatus', () => {
  let mock: MockAdapter
  let pinia: Pinia | null = null

  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    installFakeWebSocket()
    mock = createApiMock(parentHttp)
  })

  afterEach(() => {
    if (pinia) useParentWsStore(pinia).disconnect()
    pinia = null
    mock.restore()
    Reflect.deleteProperty(document, 'visibilityState')
  })

  async function mountStatus(
    initial: string | null = 's1',
  ): Promise<{ wrapper: VueWrapper; childId: Ref<string | null>; status: Status }> {
    const childId = ref<string | null>(initial)
    let status: Status | null = null
    const Host = defineComponent({
      setup() {
        status = useTodayStatus(childId)
        return () => h('div')
      },
    })
    const mounted = await mountWithApp(Host)
    pinia = mounted.pinia
    if (!status) throw new Error('setup 未執行')
    return { wrapper: mounted.wrapper, childId, status }
  }

  function todayGets(id: string): number {
    return mock.history.get.filter((r) => r.url === todayUrl(id)).length
  }

  function connectWs(): FakeWebSocket {
    if (!pinia) throw new Error('尚未掛載')
    useParentWsStore(pinia).connect()
    lastSocket().open()
    return lastSocket()
  }

  it('useTodayStatus loads today for selected child', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))

    const { status } = await mountStatus('s1')

    expect(mock.history.get.map((r) => r.url)).toEqual([todayUrl('s1')])
    expect(status.today.value?.student_id).toBe('s1')
    expect(status.today.value?.attendance.status).toBe('present')
    expect(status.today.value?.homework.done_count).toBe(1)
    expect(status.loading.value).toBe(false)
    expect(status.error.value).toBeNull()
  })

  it('useTodayStatus shows loading before first response', async () => {
    let release!: () => void
    mock.onGet(todayUrl('s1')).reply(
      () =>
        new Promise<[number, unknown]>((resolve) => {
          release = () => resolve([200, childToday('s1')])
        }),
    )

    const { status } = await mountStatus('s1')

    expect(status.today.value).toBeNull()
    expect(status.loading.value).toBe(true)
    release()
    await flushPromises()
    expect(status.loading.value).toBe(false)
    expect(status.today.value?.student_id).toBe('s1')
  })

  it('useTodayStatus null child sends nothing', async () => {
    const { status, childId } = await mountStatus(null)

    expect(status.today.value).toBeNull()
    expect(status.loading.value).toBe(false)
    expect(mock.history.get).toHaveLength(0)

    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    childId.value = 's1'
    await flushPromises()
    expect(status.today.value?.student_id).toBe('s1')

    childId.value = null
    await flushPromises()
    expect(status.today.value).toBeNull()
    expect(mock.history.get).toHaveLength(1)
  })

  it('useTodayStatus switch child uses new id and drops stale', async () => {
    let releaseS1!: () => void
    mock.onGet(todayUrl('s1')).reply(
      () =>
        new Promise<[number, unknown]>((resolve) => {
          releaseS1 = () => resolve([200, childToday('s1')])
        }),
    )
    mock.onGet(todayUrl('s2')).reply(200, childToday('s2', { attendance: { status: 'absent', check_in_at: null, check_out_at: null } }))
    const { status, childId } = await mountStatus('s1')
    expect(status.loading.value).toBe(true)

    childId.value = 's2'
    await nextTick()
    expect(status.today.value).toBeNull()
    await flushPromises()

    expect(todayGets('s2')).toBe(1)
    expect(status.today.value?.student_id).toBe('s2')
    expect(status.today.value?.attendance.status).toBe('absent')
    expect(status.loading.value).toBe(false)

    releaseS1()
    await flushPromises()

    expect(status.today.value?.student_id).toBe('s2')
    expect(status.today.value?.attendance.status).toBe('absent')
  })

  it('useTodayStatus switch child clears today immediately', async () => {
    let releaseS2!: () => void
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    mock.onGet(todayUrl('s2')).reply(
      () =>
        new Promise<[number, unknown]>((resolve) => {
          releaseS2 = () => resolve([200, childToday('s2')])
        }),
    )
    const { status, childId } = await mountStatus('s1')
    expect(status.today.value?.student_id).toBe('s1')

    childId.value = 's2'
    await nextTick()

    // 切換當下就清空（頁面顯示骨架），不會先顯示上一位小孩的資料
    expect(status.today.value).toBeNull()
    expect(status.loading.value).toBe(true)

    releaseS2()
    await flushPromises()
    expect(status.today.value?.student_id).toBe('s2')
    expect(status.loading.value).toBe(false)
  })

  it('useTodayStatus applies attendance ws event', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    const { status } = await mountStatus('s1')
    const socket = connectWs()

    serverMessage(socket, 'attendance.updated', {
      student_id: 's2',
      service_date: TODAY,
      status: 'left',
      check_in_at: '2026-10-02T07:40:00Z',
      check_out_at: '2026-10-02T09:50:00Z',
    })
    expect(status.today.value?.attendance.status).toBe('present')

    serverMessage(socket, 'attendance.updated', {
      student_id: 's1',
      service_date: YESTERDAY,
      status: 'left',
      check_in_at: '2026-10-01T07:40:00Z',
      check_out_at: '2026-10-01T09:50:00Z',
    })
    expect(status.today.value?.attendance.status).toBe('present')
    expect(status.today.value?.attendance.check_out_at).toBeNull()

    serverMessage(socket, 'attendance.updated', {
      student_id: 's1',
      service_date: TODAY,
      status: 'left',
      check_in_at: '2026-10-02T07:40:00Z',
      check_out_at: '2026-10-02T09:50:00Z',
    })
    expect(status.today.value?.attendance).toEqual({
      status: 'left',
      check_in_at: '2026-10-02T07:40:00Z',
      check_out_at: '2026-10-02T09:50:00Z',
    })
    expect(status.today.value?.homework.done_count).toBe(1)
    expect(todayGets('s1')).toBe(1)
  })

  it('useTodayStatus applies homework ws event', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    const { status } = await mountStatus('s1')
    const socket = connectWs()
    const items = [
      { title: '數學習作 p.12', subject_name: '數學', status: 'done' },
      { title: '國語生字', subject_name: '國語', status: 'done' },
      { title: '英文單字', subject_name: '英文', status: 'done' },
      { title: '自然學習單', subject_name: '自然', status: 'correcting' },
    ]

    serverMessage(socket, 'homework.progress_updated', {
      student_id: 's1',
      date: TODAY,
      items,
      overall_status: 'in_progress',
      ready_eta: '17:45',
      note: '最後一題訂正中',
    })

    expect(status.today.value?.homework).toEqual({
      item_count: 4,
      done_count: 3,
      overall_status: 'in_progress',
      ready_eta: '17:45',
      note: '最後一題訂正中',
    })

    // 其他小孩或非今日：不變
    serverMessage(socket, 'homework.progress_updated', {
      student_id: 's2',
      date: TODAY,
      items: [],
      overall_status: 'done',
      ready_eta: null,
      note: null,
    })
    serverMessage(socket, 'homework.progress_updated', {
      student_id: 's1',
      date: YESTERDAY,
      items: [],
      overall_status: 'done',
      ready_eta: null,
      note: null,
    })
    expect(status.today.value?.homework.done_count).toBe(3)
    expect(status.today.value?.homework.overall_status).toBe('in_progress')
  })

  it('useTodayStatus pickup ws prefers open request', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1', { pickup_request: pickup('r1') }))
    const { status } = await mountStatus('s1')
    const socket = connectWs()

    // 另一筆終態：目前的 r1 仍是進行中，忽略
    serverMessage(socket,
      'pickup.request_updated',
      request('r0', { status: 'completed', completed_at: '2026-10-02T06:00:00Z', picked_up_by_name: '王爸爸', can_cancel: false, can_mark_arrived: false }),
    )
    expect(status.today.value?.pickup_request?.id).toBe('r1')
    expect(status.today.value?.pickup_request?.status).toBe('pending')

    // 同一筆：取代
    serverMessage(socket,
      'pickup.request_updated',
      request('r1', { status: 'acknowledged', reply_source: 'staff', reply_ready_eta: '17:45', reply_message: '老師：17:45 可接', replied_at: '2026-10-02T08:00:00Z' }),
    )
    expect(status.today.value?.pickup_request?.status).toBe('acknowledged')
    expect(status.today.value?.pickup_request?.reply_source).toBe('staff')
    expect(status.today.value?.pickup_request?.reply_ready_eta).toBe('17:45')
    expect(status.today.value?.pickup_request?.replied_at).toBe('2026-10-02T08:00:00Z')

    // 同一筆進入終態：取代（含接走資訊）
    serverMessage(socket,
      'pickup.request_updated',
      request('r1', { status: 'completed', completed_at: '2026-10-02T09:40:00Z', picked_up_by_name: '王媽媽', can_cancel: false, can_mark_arrived: false }),
    )
    expect(status.today.value?.pickup_request?.status).toBe('completed')
    expect(status.today.value?.pickup_request?.picked_up_by_name).toBe('王媽媽')

    // 目前為終態、來了新的非終態：取代
    serverMessage(socket, 'pickup.request_updated', request('r2'))
    expect(status.today.value?.pickup_request?.id).toBe('r2')
    expect(status.today.value?.pickup_request?.status).toBe('pending')

    // 其他小孩或非今日：不變
    serverMessage(socket, 'pickup.request_updated', request('r3', { student_id: 's2', status: 'arrived' }))
    serverMessage(socket, 'pickup.request_updated', request('r4', { service_date: YESTERDAY, status: 'arrived' }))
    expect(status.today.value?.pickup_request?.id).toBe('r2')
  })

  it('useTodayStatus pickup ws fills empty state', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    const { status } = await mountStatus('s1')
    const socket = connectWs()
    expect(status.today.value?.pickup_request).toBeNull()

    serverMessage(socket, 'pickup.request_updated', request('r2'))

    expect(status.today.value?.pickup_request).toEqual({
      id: 'r2',
      status: 'pending',
      expected_arrival_at: null,
      reply_ready_eta: '17:30',
      reply_message: '預計 17:30 可接送',
      reply_source: 'auto',
      completed_at: null,
      picked_up_by_name: null,
      can_cancel: true,
      can_mark_arrived: true,
      replied_at: '2026-10-02T07:00:05Z',
      arrived_at: null,
    })
  })

  it('useTodayStatus error keeps previous data', async () => {
    mock.onGet(todayUrl('s1')).replyOnce(200, childToday('s1')).onGet(todayUrl('s1')).replyOnce(500, SERVER_ERROR)
    const { status } = await mountStatus('s1')

    await status.refresh()

    expect(status.error.value).toBe('今日狀態載入失敗')
    expect(status.today.value?.student_id).toBe('s1')
    expect(status.today.value?.attendance.status).toBe('present')
    expect(status.loading.value).toBe(false)
  })

  it('useTodayStatus poller refreshes', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    const { status } = await mountStatus('s1')
    expect(todayGets('s1')).toBe(1)
    mock.reset()
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1', { attendance: { status: 'left', check_in_at: '2026-10-02T07:40:00Z', check_out_at: '2026-10-02T09:50:00Z' } }))

    if (!pinia) throw new Error('尚未掛載')
    useParentWsStore(pinia).pollNow()
    await flushPromises()

    expect(todayGets('s1')).toBe(1)
    expect(status.today.value?.attendance.status).toBe('left')
  })

  it('useTodayStatus refreshes when page becomes visible', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    await mountStatus('s1')
    expect(todayGets('s1')).toBe(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(todayGets('s1')).toBe(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(todayGets('s1')).toBe(2)
  })

  it('useTodayStatus keeps completed pickup info from api', async () => {
    mock.onGet(todayUrl('s1')).reply(
      200,
      childToday('s1', {
        pickup_request: pickup('r1', { status: 'completed', completed_at: '2026-10-02T09:40:00Z', picked_up_by_name: '王媽媽', can_cancel: false, can_mark_arrived: false }),
      }),
    )
    const { status } = await mountStatus('s1')

    expect(status.today.value?.pickup_request?.picked_up_by_name).toBe('王媽媽')
    expect(status.today.value?.pickup_request?.completed_at).toBe('2026-10-02T09:40:00Z')

    const socket = connectWs()
    serverMessage(socket,
      'pickup.request_updated',
      request('r1', { status: 'completed', completed_at: '2026-10-02T09:40:00Z', picked_up_by_name: '王爸爸', can_cancel: false, can_mark_arrived: false }),
    )

    expect(status.today.value?.pickup_request?.picked_up_by_name).toBe('王爸爸')
    expect(status.today.value?.pickup_request?.completed_at).toBe('2026-10-02T09:40:00Z')
  })

  it('useTodayStatus applyPickup merges response', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    const { status } = await mountStatus('s1')

    status.applyPickup(request('r8', { status: 'arrived', reply_source: 'auto', arrived_at: '2026-10-02T08:10:00Z', can_mark_arrived: false }))

    expect(status.today.value?.pickup_request?.id).toBe('r8')
    expect(status.today.value?.pickup_request?.status).toBe('arrived')
    expect(status.today.value?.pickup_request?.arrived_at).toBe('2026-10-02T08:10:00Z')

    status.applyPickup(request('r9', { student_id: 's2', status: 'pending' }))

    expect(status.today.value?.pickup_request?.id).toBe('r8')
    expect(status.today.value?.pickup_request?.status).toBe('arrived')
    expect(mock.history.get).toHaveLength(1)
  })

  it('useTodayStatus refresh clears error at start', async () => {
    let release!: () => void
    mock
      .onGet(todayUrl('s1'))
      .replyOnce(200, childToday('s1'))
      .onGet(todayUrl('s1'))
      .replyOnce(500, SERVER_ERROR)
      .onGet(todayUrl('s1'))
      .replyOnce(
        () =>
          new Promise<[number, unknown]>((resolve) => {
            release = () => resolve([200, childToday('s1')])
          }),
      )
    const { status } = await mountStatus('s1')

    await status.refresh()
    expect(status.error.value).toBe('今日狀態載入失敗')

    const pending = status.refresh()
    expect(status.error.value).toBeNull()
    expect(status.loading.value).toBe(true)

    release()
    await pending
    expect(status.error.value).toBeNull()
    expect(status.loading.value).toBe(false)
  })

  it('useTodayStatus unmount stops ws and poller', async () => {
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    const { wrapper, status } = await mountStatus('s1')
    const socket = connectWs()

    wrapper.unmount()

    serverMessage(socket, 'attendance.updated', {
      student_id: 's1',
      service_date: TODAY,
      status: 'left',
      check_in_at: '2026-10-02T07:40:00Z',
      check_out_at: '2026-10-02T09:50:00Z',
    })
    expect(status.today.value?.attendance.status).toBe('present')

    if (!pinia) throw new Error('尚未掛載')
    useParentWsStore(pinia).pollNow()
    await flushPromises()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()

    expect(todayGets('s1')).toBe(1)
  })
})
