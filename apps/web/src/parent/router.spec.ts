import type MockAdapter from 'axios-mock-adapter'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, type RouteRecordRaw, type Router } from 'vue-router'
import { createApiMock } from '@/test/helpers'
import type { ParentMe } from './api/children'
import { parentHttp, parentRefreshHttp, setUnauthenticatedHandler } from './api/http'
import { createParentRouter, installParentGuards, parentRoutes } from './router'
import { useParentAuthStore } from './stores/parentAuth'

const UNAUTHORIZED = { error: { code: 'unauthenticated', message: '請重新登入', details: null } }
const ME: ParentMe = { id: 'p1', display_name: '王媽媽', picture_url: null, phone: null, children: [] }

// 導頁測試不載入任何真實 view：每條有 component 的路由都換成同一個 stub
const RouteStub = defineComponent({ name: 'RouteStub', render: () => h('div', 'stub') })

function stubbedRoutes(): RouteRecordRaw[] {
  return parentRoutes.map((record) =>
    'component' in record && record.component ? ({ ...record, component: RouteStub } as RouteRecordRaw) : record,
  )
}

function makeRouter(): Router {
  const router = createRouter({ history: createMemoryHistory(), routes: stubbedRoutes() })
  installParentGuards(router)
  return router
}

type LazyLoader = () => Promise<{ default: unknown }>

