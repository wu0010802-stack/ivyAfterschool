import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, type ComponentPublicInstance } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ChildSummary, ParentMe } from '../api/children'
import { _resetPublicConfigForTests } from '../api/config'
import { parentHttp, parentRefreshHttp, setUnauthenticatedHandler } from '../api/http'
import { createParentRouter } from '../router'
import { _resetLiffForTests, type LiffClient } from '../services/liff'
import { useChildrenStore } from '../stores/children'
import { useHomeworkTodayStore } from '../stores/homeworkToday'
import { useNotificationsStore } from '../stores/notifications'
import { useParentAuthStore } from '../stores/parentAuth'
import { useParentWsStore } from '../stores/parentWs'
import { usePickupRequestsStore } from '../stores/pickupRequests'
import { useSnackbarStore } from '../stores/snackbar'
import { useParentLogout } from './useParentLogout'

const LOGOUT_URL = '/parent/auth/logout'
const CONFIG_URL = '/parent/config'
const SELECTED_CHILD_KEY = 'parent_selected_child_v1'
const PARENT_ME_KEY = 'parent_me_v1'
const RELOGIN_MARKER = 'parent_liff_relogin_marker'
const UNAUTHORIZED = { error: { code: 'unauthenticated', message: '請重新登入', details: null } }
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }

const S1: ChildSummary = {
  id: 's1',
  name: '王小明',
  grade_level: 3,
  class_name: '中年級班',
  school_name: '某某國小',
  photo_url: null,
  status: 'active',
}

const ME: ParentMe = { id: 'p1', display_name: '王媽媽', picture_url: null, phone: null, children: [S1] }

type FakeLiff = LiffClient & { logout: ReturnType<typeof vi.fn> }

function fakeLiff(loggedIn: boolean): FakeLiff {
  return {
    isLoggedIn: vi.fn(() => loggedIn),
    isInClient: vi.fn(() => true),
    login: vi.fn(),
    logout: vi.fn(),
    getIDToken: vi.fn(() => 'tok'),
    getDecodedIDToken: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  } as FakeLiff
}

type MockWindow = Window & { __PARENT_LIFF_MOCK__?: LiffClient }

function installLiff(fake: LiffClient | undefined): void {
  if (fake) (window as MockWindow).__PARENT_LIFF_MOCK__ = fake
  else delete (window as MockWindow).__PARENT_LIFF_MOCK__
}

/** 可手動決定何時回應的 reply */
function deferredReply() {
  let resolve!: (value: [number, unknown]) => void
  const promise = new Promise<[number, unknown]>((r) => {
    resolve = r
  })
  return { reply: () => promise, resolve }
}

type ParentLogout = ReturnType<typeof useParentLogout>

let mock: MockAdapter
let refreshMock: MockAdapter
let mounted: MountedApp | null = null
let extraWrapper: VueWrapper<ComponentPublicInstance> | null = null

beforeEach(() => {
  _resetLiffForTests()
  _resetPublicConfigForTests()
  sessionStorage.clear()
  localStorage.removeItem(SELECTED_CHILD_KEY)
  mock = createApiMock(parentHttp)
  refreshMock = createApiMock(parentRefreshHttp)
  setUnauthenticatedHandler(() => undefined)
  installLiff(fakeLiff(false))
})

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted = null
  extraWrapper?.unmount()
  extraWrapper = null
  mock.restore()
  refreshMock.restore()
  installLiff(undefined)
  setUnauthenticatedHandler(() => undefined)
  _resetLiffForTests()
  sessionStorage.clear()
  localStorage.removeItem(SELECTED_CHILD_KEY)
})

/** 在元件 setup 內呼叫 useParentLogout（需要 useRouter 的注入環境），把回傳值放進 holder */
function hostCapturing(holder: { api: ParentLogout | null }) {
  return defineComponent({
    setup() {
      holder.api = useParentLogout()
      return () => null
    },
  })
}

function captured(holder: { api: ParentLogout | null }): ParentLogout {
  if (!holder.api) throw new Error('useParentLogout 沒有被呼叫')
  return holder.api
}

/** 以 mountWithApp（catch-all 路由）掛載，停在 /more，並把家長、小孩、未讀數等狀態設好 */
async function setup(): Promise<{ api: ParentLogout; app: MountedApp }> {
  const holder: { api: ParentLogout | null } = { api: null }
  mounted = await mountWithApp(hostCapturing(holder), { initialRoute: '/more' })
  const { pinia } = mounted
  useParentAuthStore(pinia).setParent(ME)
  useChildrenStore(pinia).seed([S1])
  useNotificationsStore(pinia).unreadCount = 3
  return { api: captured(holder), app: mounted }
}

const logoutPosts = () => mock.history.post.filter((r) => r.url === LOGOUT_URL)

