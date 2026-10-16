import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'vue'
import { createMemoryHistory, type Router } from 'vue-router'
import { createApiMock } from '@/test/helpers'
import type { ChildSummary, ParentMe } from './api/children'
import { _resetPublicConfigForTests } from './api/config'
import { parentHttp, parentRefreshHttp } from './api/http'
import { listChildLeaves } from './api/leaves'
import { createParentApp } from './main'
import source from './main.ts?raw'
import { useChildrenStore } from './stores/children'
import { useParentAuthStore } from './stores/parentAuth'
import { useParentWsStore } from './stores/parentWs'

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
}

const UNAUTHORIZED = { error: { code: 'unauthenticated', message: '請重新登入', details: null } }
const KID: ChildSummary = {
  id: 's1',
  name: '王小明',
  grade_level: 3,
  class_name: '中年級 A 班',
  school_name: '某某國小',
  photo_url: null,
  status: 'active',
}
const ME: ParentMe = { id: 'p1', display_name: '王媽媽', picture_url: null, phone: null, children: [KID] }

let mock: MockAdapter
let refreshMock: MockAdapter
let mountedApp: App | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  _resetPublicConfigForTests()
  mock = createApiMock(parentHttp)
  refreshMock = createApiMock(parentRefreshHttp)
})

afterEach(() => {
  mountedApp?.unmount()
  mountedApp = null
  host?.remove()
  host = null
  mock.restore()
  refreshMock.restore()
})

/** 從指定路徑開始的 memory history（測試不碰 window.location.hash） */
function historyAt(path: string) {
  const history = createMemoryHistory()
  history.replace(path)
  return history
}

const meRequests = () => mock.history.get.filter((r) => r.url === '/parent/me').length

function noSession(): void {
  mock.onGet('/parent/me').reply(401, UNAUTHORIZED)
  refreshMock.onPost('/parent/auth/refresh').reply(401, UNAUTHORIZED)
}

async function settle(router: Router): Promise<void> {
  await router.isReady()
  await flushPromises()
}

