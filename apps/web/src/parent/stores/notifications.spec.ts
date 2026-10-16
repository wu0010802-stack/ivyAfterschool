import type MockAdapter from 'axios-mock-adapter'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock } from '@/test/helpers'
import type { Notification } from '@/shared/types/api'
import { parentHttp } from '../api/http'
import { useNotificationsStore } from './notifications'
import { useParentWsStore } from './parentWs'

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

const SENT_AT = '2026-10-02T09:00:00Z'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器發生錯誤', details: null } }

function notification(id: string, overrides: Partial<Notification> = {}): Notification {
  return {
    id,
    event: 'homework.done',
    title: '作業已完成',
    body: '王小明的作業已完成，可以來接送了',
    payload: { student_id: 's1' },
    read_at: null,
    created_at: '2026-10-02T08:30:00Z',
    deep_link: '/homework',
    ...overrides,
  }
}

const N1 = notification('n1')
const N2 = notification('n2', { read_at: '2026-10-02T08:40:00Z', title: '已到班' })

type ListParams = { page?: number; page_size?: number; unread_only?: boolean }

describe('notificationsStore', () => {
  let mock: MockAdapter

  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    setActivePinia(createPinia())
    mock = createApiMock(parentHttp)
  })

  afterEach(() => {
    useParentWsStore().disconnect()
    mock.restore()
  })

  function listRequests(): ListParams[] {
    return mock.history.get.filter((r) => r.url === '/parent/notifications').map((r) => r.params as ListParams)
  }

  async function loadedStore(): Promise<ReturnType<typeof useNotificationsStore>> {
    mock.onGet('/parent/notifications').reply(200, { items: [N1, N2], total: 2, unread_count: 1 })
    const store = useNotificationsStore()
    await store.load()
    return store
  }

  it('notificationsStore load sets unread count', async () => {
    const store = await loadedStore()

    expect(store.items).toHaveLength(2)
    expect(store.items.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(store.total).toBe(2)
    expect(store.unreadCount).toBe(1)
    expect(store.page).toBe(1)
    expect(store.unreadOnly).toBe(false)
    expect(store.loaded).toBe(true)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
    expect(listRequests()).toEqual([{ page: 1, page_size: 20 }])
  })

  it('notificationsStore load unreadOnly resets to first page', async () => {
    const store = await loadedStore()
    mock.reset()
    mock.onGet('/parent/notifications').reply(200, { items: [N1], total: 1, unread_count: 1 })

    await store.load({ unreadOnly: true })

    expect(store.unreadOnly).toBe(true)
    expect(store.items.map((n) => n.id)).toEqual(['n1'])
    expect(store.total).toBe(1)
    expect(store.page).toBe(1)
    expect(listRequests()).toEqual([{ unread_only: true, page: 1, page_size: 20 }])
  })

  it('notificationsStore load drops stale response', async () => {
    let releaseFirst!: () => void
    const first = new Promise<[number, unknown]>((resolve) => {
      releaseFirst = () => resolve([200, { items: [N1, N2], total: 2, unread_count: 1 }])
    })
    mock
      .onGet('/parent/notifications')
      .replyOnce(() => first)
      .onGet('/parent/notifications')
      .replyOnce(200, { items: [N1], total: 1, unread_count: 1 })
    const store = useNotificationsStore()

    const stale = store.load()
    const fresh = store.load({ unreadOnly: true })
    await fresh
    expect(store.items.map((n) => n.id)).toEqual(['n1'])

    releaseFirst()
    await stale
    await flushPromises()

    // 第一次（較舊）的回應晚到，不可蓋掉未讀篩選的結果
    expect(store.items.map((n) => n.id)).toEqual(['n1'])
    expect(store.unreadOnly).toBe(true)
    expect(store.total).toBe(1)
    expect(store.loading).toBe(false)
  })

  it('notificationsStore load error keeps previous items', async () => {
    const store = await loadedStore()
    mock.reset()
    mock.onGet('/parent/notifications').reply(500, SERVER_ERROR)

    await store.load()

    expect(store.error).toBe('通知載入失敗')
    expect(store.items.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(store.loading).toBe(false)
  })

  it('notificationsStore markRead decrements once', async () => {
    const store = await loadedStore()
    mock.onPost('/parent/notifications/n1/read').reply(200, { ...N1, read_at: '2026-10-02T09:00:00Z' })
    mock.onPost('/parent/notifications/n2/read').reply(200, N2)

    await store.markRead('n1')

    expect(mock.history.post.map((r) => r.url)).toEqual(['/parent/notifications/n1/read'])
    expect(store.items[0]?.read_at).toBe('2026-10-02T09:00:00Z')
    expect(store.unreadCount).toBe(0)

    await store.markRead('n2')

    expect(mock.history.post).toHaveLength(2)
    expect(store.unreadCount).toBe(0)
    expect(store.items).toHaveLength(2)
  })

  it('notificationsStore markRead removes item in unreadOnly mode', async () => {
    mock.onGet('/parent/notifications').reply(200, { items: [N1], total: 1, unread_count: 1 })
    mock.onPost('/parent/notifications/n1/read').reply(200, { ...N1, read_at: '2026-10-02T09:00:00Z' })
    const store = useNotificationsStore()
    await store.load({ unreadOnly: true })

    await store.markRead('n1')

    expect(store.items).toHaveLength(0)
    expect(store.total).toBe(0)
    expect(store.unreadCount).toBe(0)
  })

  it('notificationsStore markRead failure leaves state untouched', async () => {
    const store = await loadedStore()
    mock.onPost('/parent/notifications/n1/read').reply(500, SERVER_ERROR)

    await expect(store.markRead('n1')).rejects.toMatchObject({ status: 500 })

    expect(store.items[0]?.read_at).toBeNull()
    expect(store.unreadCount).toBe(1)
  })

  it('notificationsStore ws prepends new', async () => {
    const store = await loadedStore()
    const ws = useParentWsStore()
    ws.connect()
    lastSocket().serverOpen()
    const n3 = notification('n3', { title: '作業已完成', read_at: null })

    lastSocket().serverMessage({ type: 'notification.created', data: n3, sent_at: SENT_AT })

    expect(store.items[0]?.id).toBe('n3')
    expect(store.items).toHaveLength(3)
    expect(store.unreadCount).toBe(2)
    expect(store.total).toBe(3)

    lastSocket().serverMessage({ type: 'notification.created', data: n3, sent_at: SENT_AT })

    expect(store.items).toHaveLength(3)
    expect(store.unreadCount).toBe(2)
    expect(store.total).toBe(3)
  })

  it('notificationsStore markAllRead', async () => {
    const store = await loadedStore()
    mock.onPost('/parent/notifications/read-all').reply(200, { updated: 2 })

    await store.markAllRead()

    expect(mock.history.post.map((r) => r.url)).toEqual(['/parent/notifications/read-all'])
    expect(store.items.every((n) => n.read_at !== null)).toBe(true)
    // 原本已讀的保留原時間
    expect(store.items[1]?.read_at).toBe('2026-10-02T08:40:00Z')
    expect(store.unreadCount).toBe(0)
  })

  it('notificationsStore loadMore dedupes', async () => {
    const firstPage = Array.from({ length: 20 }, (_, i) => notification(`n${i + 1}`))
    const secondPage = [notification('n20'), notification('n21')]
    mock.onGet('/parent/notifications').reply((config) => {
      const params = config.params as ListParams
      return [200, { items: params.page === 2 ? secondPage : firstPage, total: 21, unread_count: 21 }]
    })
    const store = useNotificationsStore()
    await store.load()
    expect(store.items).toHaveLength(20)

    await store.loadMore()

    expect(store.items).toHaveLength(21)
    expect(store.items.at(-1)?.id).toBe('n21')
    expect(store.page).toBe(2)
    expect(listRequests()).toEqual([
      { page: 1, page_size: 20 },
      { page: 2, page_size: 20 },
    ])

    // 已全部載入：不再請求
    await store.loadMore()
    expect(listRequests()).toHaveLength(2)
  })

  it('notificationsStore refreshUnread only updates count', async () => {
    const store = await loadedStore()
    mock.reset()
    mock.onGet('/parent/notifications').reply(200, { items: [notification('n9')], total: 5, unread_count: 4 })

    await store.refreshUnread()

    expect(store.unreadCount).toBe(4)
    expect(store.items.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(store.total).toBe(2)
    expect(listRequests()).toEqual([{ page: 1, page_size: 1 }])
  })

  it('notificationsStore poller refreshes unread count', async () => {
    const store = await loadedStore()
    mock.reset()
    mock.onGet('/parent/notifications').reply(200, { items: [], total: 2, unread_count: 2 })

    useParentWsStore().pollNow()
    await flushPromises()

    expect(listRequests()).toEqual([{ page: 1, page_size: 1 }])
    expect(store.unreadCount).toBe(2)
    expect(store.items).toHaveLength(2)
  })

  it('notificationsStore clear resets everything', async () => {
    const store = await loadedStore()

    store.clear()

    expect(store.items).toEqual([])
    expect(store.total).toBe(0)
    expect(store.unreadCount).toBe(0)
    expect(store.page).toBe(1)
    expect(store.unreadOnly).toBe(false)
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })
})