describe('parentRouter', () => {
  let mock: MockAdapter
  let refreshMock: MockAdapter

  beforeEach(() => {
    setActivePinia(createPinia())
    mock = createApiMock(parentHttp)
    refreshMock = createApiMock(parentRefreshHttp)
    setUnauthenticatedHandler(() => undefined)
    document.title = ''
  })

  afterEach(() => {
    mock.restore()
    refreshMock.restore()
  })

  /** 沒有任何有效 cookie：/parent/me 401 且 refresh 也 401 */
  function mockUnauthenticated(): void {
    mock.onGet('/parent/me').reply(401, UNAUTHORIZED)
    refreshMock.onPost('/parent/auth/refresh').reply(401, UNAUTHORIZED)
  }

  function meRequests(): number {
    return mock.history.get.filter((r) => r.url === '/parent/me').length
  }

  it('parentRouter redirects anonymous to login with redirect', async () => {
    mockUnauthenticated()
    const router = makeRouter()

    await router.push('/leaves')

    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/leaves')
    expect(router.currentRoute.value.query.redirect).toBe('/leaves')
    expect(meRequests()).toBe(1)
  })

  it('parentRouter allows authed user', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    const router = makeRouter()

    await router.push('/pickup')

    expect(router.currentRoute.value.path).toBe('/pickup')
    expect(document.title).toBe('接送｜家長端')
    expect(useParentAuthStore().parent?.id).toBe('p1')
  })

  it('parentRouter bind requires bind pending or session', async () => {
    mockUnauthenticated()
    const router = makeRouter()
    const auth = useParentAuthStore()

    await router.push('/bind')
    expect(router.currentRoute.value.path).toBe('/login')
    // 未帶 redirect：綁定頁不是登入後要回去的地方
    expect(router.currentRoute.value.query.redirect).toBeUndefined()

    auth.markBindPending('王媽媽')
    await router.push('/bind')

    expect(router.currentRoute.value.path).toBe('/bind')
    expect(document.title).toBe('綁定小孩｜家長端')
  })

  it('parentRouter bind allowed for authed parent', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    const router = makeRouter()

    await router.push('/bind')

    expect(router.currentRoute.value.path).toBe('/bind')
    expect(meRequests()).toBe(1)
  })

  it('parentRouter login redirects authed user safely', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    const router = makeRouter()

    await router.push('/login?redirect=/exams')
    expect(router.currentRoute.value.path).toBe('/exams')

    await router.push('/login?redirect=//evil.com')
    expect(router.currentRoute.value.path).toBe('/')

    // 登入 / 綁定頁本身不是合法的導回目標（避免迴圈）：已登入家長會被帶到 /bind 加綁頁，必須回首頁
    await router.push('/login?redirect=/bind')
    expect(router.currentRoute.value.path).toBe('/')

    await router.push('/login')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('parentRouter login stays for anonymous', async () => {
    mockUnauthenticated()
    const router = makeRouter()

    await router.push('/login?redirect=/exams')

    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/exams')
    expect(document.title).toBe('登入｜家長端')
  })

  it('parentRouter probes me only once', async () => {
    mockUnauthenticated()
    const router = makeRouter()

    await router.push('/')
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/')

    await router.push('/homework')
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/homework')

    expect(meRequests()).toBe(1)
    expect(refreshMock.history.post).toHaveLength(1)
  })

  it('parentRouter lazy routes resolve placeholder views', async () => {
    const loaders = parentRoutes.filter((r) => 'component' in r && typeof r.component === 'function')
    expect(loaders).toHaveLength(13)

    const modules = await Promise.all(loaders.map((r) => (r.component as LazyLoader)()))

    for (const mod of modules) {
      const view = mod.default as { setup?: unknown; render?: unknown } | null
      expect(view).not.toBeNull()
      expect(typeof view).toBe('object')
      // SFC 的 default export 是元件物件：至少有 setup 或 render
      expect(typeof view?.setup === 'function' || typeof view?.render === 'function').toBe(true)
    }
  })

  it('parentRouter bind pending skips session probe', async () => {
    mockUnauthenticated()
    const router = makeRouter()
    const auth = useParentAuthStore()
    auth.markBindPending('王媽媽')

    await router.push('/bind')

    expect(router.currentRoute.value.path).toBe('/bind')
    expect(meRequests()).toBe(0)
    expect(auth.bindPending?.nameHint).toBe('王媽媽')
  })

  it('parentRouter route table carries layout meta', () => {
    const byPath = new Map(parentRoutes.map((r) => [r.path, r]))
    const expected: Record<string, Record<string, unknown>> = {
      '/login': { title: '登入', public: true, hideTabBar: true },
      '/bind': { title: '綁定小孩', bindable: true, hideTabBar: true },
      '/': { title: '首頁', tab: 'home' },
      '/homework': { title: '今日作業', tab: 'homework' },
      '/pickup': { title: '接送', tab: 'pickup' },
      '/pickup/proxy': { title: '代理接送', tab: 'pickup', showBack: true },
      '/exams': { title: '成績', tab: 'exams' },
      '/exams/:examId': { title: '成績明細', tab: 'exams', showBack: true },
      '/more': { title: '更多', tab: 'more' },
      '/attendance': { title: '出勤紀錄', tab: 'more', showBack: true },
      '/leaves': { title: '請假', tab: 'more', showBack: true },
      '/notifications': { title: '通知', tab: 'more', showBack: true },
      '/notifications/preferences': { title: '通知設定', tab: 'more', showBack: true },
    }
    for (const [path, meta] of Object.entries(expected)) {
      expect(byPath.get(path)?.meta, path).toEqual(meta)
    }
    const catchAll = byPath.get('/:pathMatch(.*)*')
    expect(catchAll && 'redirect' in catchAll ? catchAll.redirect : null).toBe('/')
    expect(parentRoutes.at(-1)?.path).toBe('/:pathMatch(.*)*')
  })

  it('parentRouter unknown path redirects home', async () => {
    mock.onGet('/parent/me').reply(200, ME)
    const router = makeRouter()

    await router.push('/does-not-exist')

    expect(router.currentRoute.value.path).toBe('/')
    expect(document.title).toBe('首頁｜家長端')
  })

  it('parentRouter createParentRouter uses hash history with guards', async () => {
    mockUnauthenticated()
    const router = createParentRouter()

    expect(router.options.history.base.endsWith('#')).toBe(true)

    await router.push('/leaves')

    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/leaves')
  })
})
