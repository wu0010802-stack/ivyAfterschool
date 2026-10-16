import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ParentMe } from '../api/children'
import { _resetPublicConfigForTests, type PublicConfig } from '../api/config'
import { parentHttp } from '../api/http'
import { parentRoutes } from '../router'
import { useNotificationsStore } from '../stores/notifications'
import { useParentAuthStore } from '../stores/parentAuth'
import { useParentWsStore } from '../stores/parentWs'
import ParentLayout from './ParentLayout.vue'
import source from './ParentLayout.vue?raw'

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

const CONFIG_URL = '/parent/config'
const NOTI_URL = '/parent/notifications'
const OFFLINE_TEXT = '目前離線，恢復網路後會自動更新'
const LIMITS = {
  leave_past_days: 30,
  leave_future_days: 60,
  leave_max_attachments: 3,
  leave_max_attachment_mb: 10,
  authorization_max_days_ahead: 14,
  persons_max: 10,
}
const ME: ParentMe = { id: 'p1', display_name: '王媽媽', picture_url: null, phone: null, children: [] }

function config(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    liff_id: '1650000000-abc',
    org_name: '向日葵安親班',
    org_phone: null,
    logo_url: null,
    add_friend_url: null,
    limits: LIMITS,
    ...overrides,
  }
}

// 每條路由換成帶頁名的 stub（meta 沿用真實路由表，不載入任何真實 view）
function stubRoutes(): RouteRecordRaw[] {
  return parentRoutes.map((record) =>
    'component' in record && record.component
      ? ({
          ...record,
          component: defineComponent({ render: () => h('div', { class: 'route-stub' }, `頁面 ${record.path}`) }),
        } as RouteRecordRaw)
      : record,
  )
}

type Wrapper = MountedApp['wrapper']

