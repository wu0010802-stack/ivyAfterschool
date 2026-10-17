import { createTestingPinia } from '@pinia/testing'
import { flushPromises, mount } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { ElPagination } from 'element-plus'
import zhTw from 'element-plus/es/locale/lang/zh-tw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { h, type Component } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type RouteRecordRaw } from 'vue-router'
import type { StaffMe } from '@/api/auth'
import { adminHttp } from '@/api/http'
import { routes as appRoutes } from '@/router/routes'
import { useAdminWsStore } from '@/stores/adminWs'
import { useNotificationsStore } from '@/stores/notifications'
import { createApiMock, mountWithApp } from '@/test/helpers'
import App from './App.vue'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'

// 預設把 AdminLayout 換成只渲染 default slot 的 stub；layoutMode.real 為 true 時改用真正的 AdminLayout（驗證卸載行為）
const layoutMode = vi.hoisted(() => ({ real: false }))

vi.mock('@/layouts/AdminLayout.vue', async (importOriginal) => {
  const actual = await importOriginal<{ default: Component }>()
  const { defineComponent, h: render } = await import('vue')
  return {
    default: defineComponent({
      name: 'AdminLayoutProbe',
      setup(_props, { slots }) {
        return () =>
          layoutMode.real
            ? render(actual.default, null, slots)
            : render('div', { 'data-test': 'admin-layout' }, slots.default?.())
      },
    }),
  }
})

// 不載入真實 view：routes.ts 的每個 loader 都換成同一個 stub 元件
vi.mock('@/router/viewLoaders', async () => {
  const { h: render } = await import('vue')
  const ViewStub = { name: 'ViewStub', render: () => render('div', { 'data-test': 'view-stub' }, '頁面內容') }
  return { VIEW_LOADERS: new Proxy({}, { get: () => () => Promise.resolve(ViewStub) }) }
})

const sockets = FakeWebSocket.instances

const USER: StaffMe = {
  id: 'u1',
  username: 'clerk01',
  display_name: '林行政',
  role: { id: 'r-clerk', code: 'clerk', name: '行政' },
  permissions: ['students:read', 'pickup:read'],
  must_change_password: false,
}

const page = (text: string): Component => ({ render: () => h('div', { 'data-test': 'page' }, text) })

const ROUTES: RouteRecordRaw[] = [
  { path: '/', component: page('首頁'), meta: { title: '首頁' } },
  { path: '/login', component: page('LOGIN'), meta: { title: '登入', layout: 'blank' } },
  { path: '/students', component: page('/students 頁面內容'), meta: { title: '學生工作台' } },
  { path: '/reports', component: page('/reports 頁面內容'), meta: { title: '報表', layout: 'admin' } },
]

let mock: MockAdapter

