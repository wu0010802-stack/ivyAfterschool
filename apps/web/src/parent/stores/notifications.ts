// PARENT-172：家長端收件匣、未讀數與 ws 即時新增（新寫功能）。
// - load 重置為第 1 頁並以序號丟棄過期回應；loadMore 以 id 去重附加。
// - unreadCount 是「更多」分頁徽章（PARENT-024）的來源：markRead 只在該筆原本未讀時減 1，
//   ws notification.created 只在 id 不存在時插到最前並 +1；斷線期間由 parentWs poller 以 refreshUnread 補齊。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Notification } from '@/shared/types/api'
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../api/notifications'
import { useParentWsStore } from './parentWs'

const PAGE_SIZE = 20
const LOAD_ERROR = '通知載入失敗'

function isNotification(value: unknown): value is Notification {
  return value !== null && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
}

export const useNotificationsStore = defineStore('parentNotifications', () => {
  const parentWs = useParentWsStore()

  const items = ref<Notification[]>([])
  const total = ref(0)
  const unreadCount = ref(0)
  const page = ref(1)
  const unreadOnly = ref(false)
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // 每次 load / clear 遞增；較舊請求（含 loadMore）的回應一律丟棄
  let seq = 0

  async function load({ unreadOnly: only = false }: { unreadOnly?: boolean } = {}): Promise<void> {
    const mySeq = ++seq
    unreadOnly.value = only
    loading.value = true
    error.value = null
    try {
      const res = await listNotifications({ unreadOnly: only, page: 1, pageSize: PAGE_SIZE })
      if (mySeq !== seq) return
      items.value = res.items
      total.value = res.total
      unreadCount.value = res.unread_count
      page.value = 1
      loaded.value = true
    } catch {
      if (mySeq !== seq) return
      error.value = LOAD_ERROR
    } finally {
      if (mySeq === seq) loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (loading.value || items.value.length >= total.value) return
    const mySeq = seq
    const next = page.value + 1
    loading.value = true
    try {
      const res = await listNotifications({ unreadOnly: unreadOnly.value, page: next, pageSize: PAGE_SIZE })
      if (mySeq !== seq) return
      const known = new Set(items.value.map((n) => n.id))
      items.value = [...items.value, ...res.items.filter((n) => !known.has(n.id))]
      total.value = res.total
      unreadCount.value = res.unread_count
      page.value = next
    } catch {
      if (mySeq !== seq) return
      error.value = LOAD_ERROR
    } finally {
      if (mySeq === seq) loading.value = false
    }
  }

  /** 只更新未讀數（page_size 1 取 unread_count），不動 items；失敗忽略（輪詢下次再補） */
  async function refreshUnread(): Promise<void> {
    try {
      const res = await listNotifications({ page: 1, pageSize: 1 })
      unreadCount.value = res.unread_count
    } catch {
      // 盡力而為
    }
  }

  async function markRead(id: string): Promise<void> {
    const updated = await markNotificationRead(id)
    const index = items.value.findIndex((n) => n.id === id)
    if (index < 0) return
    const current = items.value[index]!
    if (current.read_at === null) unreadCount.value = Math.max(0, unreadCount.value - 1)
    if (unreadOnly.value) {
      items.value = items.value.filter((n) => n.id !== id)
      total.value = Math.max(0, total.value - 1)
      return
    }
    items.value[index] = { ...current, read_at: updated.read_at ?? current.read_at ?? new Date().toISOString() }
  }

  async function markAllRead(): Promise<void> {
    await markAllNotificationsRead()
    const now = new Date().toISOString()
    items.value = items.value.map((n) => (n.read_at === null ? { ...n, read_at: now } : n))
    unreadCount.value = 0
  }

  function clear(): void {
    seq += 1
    items.value = []
    total.value = 0
    unreadCount.value = 0
    page.value = 1
    unreadOnly.value = false
    loaded.value = false
    loading.value = false
    error.value = null
  }

  parentWs.on('notification.created', (data) => {
    if (!isNotification(data)) return
    if (items.value.some((n) => n.id === data.id)) return
    items.value = [data, ...items.value]
    total.value += 1
    unreadCount.value += 1
  })
  parentWs.registerPoller(refreshUnread)

  return {
    items,
    total,
    unreadCount,
    page,
    unreadOnly,
    loaded,
    loading,
    error,
    load,
    loadMore,
    refreshUnread,
    markRead,
    markAllRead,
    clear,
  }
})