describe('ParentLayout', () => {
  let mock: MockAdapter
  let mounted: MountedApp | null = null

  beforeEach(() => {
    _resetPublicConfigForTests()
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    mock = createApiMock(parentHttp)
    window.scrollTo(0, 0)
  })

  afterEach(() => {
    if (mounted) useParentWsStore(mounted.pinia).disconnect()
    mounted?.wrapper.unmount()
    mounted = null
    mock.restore()
    Reflect.deleteProperty(navigator, 'onLine')
    window.history.replaceState(null, '')
  })

  function setOffline(): void {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
  }

  async function mountLayout(
    initialRoute: string,
    opts: { authed?: boolean; state?: Record<string, unknown>; config?: PublicConfig | 'error' | 'pending' } = {},
  ): Promise<MountedApp> {
    const c = opts.config ?? config()
    if (c === 'error') mock.onGet(CONFIG_URL).reply(500, { error: { code: 'internal_error', message: 'x', details: null } })
    else if (c === 'pending') mock.onGet(CONFIG_URL).reply(() => new Promise<[number, unknown]>(() => undefined))
    else mock.onGet(CONFIG_URL).reply(200, c)
    mounted = await mountWithApp(ParentLayout, {
      routes: stubRoutes(),
      initialRoute,
      piniaInitialState: {
        parentAuth: { parent: opts.authed ? ME : null, bindPending: null },
        ...opts.state,
      },
    })
    await flushPromises()
    return mounted
  }

  const header = (w: Wrapper) => w.find('.app-header')
  const nav = (w: Wrapper) => w.findAll('nav')
  const tab = (w: Wrapper, label: string) => {
    const found = w.findAll('nav button').find((b) => b.get('.m3-nav-tab__label').text() === label)
    if (!found) throw new Error(`找不到分頁 ${label}`)
    return found
  }
  const leading = (w: Wrapper) => w.get('.m3-top-app-bar__leading')
  const notiGets = () => mock.history.get.filter((r) => r.url === NOTI_URL)

  it('ParentLayout hides chrome on public route', async () => {
    setOffline()
    const { wrapper } = await mountLayout('/login')

    expect(nav(wrapper)).toHaveLength(0)
    expect(wrapper.find('.m3-top-app-bar').exists()).toBe(false)
    expect(header(wrapper).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('目前離線')
    expect(wrapper.text()).toContain('頁面 /login')
  })

  it('ParentLayout hides chrome on hideTabBar route', async () => {
    setOffline()
    const { wrapper } = await mountLayout('/bind')

    expect(wrapper.find('.m3-top-app-bar').exists()).toBe(false)
    expect(nav(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain(OFFLINE_TEXT)
    // 一般文流放在頁面最上方（main 內、RouterView 之前），不放進 sticky 頂部區塊
    const main = wrapper.get('main')
    expect(main.element.firstElementChild?.classList.contains('conn-banner')).toBe(true)
    expect(header(wrapper).exists()).toBe(false)
  })

  it('ParentLayout puts banner under the top bar', async () => {
    setOffline()
    const { wrapper } = await mountLayout('/pickup')

    const block = header(wrapper)
    expect(block.find('.m3-top-app-bar').exists()).toBe(true)
    expect(block.text()).toContain(OFFLINE_TEXT)
    expect(wrapper.get('main').text()).not.toContain(OFFLINE_TEXT)
  })

  it('ParentLayout shows title and active tab', async () => {
    const { wrapper } = await mountLayout('/pickup')

    expect(wrapper.get('.m3-top-app-bar').text()).toContain('接送')
    expect(wrapper.get('.m3-top-app-bar h1').text()).toBe('接送')
    expect(tab(wrapper, '接送').attributes('aria-current')).toBe('page')
    expect(wrapper.findAll('nav button[aria-current="page"]')).toHaveLength(1)
    expect(wrapper.findAll('nav button').map((b) => b.get('.m3-nav-tab__label').text())).toEqual([
      '首頁',
      '作業',
      '接送',
      '成績',
      '更多',
    ])
    expect(wrapper.text()).toContain('頁面 /pickup')
  })

  it('ParentLayout deep page keeps parent tab', async () => {
    const { wrapper } = await mountLayout('/attendance')

    expect(wrapper.find('.m3-top-app-bar [aria-label="返回"]').exists()).toBe(true)
    expect(wrapper.find('.m3-top-app-bar img').exists()).toBe(false)
    expect(wrapper.get('.m3-top-app-bar h1').text()).toBe('出勤紀錄')
    expect(tab(wrapper, '更多').attributes('aria-current')).toBe('page')
  })

  it('ParentLayout back uses history state', async () => {
    const { wrapper, router } = await mountLayout('/more')
    await router.push('/leaves')
    await flushPromises()
    window.history.replaceState({ back: '/more' }, '')

    await wrapper.get('[aria-label="返回"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/more')
  })

  it('ParentLayout back falls back to home', async () => {
    const { wrapper, router } = await mountLayout('/leaves')
    window.history.pushState({}, '')
    window.history.pushState({}, '')
    expect(window.history.length).toBeGreaterThan(1)
    window.history.replaceState({ back: null }, '')

    await wrapper.get('[aria-label="返回"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('ParentLayout leading shows logo', async () => {
    const { wrapper } = await mountLayout('/', { config: config({ logo_url: 'https://cdn.example.com/logo.png' }) })

    const img = leading(wrapper).get('img')
    expect(img.attributes('src')).toBe('https://cdn.example.com/logo.png')
    expect(img.attributes('alt')).toBe('')

    await img.trigger('error')

    expect(leading(wrapper).find('img').exists()).toBe(false)
    expect(leading(wrapper).text()).toBe('向')
  })

  it('ParentLayout leading falls back to initial or empty', async () => {
    const withName = await mountLayout('/', { config: config() })
    expect(leading(withName.wrapper).text()).toBe('向')
    expect(leading(withName.wrapper).find('img').exists()).toBe(false)
    withName.wrapper.unmount()
    mounted = null

    _resetPublicConfigForTests()
    mock.reset()
    const blank = await mountLayout('/', { config: config({ org_name: '' }) })
    expect(leading(blank.wrapper).find('img').exists()).toBe(false)
    expect(leading(blank.wrapper).text()).toBe('')
    blank.wrapper.unmount()
    mounted = null

    _resetPublicConfigForTests()
    mock.reset()
    const failed = await mountLayout('/', { config: 'error' })
    expect(leading(failed.wrapper).find('img').exists()).toBe(false)
    expect(leading(failed.wrapper).text()).toBe('')
    // 48px 欄位保留，標題不位移
    expect(failed.wrapper.find('.m3-top-app-bar__leading').exists()).toBe(true)
  })

  it('ParentLayout leading stays empty while config loads', async () => {
    const { wrapper } = await mountLayout('/', { config: 'pending' })

    expect(leading(wrapper).text()).toBe('')
    expect(leading(wrapper).find('img').exists()).toBe(false)
  })

  it('ParentLayout tab reselect scrolls to top', async () => {
    const { wrapper, router } = await mountLayout('/pickup')
    window.scrollTo(0, 500)
    expect(window.scrollY).toBe(500)

    await tab(wrapper, '接送').trigger('click')
    await flushPromises()
    // happy-dom 的 smooth 捲動在下一個 timer 才套用
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(window.scrollY).toBe(0)
    expect(router.currentRoute.value.path).toBe('/pickup')

    await router.push('/pickup/proxy')
    await flushPromises()
    expect(tab(wrapper, '接送').attributes('aria-current')).toBe('page')
    await tab(wrapper, '接送').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/pickup')
  })

  it('ParentLayout tab reselect respects reduced motion', async () => {
    const { wrapper } = await mountLayout('/homework')
    const scrollSpy = vi.spyOn(window, 'scrollTo')

    await tab(wrapper, '作業').trigger('click')
    expect(scrollSpy).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' })

    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }))
    window.scrollTo(0, 300)
    await tab(wrapper, '作業').trigger('click')

    expect(scrollSpy).toHaveBeenLastCalledWith({ top: 0, behavior: 'auto' })
    expect(window.scrollY).toBe(0)
  })

  it('ParentLayout tab click navigates to other tab', async () => {
    const { wrapper, router } = await mountLayout('/')
    const scrollSpy = vi.spyOn(window, 'scrollTo')

    await tab(wrapper, '成績').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/exams')
    expect(tab(wrapper, '成績').attributes('aria-current')).toBe('page')
    expect(wrapper.get('.m3-top-app-bar h1').text()).toBe('成績')
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('ParentLayout more badge from unread count', async () => {
    const withBadge = await mountLayout('/', { state: { parentNotifications: { unreadCount: 4 } } })
    expect(tab(withBadge.wrapper, '更多').get('.m3-nav-tab__badge').text()).toBe('4')
    expect(withBadge.wrapper.findAll('.m3-nav-tab__badge')).toHaveLength(1)
    withBadge.wrapper.unmount()
    mounted = null

    const none = await mountLayout('/', { state: { parentNotifications: { unreadCount: 0 } } })
    expect(tab(none.wrapper, '更多').find('.m3-nav-tab__badge').exists()).toBe(false)
  })

  it('ParentLayout refreshes unread on login', async () => {
    mock.onGet(NOTI_URL).reply(200, { items: [], total: 0, unread_count: 7 })
    const { wrapper, router, pinia } = await mountLayout('/login')

    expect(notiGets()).toHaveLength(0)
    expect(useParentWsStore(pinia).enabled).toBe(false)

    useParentAuthStore(pinia).setParent(ME)
    await router.push('/')
    await flushPromises()

    expect(notiGets()).toHaveLength(1)
    expect(notiGets()[0]!.params).toEqual({ page: 1, page_size: 1 })
    expect(tab(wrapper, '更多').get('.m3-nav-tab__badge').text()).toBe('7')
    expect(useNotificationsStore(pinia).unreadCount).toBe(7)
  })

  it('ParentLayout connects ws when authed', async () => {
    mock.onGet(NOTI_URL).reply(200, { items: [], total: 0, unread_count: 0 })
    const { pinia } = await mountLayout('/', { authed: true })

    const ws = useParentWsStore(pinia)
    expect(ws.enabled).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0]!.url.endsWith('/api/ws/parent')).toBe(true)
    expect(notiGets()).toHaveLength(1)

    useParentAuthStore(pinia).parent = null
    await nextTick()

    expect(ws.enabled).toBe(false)
    expect(ws.status).toBe('idle')
  })

  it('ParentLayout does not touch ws when anonymous', async () => {
    const { pinia } = await mountLayout('/login')
    const ws = useParentWsStore(pinia)

    expect(ws.disconnect).not.toHaveBeenCalled()
    expect(ws.connect).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

  it('ParentLayout renders first snackbar', async () => {
    const { wrapper } = await mountLayout('/', {
      state: {
        parentSnackbar: {
          items: [
            { id: 1, message: '已取消接送', tone: 'info', duration: 0 },
            { id: 2, message: '第二則', tone: 'info', duration: 0 },
          ],
        },
      },
    })

    expect(wrapper.get('.m3-snackbar').text()).toContain('已取消接送')
    expect(wrapper.text()).not.toContain('第二則')
  })

  it('ParentLayout prevents native overscroll', () => {
    expect(source).toMatch(/overscroll-behavior-y:\s*contain/)
    // 頁面捲動是 window 捲動：設定要落在 html（根捲動容器）上才有效
    expect(source).toMatch(/html[^{]*\{[^}]*overscroll-behavior-y:\s*contain/)
  })

  it('ParentLayout snackbar offset follows tab bar', async () => {
    const hidden = await mountLayout('/bind')
    expect(hidden.wrapper.classes()).toContain('is-tabbar-hidden')
    hidden.wrapper.unmount()
    mounted = null

    const publicPage = await mountLayout('/login')
    expect(publicPage.wrapper.classes()).toContain('is-tabbar-hidden')
    publicPage.wrapper.unmount()
    mounted = null

    const shown = await mountLayout('/')
    expect(shown.wrapper.classes()).not.toContain('is-tabbar-hidden')
  })

  it('ParentLayout style follows design decisions', () => {
    expect(source).toMatch(/\.parent-layout\s*\{[^}]*max-width:\s*560px/)
    expect(source).toMatch(/\.parent-layout\s*\{[^}]*min-height:\s*100dvh/)
    expect(source).toMatch(/\.app-header\s*\{[^}]*position:\s*sticky/)
    expect(source).toMatch(/\.app-header\s*\{[^}]*z-index:\s*5/)
    expect(source).toMatch(/\.layout-nav\s*\{[^}]*position:\s*fixed/)
    expect(source).toMatch(/\.layout-nav\s*\{[^}]*max-width:\s*560px/)
    expect(source).toMatch(/\.layout-nav\s*\{[^}]*z-index:\s*5/)
    expect(source).toMatch(/padding-bottom:\s*calc\(80px \+ env\(safe-area-inset-bottom\)\)/)
    expect(source).toMatch(/is-tabbar-hidden[^{]*\.m3-snackbar[^{]*\{[^}]*bottom:\s*calc\(16px \+ env\(safe-area-inset-bottom\)\)/)
    expect(source).toMatch(/\.brand-logo\s*\{[^}]*object-fit:\s*cover/)
    expect(source).toMatch(/\.logo-mark\s*\{[^}]*var\(--m3-primary-container\)/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
