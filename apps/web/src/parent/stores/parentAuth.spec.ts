import type MockAdapter from 'axios-mock-adapter'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock } from '@/test/helpers'
import type { ParentMe } from '../api/children'
import { parentHttp, parentRefreshHttp, setUnauthenticatedHandler } from '../api/http'
import { useParentAuthStore } from './parentAuth'

const ME_KEY = 'parent_me_v1'
const BIND_KEY = 'parent_bind_pending_v1'
const UNAUTHORIZED = { error: { code: 'unauthenticated', message: '請重新登入', details: null } }
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器發生錯誤', details: null } }

const ME: ParentMe = { id: 'p1', display_name: '王媽媽', picture_url: null, phone: null, children: [] }

function storedJson(key: string): unknown {
  const raw = sessionStorage.getItem(key)
  return raw === null ? null : JSON.parse(raw)
}

describe('parentAuth store', () => {
  let mock: MockAdapter
  let refreshMock: MockAdapter

  beforeEach(() => {
    setActivePinia(createPinia())
    mock = createApiMock(parentHttp)
    refreshMock = createApiMock(parentRefreshHttp)
    setUnauthenticatedHandler(() => undefined)
  })

  afterEach(() => {
    mock.restore()
    refreshMock.restore()
  })

  /** 讓 /parent/me 回 401 且 refresh 也 401（沒有任何有效 cookie） */
  function mockUnauthenticated(): void {
    mock.onGet('/parent/me').reply(401, UNAUTHORIZED)
    refreshMock.onPost('/parent/auth/refresh').reply(401, UNAUTHORIZED)
  }

  it('parentAuth ensureSession hydrates from me', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    const store = useParentAuthStore()
    expect(store.isAuthed).toBe(false)
    expect(store.parent).toBeNull()

    const ok = await store.ensureSession()

    expect(ok).toBe(true)
    expect(store.isAuthed).toBe(true)
    expect(store.parent).toEqual(ME)
    expect(store.displayName).toBe('王媽媽')
    expect((storedJson(ME_KEY) as { id: string }).id).toBe('p1')
  })

  it('parentAuth ensureSession dedupes concurrent probes', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    const store = useParentAuthStore()

    const [first, second] = await Promise.all([store.ensureSession(), store.ensureSession()])

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(mock.history.get.filter((r) => r.url === '/parent/me')).toHaveLength(1)
    expect(store.isAuthed).toBe(true)
  })

  it('parentAuth ensureSession skips the probe when already authed', async () => {
    const store = useParentAuthStore()
    store.setParent(ME)

    const ok = await store.ensureSession()

    expect(ok).toBe(true)
    expect(mock.history.get).toHaveLength(0)
  })

  it('parentAuth ensureSession false on 401', async () => {
    mockUnauthenticated()
    const store = useParentAuthStore()

    const ok = await store.ensureSession()

    expect(ok).toBe(false)
    expect(store.isAuthed).toBe(false)
    expect(store.parent).toBeNull()
    expect(sessionStorage.getItem(ME_KEY)).toBeNull()
    // 有打過 me 一次，refresh 也試過一次
    expect(mock.history.get.filter((r) => r.url === '/parent/me')).toHaveLength(1)
    expect(refreshMock.history.post).toHaveLength(1)
  })

  it('parentAuth ensureSession false on server error', async () => {
    mock.onGet('/parent/me').reply(500, SERVER_ERROR)
    const store = useParentAuthStore()

    const ok = await store.ensureSession()

    expect(ok).toBe(false)
    expect(store.isAuthed).toBe(false)
    expect(refreshMock.history.post).toHaveLength(0)
  })

  it('parentAuth bind pending lifecycle', () => {
    const store = useParentAuthStore()
    expect(store.bindPending).toBeNull()

    store.markBindPending('王媽媽')

    expect(store.bindPending).toEqual({ nameHint: '王媽媽' })
    expect(storedJson(BIND_KEY)).toEqual({ nameHint: '王媽媽' })
    expect(store.isAuthed).toBe(false)

    store.setParent(ME)

    expect(store.bindPending).toBeNull()
    expect(sessionStorage.getItem(BIND_KEY)).toBeNull()
    expect(store.isAuthed).toBe(true)
  })

  it('parentAuth markBindPending accepts a null name hint', () => {
    const store = useParentAuthStore()

    store.markBindPending(null)

    expect(store.bindPending).toEqual({ nameHint: null })
    expect(storedJson(BIND_KEY)).toEqual({ nameHint: null })
  })

  it('parentAuth clearBindPending only drops the bind flag', () => {
    const store = useParentAuthStore()
    store.markBindPending('王媽媽')

    store.clearBindPending()

    expect(store.bindPending).toBeNull()
    expect(sessionStorage.getItem(BIND_KEY)).toBeNull()
  })

  it('parentAuth logout clears even if api fails', async () => {
    mock.onPost('/parent/auth/logout').reply(500, SERVER_ERROR)
    const store = useParentAuthStore()
    store.setParent(ME)
    expect(sessionStorage.getItem(ME_KEY)).not.toBeNull()

    await store.logout()

    expect(store.isAuthed).toBe(false)
    expect(store.parent).toBeNull()
    expect(sessionStorage.getItem(ME_KEY)).toBeNull()
    expect(mock.history.post.filter((r) => r.url === '/parent/auth/logout')).toHaveLength(1)
  })

  it('parentAuth logout calls the api then clears everything', async () => {
    mock.onPost('/parent/auth/logout').reply(200, { message: 'ok' })
    const store = useParentAuthStore()
    store.setParent(ME)
    store.markBindPending('王媽媽')

    await store.logout()

    expect(store.isAuthed).toBe(false)
    expect(store.bindPending).toBeNull()
    expect(sessionStorage.getItem(ME_KEY)).toBeNull()
    expect(sessionStorage.getItem(BIND_KEY)).toBeNull()
    expect(mock.history.post).toHaveLength(1)
  })

  it('parentAuth ensureSession caches failure until reset', async () => {
    mockUnauthenticated()
    const store = useParentAuthStore()
    const meRequests = () => mock.history.get.filter((r) => r.url === '/parent/me').length

    expect(await store.ensureSession()).toBe(false)
    expect(await store.ensureSession()).toBe(false)
    expect(meRequests()).toBe(1)

    store.clear()
    expect(await store.ensureSession()).toBe(false)
    expect(meRequests()).toBe(2)

    store.markBindPending('王媽媽')
    expect(await store.ensureSession()).toBe(false)
    expect(meRequests()).toBe(3)
    // 探測失敗不會清掉綁定待辦（瀏覽器仍持有 parent_bind cookie）
    expect(store.bindPending).toEqual({ nameHint: '王媽媽' })

    mock.reset()
    mock.onGet('/parent/me').reply(200, ME)
    store.setParent(ME)
    store.clear()
    expect(await store.ensureSession()).toBe(true)
    expect(mock.history.get.filter((r) => r.url === '/parent/me')).toHaveLength(1)
  })

  it('parentAuth ensureSession keeps a parent set while the probe was failing', async () => {
    let release!: (value: [number, unknown]) => void
    let reached!: () => void
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve
    })
    mock.onGet('/parent/me').replyOnce(() => {
      reached()
      return new Promise<[number, unknown]>((resolve) => {
        release = resolve
      })
    })
    const store = useParentAuthStore()

    const probe = store.ensureSession()
    await reachedPromise
    // 探測進行中登入成功（例如 LoginView 的 liff-login 回應）
    store.setParent(ME)
    release([500, SERVER_ERROR])

    expect(await probe).toBe(true)
    expect(store.isAuthed).toBe(true)
    expect(store.parent).toEqual(ME)
    // 之後的呼叫直接以已登入回應，不再探測
    expect(await store.ensureSession()).toBe(true)
    expect(mock.history.get.filter((r) => r.url === '/parent/me')).toHaveLength(1)
  })

  it('parentAuth restores parent and bind flag from sessionStorage', () => {
    sessionStorage.setItem(ME_KEY, JSON.stringify(ME))
    sessionStorage.setItem(BIND_KEY, JSON.stringify({ nameHint: '王媽媽' }))

    const store = useParentAuthStore()

    expect(store.isAuthed).toBe(true)
    expect(store.parent).toEqual(ME)
    expect(store.displayName).toBe('王媽媽')
    expect(store.bindPending).toEqual({ nameHint: '王媽媽' })
  })

  it('parentAuth ignores malformed sessionStorage values', () => {
    sessionStorage.setItem(ME_KEY, '{not json')
    sessionStorage.setItem(BIND_KEY, '"just a string"')

    const store = useParentAuthStore()

    expect(store.isAuthed).toBe(false)
    expect(store.parent).toBeNull()
    expect(store.bindPending).toBeNull()

    setActivePinia(createPinia())
    sessionStorage.setItem(ME_KEY, JSON.stringify({ display_name: '沒有 id' }))
    sessionStorage.setItem(BIND_KEY, JSON.stringify({ nameHint: 42 }))
    const again = useParentAuthStore()

    expect(again.isAuthed).toBe(false)
    expect(again.bindPending).toBeNull()
  })

  it('parentAuth displayName falls back to empty string', () => {
    const store = useParentAuthStore()
    expect(store.displayName).toBe('')

    store.setParent({ ...ME, display_name: null })
    expect(store.displayName).toBe('')

    store.setParent(ME)
    expect(store.displayName).toBe('王媽媽')
  })

  it('parentAuth clear removes both storage keys', () => {
    const store = useParentAuthStore()
    store.setParent(ME)
    store.markBindPending('王媽媽')
    expect(sessionStorage.getItem(ME_KEY)).not.toBeNull()
    expect(sessionStorage.getItem(BIND_KEY)).not.toBeNull()

    store.clear()

    expect(store.parent).toBeNull()
    expect(store.bindPending).toBeNull()
    expect(store.isAuthed).toBe(false)
    expect(sessionStorage.getItem(ME_KEY)).toBeNull()
    expect(sessionStorage.getItem(BIND_KEY)).toBeNull()
  })

  it('parentAuth still works when sessionStorage throws', async () => {
    const broken = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
      removeItem: () => {
        throw new Error('storage disabled')
      },
    }
    vi.stubGlobal('sessionStorage', broken)
    mock.onGet('/parent/me').reply(200, ME)
    mock.onPost('/parent/auth/logout').reply(200, { message: 'ok' })

    const store = useParentAuthStore()
    expect(store.isAuthed).toBe(false)
    expect(store.bindPending).toBeNull()

    expect(await store.ensureSession()).toBe(true)
    expect(store.parent).toEqual(ME)

    store.markBindPending('王媽媽')
    expect(store.bindPending).toEqual({ nameHint: '王媽媽' })

    store.clearBindPending()
    expect(store.bindPending).toBeNull()

    await store.logout()
    expect(store.isAuthed).toBe(false)
  })
})