describe('App shell', () => {
  beforeEach(() => {
    layoutMode.real = false
    sockets.length = 0
    installFakeWebSocket()
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/notifications').reply(200, { items: [], total: 0, unread_count: 0 })
  })

  afterEach(() => {
    useAdminWsStore().stop()
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('App shell renders blank layout for login', async () => {
    const { wrapper } = await mountWithApp(App, { routes: ROUTES, initialRoute: '/login' })

    expect(wrapper.text()).toContain('LOGIN')
    expect(wrapper.find('[data-test=admin-sidebar]').exists()).toBe(false)
    expect(wrapper.find('[data-test=admin-layout]').exists()).toBe(false)
  })

  it('App shell wraps admin routes with AdminLayout', async () => {
    const { wrapper, router } = await mountWithApp(App, { routes: ROUTES, initialRoute: '/students' })

    const layout = wrapper.find('[data-test=admin-layout]')
    expect(layout.exists()).toBe(true)
    expect(layout.text()).toContain('/students 頁面內容')

    // 明確指定 layout: 'admin' 與沒有 layout 的路由一樣
    await router.push('/reports')
    await flushPromises()
    expect(wrapper.find('[data-test=admin-layout]').text()).toContain('/reports 頁面內容')
  })

  it('App shell keeps a single router view inside the admin layout', async () => {
    const { wrapper } = await mountWithApp(App, { routes: ROUTES, initialRoute: '/students' })

    expect(wrapper.findAll('[data-test=page]')).toHaveLength(1)
    expect(wrapper.findAllComponents(RouterView)).toHaveLength(1)
  })

  it('App shell applies zh-tw locale', async () => {
    const routes: RouteRecordRaw[] = [
      { path: '/students', component: { render: () => h(ElPagination, { layout: 'total', total: 5 }) }, meta: { title: '學生' } },
    ]

    const { wrapper } = await mountWithApp(App, { routes, initialRoute: '/students' })

    // 字串取自 locale 物件，不寫死
    expect(zhTw.el.pagination.total).toContain('{total}')
    expect(wrapper.text()).toContain(zhTw.el.pagination.total.replace('{total}', '5'))
    expect(wrapper.text()).not.toContain('共 5 条')
    expect(wrapper.text()).not.toContain('Total 5')
  })

  it('App shell shows a full page loading until the router is ready', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: ROUTES })
    // 第一次導航卡在 guard：此時 route 還是起始位置（meta 是空的），不能把它當成一般頁而閃現側欄
    let release: () => void = () => undefined
    router.beforeEach(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const wrapper = mount(App, { global: { plugins: [router, createTestingPinia({ createSpy: vi.fn })] } })
    await flushPromises()

    expect(wrapper.find('[data-test=app-loading]').exists()).toBe(true)
    expect(wrapper.find('[data-test=app-loading]').attributes('role')).toBe('status')
    expect(wrapper.find('[data-test=admin-layout]').exists()).toBe(false)
    expect(wrapper.find('[data-test=page]').exists()).toBe(false)

    release()
    await router.isReady()
    await flushPromises()

    expect(wrapper.find('[data-test=app-loading]').exists()).toBe(false)
    expect(wrapper.find('[data-test=admin-layout]').text()).toContain('首頁')
  })

  it('App shell leaves loading when the first navigation fails', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: ROUTES })
    router.beforeEach(() => {
      throw new Error('boom')
    })
    router.onError(() => undefined)
    const wrapper = mount(App, { global: { plugins: [router, createTestingPinia({ createSpy: vi.fn })] } })
    await flushPromises()

    expect(wrapper.find('[data-test=app-loading]').exists()).toBe(false)
  })

  it('App shell renders no sidebar for every blank layout route of the real route table', async () => {
    const blankPaths = appRoutes.filter((r) => r.meta?.layout === 'blank' && !r.path.includes(':')).map((r) => r.path)
    expect(blankPaths).toEqual(expect.arrayContaining(['/login', '/change-password']))

    for (const path of blankPaths) {
      const { wrapper } = await mountWithApp(App, { routes: appRoutes, initialRoute: path })
      expect(wrapper.find('[data-test=admin-layout]').exists(), path).toBe(false)
      expect(wrapper.find('[data-test=view-stub]').exists(), path).toBe(true)
      wrapper.unmount()
    }

    // 未知路徑落在 not-found（blank），有權限不足的 /forbidden 仍在後台外框內
    const notFound = await mountWithApp(App, { routes: appRoutes, initialRoute: '/no-such-page' })
    expect(notFound.wrapper.find('[data-test=admin-layout]').exists()).toBe(false)
    notFound.wrapper.unmount()
    const forbidden = await mountWithApp(App, { routes: appRoutes, initialRoute: '/forbidden' })
    expect(forbidden.wrapper.find('[data-test=admin-layout]').exists()).toBe(true)
  })

  it('App shell unmounts AdminLayout and stops ws when leaving for a blank layout route', async () => {
    layoutMode.real = true
    mock.reset()
    mock.onGet('/admin/notifications').reply(200, {
      items: [
        {
          id: 'n1',
          event: 'leave.created',
          title: '陳小美 請假',
          body: '陳小美 2026-10-05～2026-10-06 病假。',
          payload: {},
          read_at: null,
          created_at: '2026-10-02T08:00:00Z',
          deep_link: '/leaves',
        },
      ],
      total: 1,
      unread_count: 1,
    })
    const { wrapper, router } = await mountWithApp(App, {
      routes: appRoutes,
      initialRoute: '/students',
      piniaInitialState: { auth: { user: USER, status: 'authenticated' } },
    })
    const adminWs = useAdminWsStore()
    const notifications = useNotificationsStore()
    expect(wrapper.find('[data-test=admin-sidebar]').exists()).toBe(true)
    expect(sockets).toHaveLength(1)
    sockets[0]?.open()
    expect(adminWs.status).toBe('open')
    expect(notifications.items.map((n) => n.id)).toEqual(['n1'])

    // 登出：導向 blank layout 的 /login
    await router.push('/login')
    await flushPromises()

    // 真的卸載（不是 v-show 隱藏）：側欄與頂欄不在 DOM、ws 已關閉停止、通知已清空
    expect(wrapper.find('[data-test=admin-sidebar]').exists()).toBe(false)
    expect(wrapper.find('header').exists()).toBe(false)
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.readyState).toBe(3)
    expect(adminWs.status).toBe('idle')
    expect(notifications.items).toEqual([])
    expect(notifications.loaded).toBe(false)

    // 重新登入回到後台：重新掛載，新的 ws 連線與通知載入
    await router.push('/students')
    await flushPromises()
    expect(wrapper.find('[data-test=admin-sidebar]').exists()).toBe(true)
    expect(sockets).toHaveLength(2)
    expect(sockets[1]?.readyState).not.toBe(3)
    expect(notifications.items.map((n) => n.id)).toEqual(['n1'])
  })
})
