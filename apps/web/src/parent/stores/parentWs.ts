// PARENT-173：家長端單一 /api/ws/parent 連線（BACKEND-227），以 FRONTEND-004 createWsClient 建立。
// 新寫功能（ivy 家長端用 SSE / 輪詢，不移植）。
//
// - 業務 store 建立時就向這裡註冊 handler / poller（可能早於 connect），store 自己保存註冊表，
//   建立 client 時以 client.on('*') 轉發；disconnect / connect 換 client 後註冊仍有效。
// - 後端連線後自動訂閱全部小孩，家長不送 subscribe（會回 not_allowed）；ready / children_changed
//   帶最新的小孩 id，與 PARENT-010 children store 的 id 集合不同時重抓（新綁定或解除綁定）。
// - 推播為盡力而為：非 open 期間 FRONTEND-004 定期呼叫 pollNow，重連成功再補一次。
// - 4401 / 4403 後 FRONTEND-004 已停止重連；之後任一 API 401 由 PARENT-004 導回登入。
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { WsEnvelope } from '@/shared/types/api'
import { createWsClient, type WsClient, type WsHandler, type WsStatus } from '@/shared/ws/createWsClient'
import { useChildrenStore } from './children'

const WS_PATH = '/api/ws/parent'

/** 系統訊息沒有 data，欄位在信封頂層 */
interface ControlMessage {
  type: string
  children?: unknown
  code?: unknown
}

function controlChildren(env: WsEnvelope): string[] | null {
  const children = (env as unknown as ControlMessage).children
  if (!Array.isArray(children) || !children.every((id) => typeof id === 'string')) return null
  return children as string[]
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every((id) => set.has(id))
}

export const useParentWsStore = defineStore('parentWs', () => {
  const childrenStore = useChildrenStore()

  const client = shallowRef<WsClient | null>(null)
  const enabled = ref(false)
  const status = computed<WsStatus>(() => client.value?.status.value ?? 'idle')
  /** 最近一次 ready / children_changed 的小孩 id */
  const children = ref<string[]>([])

  const handlers = new Map<string, Set<WsHandler>>()
  const pollers = new Set<() => unknown>()

  function dispatch(data: unknown, env: WsEnvelope): void {
    const targets = [...(handlers.get(env.type) ?? []), ...(handlers.get('*') ?? [])]
    for (const handler of targets) {
      try {
        handler(data, env)
      } catch (err) {
        console.error('[parentWs] handler 執行失敗', env.type, err)
      }
    }
  }

  function onChildrenMessage(_: unknown, env: WsEnvelope): void {
    const ids = controlChildren(env)
    if (ids === null) return
    children.value = ids
    const known = childrenStore.items.map((c) => c.id)
    if (!sameIdSet(known, ids)) void childrenStore.load(true)
  }

  function onControlError(_: unknown, env: WsEnvelope): void {
    console.warn('[parentWs] 伺服器回報錯誤', (env as unknown as ControlMessage).code)
  }

  /** 依序執行全部 poller，單一 poller 失敗（含 rejected promise）不影響其他 */
  function pollNow(): void {
    for (const fn of pollers) {
      try {
        void Promise.resolve(fn()).catch(() => undefined)
      } catch {
        // 忽略，下一個繼續
      }
    }
  }

  function connect(): void {
    if (enabled.value) return
    client.value?.stop()
    const c = createWsClient({
      path: WS_PATH,
      onOpen: ({ isReconnect }) => {
        if (isReconnect) pollNow()
      },
      onPoll: pollNow,
      onAuthClose: () => {
        enabled.value = false
      },
    })
    c.on('*', dispatch)
    c.on('ready', onChildrenMessage)
    c.on('children_changed', onChildrenMessage)
    c.on('error', onControlError)
    client.value = c
    enabled.value = true
    c.start()
  }

  function disconnect(): void {
    client.value?.stop()
    client.value = null
    enabled.value = false
    children.value = []
  }

  /** type '*' 收全部；回傳解除函式 */
  function on<T = unknown>(type: string, handler: WsHandler<T>): () => void {
    let set = handlers.get(type)
    if (!set) {
      set = new Set()
      handlers.set(type, set)
    }
    const h = handler as WsHandler
    set.add(h)
    return () => {
      handlers.get(type)?.delete(h)
    }
  }

  function registerPoller(fn: () => unknown): () => void {
    pollers.add(fn)
    return () => {
      pollers.delete(fn)
    }
  }

  return {
    enabled,
    status,
    children,
    connect,
    disconnect,
    on,
    registerPoller,
    pollNow,
  }
})
