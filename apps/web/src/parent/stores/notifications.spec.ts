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

  it('notificationsStore markRead of read item keeps count', async () => {
    // 未讀數 2 來自其他頁的通知：標記本頁已讀的 n2 不可減
    mock.onGet('/parent/notifications').reply(200, { items: [N1, N2], total: 25, unread_count: 2 })
    mock.onPost('/parent/notifications/n2/read').reply(200, N2)
    const store = useNotificationsStore()
    await store.load()

    await store.markRead('n2')

    expect(store.unreadCount).toBe(2)
    expect(store.items[1]?.read_at).toBe('2026-10-02T08:40:00Z')
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

  /** 可手動決定何時回應的 reply */
  function deferredReply() {
    let resolve!: (value: [number, unknown]) => void
    const promise = new Promise<[number, unknown]>((r) => {
      resolve = r
    })
    return { reply: () => promise, resolve }
  }

  it('notificationsStore clear invalidates an in-flight load', async () => {
    const late = deferredReply()
    mock.onGet('/parent/notifications').replyOnce(late.reply)
    const store = useNotificationsStore()
    const p = store.load()
    await flushPromises()

    store.clear()
    late.resolve([200, { items: [N1, N2], total: 2, unread_count: 1 }])
    await p
    await flushPromises()

    expect(store.items).toEqual([])
    expect(store.total).toBe(0)
    expect(store.unreadCount).toBe(0)
    expect(store.loaded).toBe(false)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('notificationsStore clear invalidates an in-flight loadMore', async () => {
    mock.onGet('/parent/notifications').replyOnce(200, { items: [N1], total: 2, unread_count: 2 })
    const store = useNotificationsStore()
    await store.load()
    const late = deferredReply()
    mock.onGet('/parent/notifications').replyOnce(late.reply)
    const p = store.loadMore()
    await flushPromises()

    store.clear()
    late.resolve([200, { items: [notification('n5')], total: 2, unread_count: 2 }])
    await p
    await flushPromises()

    expect(store.items).toEqual([])
    expect(store.total).toBe(0)
    expect(store.unreadCount).toBe(0)
    expect(store.page).toBe(1)
    expect(store.loading).toBe(false)
  })

  it('notificationsStore clear invalidates an in-flight refreshUnread', async () => {
    const late = deferredReply()
    mock.onGet('/parent/notifications').replyOnce(late.reply)
    const store = useNotificationsStore()
    const p = store.refreshUnread()
    await flushPromises()

    store.clear() // 家長 A 登出
    late.resolve([200, { items: [notification('a1')], total: 9, unread_count: 5 }])
    await p
    await flushPromises()

    expect(store.unreadCount).toBe(0)

    // clear 之後新的 refreshUnread 照常更新（守衛不擋後來的請求）
    mock.onGet('/parent/notifications').replyOnce(200, { items: [], total: 3, unread_count: 3 })
    await store.refreshUnread()
    expect(store.unreadCount).toBe(3)
  })

  it('notificationsStore refreshUnread does not overwrite a newer load result', async () => {
    const late = deferredReply()
    mock.onGet('/parent/notifications').replyOnce(late.reply).onGet('/parent/notifications').replyOnce(200, { items: [N1, N2], total: 2, unread_count: 1 })
    const store = useNotificationsStore()

    // refreshUnread 先發出（page_size 1），load 後發出但先回來
    const refresh = store.refreshUnread()
    await flushPromises()
    await store.load()
    expect(store.unreadCount).toBe(1)
    expect(listRequests()).toEqual([
      { page: 1, page_size: 1 },
      { page: 1, page_size: 20 },
    ])

    late.resolve([200, { items: [notification('n9')], total: 7, unread_count: 5 }])
    await refresh
    await flushPromises()

    // 較舊的未讀數不得蓋掉 load 的結果
    expect(store.unreadCount).toBe(1)
    expect(store.items.map((n) => n.id)).toEqual(['n1', 'n2'])
  })

  it('notificationsStore clear invalidates an in-flight markAllRead', async () => {
    mock.onGet('/parent/notifications').replyOnce(200, { items: [notification('a1')], total: 1, unread_count: 1 })
    const store = useNotificationsStore()
    await store.load()
    const late = deferredReply()
    mock.onPost('/parent/notifications/read-all').replyOnce(late.reply)
    const p = store.markAllRead()
    await flushPromises()

    store.clear() // A 登出
    mock.onGet('/parent/notifications').replyOnce(200, { items: [notification('b1'), notification('b2')], total: 2, unread_count: 2 })
    await store.load() // B 登入後載入
    late.resolve([200, { updated: 1 }])
    await expect(p).resolves.toBeUndefined()
    await flushPromises()

    // A 的回應不得把 B 的通知標成已讀
    expect(store.items.map((n) => n.read_at)).toEqual([null, null])
    expect(store.unreadCount).toBe(2)
    expect(store.total).toBe(2)
  })

  it('notificationsStore clear invalidates an in-flight markRead', async () => {
    mock.onGet('/parent/notifications').replyOnce(200, { items: [notification('a1')], total: 1, unread_count: 1 })
    const store = useNotificationsStore()
    await store.load()
    const late = deferredReply()
    mock.onPost('/parent/notifications/a1/read').replyOnce(late.reply)
    const p = store.markRead('a1')
    await flushPromises()

    store.clear()
    // 下一位家長的清單裡剛好也有 a1（id 相同時守衛仍不得寫回上一位的結果）
    mock.onGet('/parent/notifications').replyOnce(200, { items: [notification('a1'), notification('b1')], total: 2, unread_count: 2 })
    await store.load()
    late.resolve([200, notification('a1', { read_at: '2026-10-02T09:00:00Z' })])
    await expect(p).resolves.toBeUndefined()
    await flushPromises()

    expect(store.items.map((n) => n.read_at)).toEqual([null, null])
    expect(store.unreadCount).toBe(2)
    expect(store.total).toBe(2)
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

  it('notificationsStore local markRead invalidates in-flight refreshUnread', async () => {
    const n3 = notification('n3')
    const n4 = notification('n4')
    mock.onGet('/parent/notifications').replyOnce(200, { items: [N1, n3, n4], total: 3, unread_count: 3 })
    const store = useNotificationsStore()
    await store.load()
    expect(store.unreadCount).toBe(3)
    const late = deferredReply()
    mock.onGet('/parent/notifications').replyOnce(late.reply)
    mock.onPost('/parent/notifications/n1/read').reply(200, { ...N1, read_at: '2026-10-02T09:00:00Z' })

    const refresh = store.refreshUnread()
    await flushPromises()
    await store.markRead('n1')
    expect(store.unreadCount).toBe(2)

    late.resolve([200, { items: [N1], total: 3, unread_count: 3 }])
    await refresh
    await flushPromises()

    expect(store.unreadCount).toBe(2)
  })

  it('notificationsStore local markAllRead invalidates in-flight refreshUnread', async () => {
    mock.onGet('/parent/notifications').replyOnce(200, { items: [N1, N2], total: 2, unread_count: 1 })
    const store = useNotificationsStore()
    await store.load()
    const late = deferredReply()
    mock.onGet('/parent/notifications').replyOnce(late.reply)
    mock.onPost('/parent/notifications/read-all').reply(200, { updated: 1 })

    const refresh = store.refreshUnread()
    await flushPromises()
    await store.markAllRead()
    expect(store.unreadCount).toBe(0)

    late.resolve([200, { items: [N1], total: 2, unread_count: 1 }])
    await refresh
    await flushPromises()

    expect(store.unreadCount).toBe(0)
  })

  it('notificationsStore ws created invalidates in-flight refreshUnread', async () => {
    mock.onGet('/parent/notifications').replyOnce(200, { items: [N1, N2], total: 2, unread_count: 1 })
    const store = useNotificationsStore()
    await store.load()
    const ws = useParentWsStore()
    ws.connect()
    lastSocket().serverOpen()
    const late = deferredReply()
    mock.onGet('/parent/notifications').replyOnce(late.reply)

    const refresh = store.refreshUnread()
    await flushPromises()
    lastSocket().serverMessage({ type: 'notification.created', data: notification('n3'), sent_at: SENT_AT })
    expect(store.unreadCount).toBe(2)

    late.resolve([200, { items: [N1], total: 2, unread_count: 1 }])
    await refresh
    await flushPromises()
    expect(store.unreadCount).toBe(2)

    // 本地增減之後新發出的 refreshUnread 照常套用
    mock.onGet('/parent/notifications').replyOnce(200, { items: [], total: 5, unread_count: 5 })
    await store.refreshUnread()
    expect(store.unreadCount).toBe(5)
  })
})
