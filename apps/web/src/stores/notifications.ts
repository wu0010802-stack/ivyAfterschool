// FRONTEND-034：員工站內通知收件匣（Pinia id `notifications`）。
// 移植 ivy FE:src/stores/notification.ts::useNotificationStore 的 in-flight 去重；資料來源改為收件匣 API
// （FRONTEND-033）與 /api/ws/admin 的個人訊息（FRONTEND-037）：notification.created 進收件匣並加未讀，
// notification.transient 只做即時提示（例如 pickup.arrived 的提示音），不進收件匣。
// items 最新在前、最多保留 MAX_ITEMS 筆；更多歷史由收件匣頁分頁查詢。
// reset()：登出（AdminLayout 卸載，FRONTEND-029）時清空；整個分頁共用同一個 pinia，不清的話下一位使用者會看到上一位的通知，
// reset 之前發出而晚到的請求結果（fetch / markRead / markAllRead）一律不得寫回。
import { ElNotification } from 'element-plus'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as notificationsApi from '@/api/notifications'
import type { Notification, NotificationEvent } from '@/shared/types/api'
import { useAdminWsStore } from '@/stores/adminWs'

export const MAX_ITEMS = 50
const PAGE_SIZE = 20

/** ws `notification.transient` 的 data（api_index §15） */
export interface TransientNotification {
  event: NotificationEvent
  title: string
  body: string
  payload: Record<string, unknown>
}

export type TransientListener = (n: TransientNotification) => void

function isTransient(data: unknown): data is TransientNotification {
  if (data === null || typeof data !== 'object') return false
  const d = data as Partial<TransientNotification>
  return typeof d.event === 'string' && typeof d.title === 'string'
}

export const useNotificationsStore = defineStore('notifications', () => {
  const items = ref<Notification[]>([])
  const unreadCount = ref(0)
  const total = ref(0)
  const loading = ref(false)
  const loaded = ref(false)

  // 同一種 fetch 併發共用 promise；不同種（全部 / 只看未讀）各自送出，只有最後發出的那次可以寫回
  let inflight: { unreadOnly: boolean; promise: Promise<void> } | null = null
  let seq = 0
  // reset 的次數：已讀操作發出時記下，回來時不同就表示已換人，不能再動本地狀態
  let epoch = 0

  const transientListeners = new Set<TransientListener>()
  let unbindWs: (() => void) | null = null

  function fetch({ unreadOnly = false }: { unreadOnly?: boolean } = {}): Promise<void> {
    if (inflight && inflight.unreadOnly === unreadOnly) return inflight.promise
    const mySeq = ++seq
    loading.value = true
    const params: notificationsApi.NotificationQuery = { page_size: PAGE_SIZE }
    if (unreadOnly) params.unread_only = true
    const promise = notificationsApi
      .listNotifications(params)
      .then((page) => {
        if (mySeq !== seq) return
        items.value = page.items.slice(0, MAX_ITEMS)
        unreadCount.value = page.unread_count
        total.value = page.total
        loaded.value = true
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null
        if (mySeq === seq) loading.value = false
      })
    inflight = { unreadOnly, promise }
    return promise
  }

  /** 樂觀更新，API 失敗則還原並 rethrow；已讀的不重送。不在清單中的只送 API、不動本地狀態 */
  async function markRead(id: string): Promise<void> {
    const target = items.value.find((n) => n.id === id)
    if (target && target.read_at !== null) return
    const decremented = target !== undefined && unreadCount.value > 0
    const startEpoch = epoch
    if (target) target.read_at = new Date().toISOString()
    if (decremented) unreadCount.value -= 1
    try {
      const updated = await notificationsApi.markNotificationRead(id)
      if (target) target.read_at = updated.read_at ?? target.read_at
    } catch (err) {
      if (target) target.read_at = null
      if (decremented && epoch === startEpoch) unreadCount.value += 1
      throw err
    }
  }

  /** 成功後才把全部標成已讀、未讀歸 0（不樂觀） */
  async function markAllRead(): Promise<{ updated: number }> {
    const startEpoch = epoch
    const result = await notificationsApi.markAllNotificationsRead()
    if (epoch !== startEpoch) return result
    const now = new Date().toISOString()
    for (const n of items.value) {
      if (n.read_at === null) n.read_at = now
    }
    unreadCount.value = 0
    return result
  }

  /**
   * 清空收件匣並讓在途的請求失效（登出）：回到尚未載入的初始狀態，下一次 fetch 不共用上一個請求，
   * 上一個請求晚到的回應也不會寫回。不動 ws 綁定與暫態訊息的訂閱（由各自的擁有者解除）。
   */
  function reset(): void {
    epoch += 1
    seq += 1
    inflight = null
    items.value = []
    unreadCount.value = 0
    total.value = 0
    loading.value = false
    loaded.value = false
  }

  /** ws 即時新增：同 id 已存在則忽略 */
  function receive(n: Notification): void {
    if (items.value.some((x) => x.id === n.id)) return
    items.value.unshift(n)
    if (items.value.length > MAX_ITEMS) items.value.splice(MAX_ITEMS)
    if (n.read_at === null) unreadCount.value += 1
    total.value += 1
  }

  function emitTransient(data: unknown): void {
    if (!isTransient(data)) return
    const n: TransientNotification = {
      event: data.event,
      title: data.title,
      body: typeof data.body === 'string' ? data.body : '',
      payload: data.payload !== null && typeof data.payload === 'object' ? data.payload : {},
    }
    ElNotification({ title: n.title, message: n.body, type: 'warning' })
    for (const listener of transientListeners) {
      try {
        listener(n)
      } catch (err) {
        console.error('[notifications] transient listener 執行失敗', n.event, err)
      }
    }
  }

  /** 綁定 adminWs 的個人訊息；重複呼叫回傳同一個解除函式，不重複綁定 */
  function bindWs(): () => void {
    if (unbindWs) return unbindWs
    const adminWs = useAdminWsStore()
    const offs = [
      adminWs.on<Notification>('notification.created', (n) => receive(n)),
      adminWs.on('notification.transient', (data) => emitTransient(data)),
    ]
    const off = (): void => {
      if (unbindWs !== off) return
      for (const f of offs) f()
      unbindWs = null
    }
    unbindWs = off
    return off
  }

  /** 暫態訊息訂閱（接送頁提示音用，FRONTEND-187）；回傳解除函式 */
  function onTransient(listener: TransientListener): () => void {
    transientListeners.add(listener)
    return () => {
      transientListeners.delete(listener)
    }
  }

  return {
    items,
    unreadCount,
    total,
    loading,
    loaded,
    fetch,
    markRead,
    markAllRead,
    reset,
    receive,
    bindWs,
    onTransient,
  }
})
