// PARENT-009：家長登入狀態（移植 ivy FE:src/parent/stores/parentAuth.ts::useParentAuthStore，
// user 改為具型別的 ParentMe；首次探測移植 FE:src/parent/main.ts::ensureSessionProbed）。
//
// 登入真相在 httpOnly cookie（parent_access / parent_refresh / parent_bind），瀏覽器讀不到，
// 這裡的 state 只是「cookie 狀態的鏡像」供畫面與路由守衛使用：
//   - parent：已登入（持有 parent_access）；sessionStorage 還原只是省一次探測，不是登入真相。
//   - bindPending：LoginView 收到 needs_binding（持有 parent_bind，等待輸入綁定碼）。
// sessionStorage 被清空（新分頁 / 隱私視窗）而 cookie 仍有效時，ensureSession 探測 /parent/me 還原登入。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { logout as apiLogout } from '../api/auth'
import { getMe, type ParentMe } from '../api/children'

export const PARENT_ME_STORAGE_KEY = 'parent_me_v1'
export const PARENT_BIND_PENDING_STORAGE_KEY = 'parent_bind_pending_v1'

export interface BindPending {
  /** LINE 暱稱，供綁定頁問候；後端沒給時為 null */
  nameHint: string | null
}

function readStored<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return isValid(parsed) ? parsed : null
  } catch {
    // storage 不可用或內容損毀：視同沒有，改以記憶體運作
    return null
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 無痕模式、配額滿等情況：只是失去跨頁面重新整理的記憶
  }
}

function isParentMe(value: unknown): value is ParentMe {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    Array.isArray((value as { children?: unknown }).children)
  )
}

function isBindPending(value: unknown): value is BindPending {
  if (value === null || typeof value !== 'object') return false
  const hint = (value as { nameHint?: unknown }).nameHint
  return hint === null || typeof hint === 'string'
}

export const useParentAuthStore = defineStore('parentAuth', () => {
  const parent = ref<ParentMe | null>(readStored(PARENT_ME_STORAGE_KEY, isParentMe))
  const bindPending = ref<BindPending | null>(readStored(PARENT_BIND_PENDING_STORAGE_KEY, isBindPending))

  const isAuthed = computed(() => parent.value !== null)
  const displayName = computed(() => parent.value?.display_name ?? '')

  // 進行中的探測（並發呼叫共用）；探測失敗在同一頁面生命週期內快取，直到 state 被改動才重新允許
  let probe: Promise<boolean> | null = null
  let probeFailed = false

  function allowProbe(): void {
    probe = null
    probeFailed = false
  }

  function writeParent(value: ParentMe | null): void {
    parent.value = value
    writeStored(PARENT_ME_STORAGE_KEY, value)
  }

  function writeBindPending(value: BindPending | null): void {
    bindPending.value = value
    writeStored(PARENT_BIND_PENDING_STORAGE_KEY, value)
  }

  /** 登入 / 綁定 / 探測成功：綁定待辦同時結束 */
  function setParent(p: ParentMe): void {
    allowProbe()
    writeParent(p)
    writeBindPending(null)
  }

  function markBindPending(nameHint: string | null): void {
    allowProbe()
    writeBindPending({ nameHint })
  }

  function clearBindPending(): void {
    writeBindPending(null)
  }

  function clear(): void {
    allowProbe()
    writeParent(null)
    writeBindPending(null)
  }

  /**
   * 已登入直接 true；否則探測 /parent/me 一次（401 由 PARENT-004 自動 refresh 後仍失敗才算失敗）。
   * 失敗的結果會快取，之後的呼叫直接回 false，直到 setParent / clear / markBindPending。
   * 探測失敗只清 parent，不動 bindPending（瀏覽器可能仍持有 parent_bind cookie）。
   */
  function ensureSession(): Promise<boolean> {
    if (parent.value !== null) return Promise.resolve(true)
    if (probeFailed) return Promise.resolve(false)
    if (probe) return probe
    const current: Promise<boolean> = getMe()
      .then(
        (me) => {
          setParent(me)
          return true
        },
        () => {
          // 探測期間已由別處登入（例如 LoginView）：以較新的狀態為準，不快取失敗
          if (parent.value !== null) return true
          probeFailed = true
          writeParent(null)
          return false
        },
      )
      .finally(() => {
        if (probe === current) probe = null
      })
    probe = current
    return current
  }

  /** 呼叫後端撤銷 refresh family（失敗忽略），然後清除本地狀態 */
  async function logout(): Promise<void> {
    try {
      await apiLogout()
    } catch {
      // cookie 可能已失效；本地一律清掉
    }
    clear()
  }

  return {
    parent,
    bindPending,
    isAuthed,
    displayName,
    setParent,
    markBindPending,
    clearBindPending,
    ensureSession,
    logout,
    clear,
  }
})