describe('useParentLogout', () => {
  it('useParentLogout clears state and goes to login', async () => {
    mock.onPost(LOGOUT_URL).reply(200)
    const { api, app } = await setup()
    const { pinia, router } = app
    const ws = useParentWsStore(pinia)
    ws.enabled = true
    useSnackbarStore(pinia).show('已取消接送')
    usePickupRequestsStore(pinia).loaded = true
    useHomeworkTodayStore(pinia).errorByChild = { s1: '作業進度載入失敗' }
    sessionStorage.setItem(RELOGIN_MARKER, '1')
    expect(localStorage.getItem(SELECTED_CHILD_KEY)).toBe('s1')
    expect(useParentAuthStore(pinia).isAuthed).toBe(true)

    await api.logout()
    await flushPromises()

    expect(logoutPosts()).toHaveLength(1)
    expect(useParentAuthStore(pinia).isAuthed).toBe(false)
    expect(sessionStorage.getItem(PARENT_ME_KEY)).toBeNull()
    expect(useChildrenStore(pinia).items.length).toBe(0)
    expect(useChildrenStore(pinia).selectedId).toBeNull()
    expect(localStorage.getItem(SELECTED_CHILD_KEY)).toBeNull()
    expect(useNotificationsStore(pinia).unreadCount).toBe(0)
    expect(ws.enabled).toBe(false)
    expect(useSnackbarStore(pinia).items).toEqual([])
    expect(usePickupRequestsStore(pinia).loaded).toBe(false)
    expect(useHomeworkTodayStore(pinia).errorByChild).toEqual({})
    expect(sessionStorage.getItem(RELOGIN_MARKER)).toBeNull()
    expect(router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
    expect(api.loggingOut.value).toBe(false)
  })

  it('useParentLogout continues when api fails', async () => {
    mock.onPost(LOGOUT_URL).reply(500, SERVER_ERROR)
    const { api, app } = await setup()

    await api.logout()
    await flushPromises()

    expect(logoutPosts()).toHaveLength(1)
    expect(useParentAuthStore(app.pinia).isAuthed).toBe(false)
    expect(useChildrenStore(app.pinia).items.length).toBe(0)
    expect(app.router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
  })

  it('useParentLogout ends LINE session', async () => {
    const fake = fakeLiff(true)
    installLiff(fake)
    mock.onPost(LOGOUT_URL).reply(200)
    const { api, app } = await setup()

    await api.logout()
    await flushPromises()

    expect(fake.logout).toHaveBeenCalledTimes(1)
    expect(app.router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
  })

  it('useParentLogout ends LINE session skips logout when not logged in to LINE', async () => {
    const fake = fakeLiff(false)
    installLiff(fake)
    mock.onPost(LOGOUT_URL).reply(200)
    const { api, app } = await setup()

    await api.logout()
    await flushPromises()

    expect(fake.logout).not.toHaveBeenCalled()
    expect(app.router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
  })

  it('useParentLogout ends LINE session even when initLiff rejects', async () => {
    // 沒有替身：initLiff 走真實流程，公開設定 500 → initLiff reject
    installLiff(undefined)
    mock.onGet(CONFIG_URL).reply(500, SERVER_ERROR)
    mock.onPost(LOGOUT_URL).reply(200)
    const { api, app } = await setup()

    await api.logout()
    await flushPromises()

    expect(mock.history.get.filter((r) => r.url === CONFIG_URL)).toHaveLength(1)
    expect(useParentAuthStore(app.pinia).isAuthed).toBe(false)
    expect(app.router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
    expect(api.loggingOut.value).toBe(false)
  })

  it('useParentLogout ignores concurrent call', async () => {
    const pending = deferredReply()
    mock.onPost(LOGOUT_URL).reply(pending.reply)
    const { api, app } = await setup()

    const first = api.logout()
    expect(api.loggingOut.value).toBe(true)
    const second = api.logout()
    await flushPromises()

    expect(logoutPosts()).toHaveLength(1)
    expect(app.router.currentRoute.value.path).toBe('/more')
    // 第二次呼叫直接結束，不等第一次
    await expect(second).resolves.toBeUndefined()
    expect(api.loggingOut.value).toBe(true)

    pending.resolve([200, null])
    await first
    await flushPromises()

    expect(logoutPosts()).toHaveLength(1)
    expect(app.router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
    expect(api.loggingOut.value).toBe(false)
  })

  it(
    'useParentLogout keeps logged_out flag through the login guard',
    async () => {
      const pinia = createPinia()
      setActivePinia(pinia)
      const router = createParentRouter(createMemoryHistory())
      const auth = useParentAuthStore()
      const children = useChildrenStore()
      const ws = useParentWsStore()
      // 比照 PARENT-013 規格的 unauthenticated handler：清狀態，目前路由非 public 就導回登入並帶 redirect
      setUnauthenticatedHandler(() => {
        auth.clear()
        children.clear()
        ws.disconnect()
        const current = router.currentRoute.value
        if (!current.meta.public) void router.replace({ path: '/login', query: { redirect: current.fullPath } })
      })
      auth.setParent(ME)
      children.seed([S1])
      await router.push('/more')
      expect(router.currentRoute.value.path).toBe('/more')

      // 之後 session 一律失效：/parent/me 401、refresh 401
      mock.onGet('/parent/me').reply(401, UNAUTHORIZED)
      refreshMock.onPost('/parent/auth/refresh').reply(401, UNAUTHORIZED)
      mock.onPost(LOGOUT_URL).reply(200)
      const meBefore = mock.history.get.filter((r) => r.url === '/parent/me').length

      const holder: { api: ParentLogout | null } = { api: null }
      extraWrapper = mount(hostCapturing(holder), { global: { plugins: [router, pinia] } })

      await captured(holder).logout()
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
      expect(mock.history.get.filter((r) => r.url === '/parent/me').length - meBefore).toBe(0)
      expect(refreshMock.history.post).toHaveLength(0)
      expect(auth.isAuthed).toBe(false)
    },
    // 會載入真實的 MoreView / LoginView，負載高時超過 vitest 預設 5 秒
    30_000,
  )
})
