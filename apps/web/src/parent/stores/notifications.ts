// PARENT-172：家長端收件匣、未讀數與 ws 即時新增（新寫功能）。
// - load 重置為第 1 頁並以序號丟棄過期回應；loadMore 以 id 去重附加。
// - unreadCount 是「更多」分頁徽章（PARENT-024）的來源：markRead 只在該筆原本未讀時減 1，
//   ws notification.created 只在 id 不存在時插到最前並 +1；斷線期間由 parentWs poller 以 refreshUnread 補齊。
// - 伺服器回來的未讀數（load / loadMore / refreshUnread）依發出順序取號，較早發出、較晚回來的不蓋掉較新的結果；
//   本地增減（markRead 減 1、markAllRead 歸零、ws 加 1）把已套用號碼推到最新，在途的未讀數回應一律作廢。
// - clear()（登出 / 換人）讓在途請求全部失效：load / loadMore / refreshUnread / markRead / markAllRead 晚到的回應都不寫回，
//   呼叫端的 promise 照常 resolve / reject。
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
  // clear 的次數：已讀操作發出時記下，回來時不同就表示已換人，不能再動本地狀態
  let epoch = 0
  // 伺服器未讀數的發出號碼與已套用的最大號碼；clear 時把已套用推到最新，在途的一律作廢
  let unreadIssued = 0
  let unreadApplied = 0

  /** 本地增減未讀數：等同作廢所有在途的伺服器未讀數回應（它們反映的是增減前的狀態） */
  function adjustUnread(next: number): void {
    unreadApplied = unreadIssued
    unreadCount.value = next
  }

  function applyUnread(ticket: number, count: number): void {
    if (ticket <= unreadApplied) return
    unreadApplied = ticket
    unreadCount.value = count
  }

  async function load({ unreadOnly: only = false }: { unreadOnly?: boolean } = {}): Promise<void> {
    const mySeq = ++seq
    const ticket = ++unreadIssued
    unreadOnly.value = only
    loading.value = true
    error.value = null
    try {
      const res = await listNotifications({ unreadOnly: only, page: 1, pageSize: PAGE_SIZE })
      if (mySeq !== seq) return
      items.value = res.items
      total.value = res.total
      applyUnread(ticket, res.unread_count)
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
    const ticket = ++unreadIssued
    const next = page.value + 1
    loading.value = true
    try {
      const res = await listNotifications({ unreadOnly: unreadOnly.value, page: next, pageSize: PAGE_SIZE })
      if (mySeq !== seq) return
      const known = new Set(items.value.map((n) => n.id))
      items.value = [...items.value, ...res.items.filter((n) => !known.has(n.id))]
      total.value = res.total
      applyUnread(ticket, res.unread_count)
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
    const ticket = ++unreadIssued
    try {
      const res = await listNotifications({ page: 1, pageSize: 1 })
      applyUnread(ticket, res.unread_count)
    } catch {
      // 盡力而為
    }
  }

  async function markRead(id: string): Promise<void> {
    const startEpoch = epoch
    const updated = await markNotificationRead(id)
    if (epoch !== startEpoch) return
    const index = items.value.findIndex((n) => n.id === id)
    if (index < 0) return
    const current = items.value[index]!
    if (current.read_at === null) adjustUnread(Math.max(0, unreadCount.value - 1))
    if (unreadOnly.value) {
      items.value = items.value.filter((n) => n.id !== id)
      total.value = Math.max(0, total.value - 1)
      return
    }
    items.value[index] = { ...current, read_at: updated.read_at ?? current.read_at ?? new Date().toISOString() }
  }

  async function markAllRead(): Promise<void> {
    const startEpoch = epoch
    await markAllNotificationsRead()
    if (epoch !== startEpoch) return
    const now = new Date().toISOString()
    items.value = items.value.map((n) => (n.read_at === null ? { ...n, read_at: now } : n))
    adjustUnread(0)
  }

  /** 登出 / 換人：清空並讓所有在途請求失效（晚到的回應不寫回） */
  function clear(): void {
    seq += 1
    epoch += 1
    unreadApplied = unreadIssued
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
    adjustUnread(unreadCount.value + 1)
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
