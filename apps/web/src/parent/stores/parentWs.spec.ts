import type MockAdapter from 'axios-mock-adapter'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock } from '@/test/helpers'
import type { WsEnvelope } from '@/shared/types/api'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'
import type { ChildSummary } from '../api/children'
import { parentHttp } from '../api/http'
import { useChildrenStore } from './children'
import { useParentWsStore } from './parentWs'
import ownSource from './parentWs.spec.ts?raw'

const sockets = FakeWebSocket.instances

function lastSocket(): FakeWebSocket {
  const s = sockets.at(-1)
  if (!s) throw new Error('尚未建立 socket')
  return s
}

function child(id: string, name: string): ChildSummary {
  return {
    id,
    name,
    grade_level: 3,
    class_name: '三年級班',
    school_name: '快樂國小',
    photo_url: null,
    status: 'active',
  }
}

const MING = child('s1', '王小明')
const HUA = child('s2', '王小華')

const SENT_AT = '2026-10-02T09:00:00Z'

function connectOpen() {
  const store = useParentWsStore()
  store.connect()
  lastSocket().open()
  return store
}

describe('parentWs store', () => {
  let mock: MockAdapter

  beforeEach(() => {
    // setImmediate 保持真實，flushPromises 才會回來；只釘住重連 / 輪詢用的計時器
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    sockets.length = 0
    installFakeWebSocket()
    setActivePinia(createPinia())
    mock = createApiMock(parentHttp)
  })

  afterEach(() => {
    useParentWsStore().disconnect()
    mock.restore()
    vi.useRealTimers()
  })

  it('parentWs dispatches typed events', () => {
    const store = useParentWsStore()
    const received: { data: { id: string }; envelope: WsEnvelope<{ id: string }> }[] = []
    const off = store.on<{ id: string }>('pickup.request_updated', (data, envelope) => {
      received.push({ data, envelope })
    })
    store.connect()
    lastSocket().open()

    lastSocket().message({ type: 'pickup.request_updated', data: { id: 'r1' }, sent_at: SENT_AT })

    expect(received).toHaveLength(1)
    expect(received[0]!.data.id).toBe('r1')
    expect(received[0]!.envelope.sent_at).toBe(SENT_AT)
    expect(received[0]!.envelope.type).toBe('pickup.request_updated')

    off()
    lastSocket().message({ type: 'pickup.request_updated', data: { id: 'r2' }, sent_at: SENT_AT })

    expect(received).toHaveLength(1)
  })

  it('parentWs only delivers to handlers of the matching type', () => {
    const store = useParentWsStore()
    const homework: unknown[] = []
    const notifications: unknown[] = []
    store.on('homework.progress_updated', (data) => homework.push(data))
    store.on('notification.created', (data) => notifications.push(data))
    store.connect()
    lastSocket().open()

    lastSocket().message({ type: 'homework.progress_updated', data: { student_id: 's1' }, sent_at: SENT_AT })
    lastSocket().message({ type: 'notification.created', data: { id: 'n1' }, sent_at: SENT_AT })

    expect(homework).toEqual([{ student_id: 's1' }])
    expect(notifications).toEqual([{ id: 'n1' }])
  })

  it('parentWs connect is idempotent', () => {
    const store = useParentWsStore()
    expect(store.enabled).toBe(false)
    expect(store.status).toBe('idle')

    store.connect()
    store.connect()

    expect(sockets).toHaveLength(1)
    expect(lastSocket().url.endsWith('/api/ws/parent')).toBe(true)
    expect(lastSocket().url).toBe(`ws://${location.host}/api/ws/parent`)
    expect(store.enabled).toBe(true)
    expect(store.status).toBe('connecting')

    lastSocket().open()
    expect(store.status).toBe('open')
  })

  it('parentWs reloads children on change', async () => {
    mock.onGet('/parent/children').reply(200, [MING, HUA])
    const children = useChildrenStore()
    children.seed([MING])
    const store = connectOpen()
    const childrenRequests = () => mock.history.get.filter((r) => r.url === '/parent/children').length

    lastSocket().message({ type: 'ready', children: ['s1'] })
    await flushPromises()

    expect(store.children).toEqual(['s1'])
    expect(childrenRequests()).toBe(0)

    lastSocket().message({ type: 'children_changed', children: ['s1', 's2'] })
    await flushPromises()

    expect(store.children).toEqual(['s1', 's2'])
    expect(childrenRequests()).toBe(1)
    expect(children.items.map((c) => c.id)).toEqual(['s1', 's2'])

    // 同一組 id、順序不同：不重抓
    lastSocket().message({ type: 'children_changed', children: ['s2', 's1'] })
    await flushPromises()

    expect(store.children).toEqual(['s2', 's1'])
    expect(childrenRequests()).toBe(1)
  })

  it('parentWs reloads children when one was unbound', async () => {
    mock.onGet('/parent/children').reply(200, [MING])
    const children = useChildrenStore()
    children.seed([MING, HUA])
    connectOpen()

    lastSocket().message({ type: 'children_changed', children: ['s1'] })
    await flushPromises()

    expect(mock.history.get.filter((r) => r.url === '/parent/children')).toHaveLength(1)
    expect(children.items.map((c) => c.id)).toEqual(['s1'])
  })

  it('parentWs ignores a malformed children list', async () => {
    const children = useChildrenStore()
    children.seed([MING])
    const store = connectOpen()

    lastSocket().message({ type: 'ready' })
    lastSocket().message({ type: 'children_changed', children: 's1' })
    lastSocket().message({ type: 'children_changed', children: ['s1', 42] })
    await flushPromises()

    expect(store.children).toEqual([])
    expect(mock.history.get).toHaveLength(0)
  })

  it('parentWs polls after reconnect', () => {
    const store = useParentWsStore()
    let polls = 0
    store.registerPoller(() => {
      polls += 1
    })
    store.connect()
    lastSocket().open()
    // 第一次連線成功不是重連，不輪詢
    expect(polls).toBe(0)

    lastSocket().close(1006)
    // 斷線當下 FRONTEND-004 立即補一次
    expect(polls).toBe(1)
    expect(store.status).toBe('reconnecting')

    vi.advanceTimersByTime(1000)
    expect(sockets).toHaveLength(2)
    lastSocket().open()

    // 重連成功補齊斷線期間遺漏的事件
    expect(polls).toBe(2)
    expect(store.status).toBe('open')
    expect(polls).toBeGreaterThanOrEqual(1)
  })

  it('parentWs polls periodically while disconnected', () => {
    const store = connectOpen()
    const poller = vi.fn()
    store.registerPoller(poller)

    lastSocket().close(1006)
    expect(poller).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(30000)
    expect(poller).toHaveBeenCalledTimes(3)
  })

  it('parentWs stops on 4401', () => {
    const store = connectOpen()
    const poller = vi.fn()
    store.registerPoller(poller)

    lastSocket().close(4401)

    expect(store.enabled).toBe(false)
    expect(store.status).toBe('closed')
    vi.advanceTimersByTime(60000)
    expect(sockets).toHaveLength(1)
    expect(poller).not.toHaveBeenCalled()
  })

  it('parentWs stops on 4403 and can connect again', () => {
    const store = connectOpen()

    lastSocket().close(4403)
    expect(store.enabled).toBe(false)
    expect(store.status).toBe('closed')
    vi.advanceTimersByTime(60000)
    expect(sockets).toHaveLength(1)

    store.connect()

    expect(sockets).toHaveLength(2)
    expect(store.enabled).toBe(true)
    expect(store.status).toBe('connecting')
  })

  it('parentWs handler error isolated', () => {
    const store = useParentWsStore()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const received: unknown[] = []
    store.on('notification.created', () => {
      throw new Error('handler 壞掉')
    })
    store.on('notification.created', (data) => received.push(data))
    store.connect()
    lastSocket().open()

    expect(() =>
      lastSocket().message({ type: 'notification.created', data: { id: 'n1' }, sent_at: SENT_AT }),
    ).not.toThrow()

    expect(received).toEqual([{ id: 'n1' }])
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('parentWs disconnect stops the client and resets state', () => {
    const store = connectOpen()
    lastSocket().message({ type: 'ready', children: ['s1'] })
    expect(store.children).toEqual(['s1'])
    const socket = lastSocket()

    store.disconnect()

    expect(store.enabled).toBe(false)
    expect(store.status).toBe('idle')
    expect(store.children).toEqual([])
    expect(socket.closeCalls).toBe(1)
    expect(socket.onclose).toBeNull()
    vi.advanceTimersByTime(60000)
    expect(sockets).toHaveLength(1)

    // 再 disconnect 不會出錯
    store.disconnect()
    expect(store.enabled).toBe(false)
  })

  it('parentWs keeps handlers and pollers across disconnect and connect', () => {
    const store = useParentWsStore()
    const received: unknown[] = []
    const poller = vi.fn()
    store.on('pickup.request_updated', (data) => received.push(data))
    store.registerPoller(poller)

    store.connect()
    lastSocket().open()
    lastSocket().message({ type: 'pickup.request_updated', data: { id: 'r1' }, sent_at: SENT_AT })
    store.disconnect()
    store.connect()
    expect(sockets).toHaveLength(2)
    lastSocket().open()
    lastSocket().message({ type: 'pickup.request_updated', data: { id: 'r2' }, sent_at: SENT_AT })

    expect(received).toEqual([{ id: 'r1' }, { id: 'r2' }])

    lastSocket().close(1006)
    expect(poller).toHaveBeenCalledTimes(1)
  })

  it('parentWs pollNow runs every poller and isolates failures', () => {
    const store = useParentWsStore()
    const calls: string[] = []
    store.registerPoller(() => {
      calls.push('a')
      throw new Error('a 壞掉')
    })
    store.registerPoller(() => {
      calls.push('b')
      return Promise.reject(new Error('b 壞掉'))
    })
    const offC = store.registerPoller(() => {
      calls.push('c')
    })

    expect(() => store.pollNow()).not.toThrow()
    expect(calls).toEqual(['a', 'b', 'c'])

    offC()
    store.pollNow()
    expect(calls).toEqual(['a', 'b', 'c', 'a', 'b'])
  })

  it('parentWs logs control errors without changing state', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = connectOpen()
    lastSocket().message({ type: 'ready', children: ['s1'] })

    expect(() => lastSocket().message({ type: 'error', code: 'not_allowed' })).not.toThrow()

    expect(store.children).toEqual(['s1'])
    expect(store.enabled).toBe(true)
    expect(store.status).toBe('open')
    expect(consoleWarn).toHaveBeenCalledTimes(1)
    expect(consoleWarn.mock.calls[0]).toContain('not_allowed')
  })

  it('parentWs status follows the client lifecycle', () => {
    const store = useParentWsStore()
    expect(store.status).toBe('idle')

    store.connect()
    expect(store.status).toBe('connecting')
    lastSocket().open()
    expect(store.status).toBe('open')
    lastSocket().close(1006)
    expect(store.status).toBe('reconnecting')
    vi.advanceTimersByTime(1000)
    expect(store.status).toBe('reconnecting')
    lastSocket().open()
    expect(store.status).toBe('open')
    lastSocket().close(4401)
    expect(store.status).toBe('closed')
  })
})

// PARENT-211：家長端 spec 一律用 src/test 的共用假 WebSocket（FRONTEND-312），不再各自定義
const LOCAL_FAKE_SOCKET = /^\s*(?:export\s+)?class FakeWebSocket\b/m
const parentSpecSources = import.meta.glob<string>('/src/parent/**/*.spec.ts', { query: '?raw', import: 'default', eager: true })

describe('parentWs shared fake socket', () => {
  it('parentWs spec uses shared fake socket', () => {
    expect(ownSource).not.toMatch(LOCAL_FAKE_SOCKET)
    expect(ownSource).toMatch(/import \{[^}]*\binstallFakeWebSocket\b[^}]*\} from '@\/test\/fakeWebSocket'/)
  })

  it('parentWs parent specs have no local fake socket', () => {
    const files = Object.keys(parentSpecSources)
    // 確認掃描真的讀到家長端各層的 spec（避免 glob 失效造成空轉）；vite 的 glob 不含本檔，本檔由上一條以 ?raw 檢查
    for (const expected of [
      '/src/parent/main.spec.ts',
      '/src/parent/stores/notifications.spec.ts',
      '/src/parent/views/PickupView.spec.ts',
      '/src/parent/components/ConnectionBanner.spec.ts',
    ]) {
      expect(files).toContain(expected)
    }
    const offenders = Object.entries(parentSpecSources)
      .filter(([, source]) => LOCAL_FAKE_SOCKET.test(source))
      .map(([file]) => file)
    expect(offenders).toEqual([])
  })
})