describe('parentMain', () => {
  it('parentMain redirects to login on unauthenticated', async () => {
    mock.onGet('/parent/me').replyOnce(200, ME).onGet('/parent/me').reply(401, UNAUTHORIZED)
    refreshMock.onPost('/parent/auth/refresh').reply(401, UNAUTHORIZED)
    mock.onGet('/parent/children/s1/leaves').reply(401, UNAUTHORIZED)
    const { router, pinia } = createParentApp({ history: historyAt('/login') })
    await settle(router)

    await router.push('/leaves')
    expect(router.currentRoute.value.fullPath).toBe('/leaves')
    const auth = useParentAuthStore(pinia)
    const children = useChildrenStore(pinia)
    expect(auth.isAuthed).toBe(true)
    children.seed([KID])

    // 頁面上的 API 401 且 refresh 也 401 → PARENT-004 呼叫 unauthenticated handler
    await expect(listChildLeaves('s1')).rejects.toMatchObject({ status: 401 })
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/leaves')
    expect(auth.isAuthed).toBe(false)
    expect(children.items.length).toBe(0)
    expect(children.selectedId).toBeNull()
  })

  it('parentMain does not redirect from public route', async () => {
    noSession()
    mock.onGet('/parent/children').reply(401, UNAUTHORIZED)
    const { router } = createParentApp({ history: historyAt('/login') })
    await settle(router)
    expect(router.currentRoute.value.fullPath).toBe('/login')

    await expect(parentHttp.get('/parent/children')).rejects.toMatchObject({ status: 401 })
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('parentMain sends a first visit without session to login with the original path', async () => {
    noSession()
    const { router } = createParentApp({ history: historyAt('/leaves') })
    await settle(router)

    // 第一次導航時 handler 看到的是 START_LOCATION：只清狀態，由守衛導向（不是 redirect=/）
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/leaves')
    expect(meRequests()).toBe(1)
  })

  it('parentMain redirects only once while the login probe also fails', async () => {
    mock.onGet('/parent/me').replyOnce(200, ME).onGet('/parent/me').reply(401, UNAUTHORIZED)
    refreshMock.onPost('/parent/auth/refresh').reply(401, UNAUTHORIZED)
    mock.onGet('/parent/children').reply(401, UNAUTHORIZED)
    const { router } = createParentApp({ history: historyAt('/exams') })
    await settle(router)
    expect(router.currentRoute.value.fullPath).toBe('/exams')
    const afterEach = vi.fn()
    router.afterEach(afterEach)

    await expect(parentHttp.get('/parent/children')).rejects.toMatchObject({ status: 401 })
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/exams')
    // /login 守衛的探測也 401：不再發起第二次導向
    expect(afterEach).toHaveBeenCalledTimes(1)
    expect(meRequests()).toBe(2)
  })

  it('parentMain disconnects the websocket on unauthenticated', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    mock.onGet('/parent/children').reply(401, UNAUTHORIZED)
    refreshMock.onPost('/parent/auth/refresh').reply(401, UNAUTHORIZED)
    const { router, pinia } = createParentApp({ history: historyAt('/login') })
    await settle(router)
    const ws = useParentWsStore(pinia)
    ws.connect()
    expect(ws.enabled).toBe(true)

    await expect(parentHttp.get('/parent/children')).rejects.toMatchObject({ status: 401 })
    await flushPromises()

    expect(ws.enabled).toBe(false)
    expect(ws.status).toBe('idle')
  })

  it('parentMain mounts layout with router view', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    mock.onGet('/parent/config').reply(200, {
      liff_id: '1650000000-abc',
      org_name: '向日葵安親班',
      org_phone: null,
      logo_url: null,
      add_friend_url: null,
      limits: {
        leave_past_days: 30,
        leave_future_days: 60,
        leave_max_attachments: 3,
        leave_max_attachment_mb: 10,
        authorization_max_days_ahead: 14,
        persons_max: 10,
      },
    })
    mock.onGet('/parent/notifications').reply(200, { items: [], total: 0, unread_count: 2 })
    mock.onGet('/parent/notification-preferences').reply(200, { items: [] })
    const { app, router } = createParentApp({ history: historyAt('/notifications/preferences') })
    host = document.createElement('div')
    document.body.appendChild(host)
    mountedApp = app
    app.mount(host)
    await settle(router)

    expect(router.currentRoute.value.fullPath).toBe('/notifications/preferences')
    const nav = host.querySelector('nav')
    expect(nav).not.toBeNull()
    expect(nav!.textContent).toContain('首頁')
    expect(nav!.textContent).toContain('更多')
    // RouterView 渲染了該頁（頂部列標題來自路由 meta）
    expect(host.textContent).toContain('通知設定')
    expect(host.querySelector('.parent-layout')).not.toBeNull()
  })

  it('parentMain keeps bind pending through first bind', async () => {
    noSession()
    const { router, pinia } = createParentApp({ history: historyAt('/login') })
    await settle(router)
    expect(router.currentRoute.value.path).toBe('/login')
    const auth = useParentAuthStore(pinia)

    auth.markBindPending('王媽媽')
    await router.push('/bind')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/bind')
    expect(auth.bindPending?.nameHint).toBe('王媽媽')
  })

  it('parentMain wires styles and stays out of admin code', () => {
    const code = source.replace(/\/\/.*$/gm, '')
    for (const css of ['./styles/m3-tokens.css', './styles/base.css', './styles/icons.css']) {
      expect(code, css).toContain(`import '${css}'`)
    }
    expect(code).not.toMatch(/element-plus/)
    expect(code).not.toMatch(/from '@\/(?:views|components|layouts|stores|api|router|bootstrap)/)
    // vitest 載入時不自動掛載
    expect(code).toMatch(/if \(!import\.meta\.env\.VITEST\) createParentApp\(\)\.app\.mount\('#app'\)/)
  })
})
