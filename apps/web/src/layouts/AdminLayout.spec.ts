import { createTestingPinia } from '@pinia/testing'
import { flushPromises, mount } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router'
import type { StaffMe } from '@/api/auth'
import { adminHttp } from '@/api/http'
import AdminHeader from '@/components/layout/AdminHeader.vue'
import { useAdminWsStore } from '@/stores/adminWs'
import { useNotificationsStore } from '@/stores/notifications'
import type { Notification } from '@/shared/types/api'
import { createApiMock, mountWithApp } from '@/test/helpers'
import AdminLayout from './AdminLayout.vue'
import layoutSource from './AdminLayout.vue?raw'

const COLLAPSE_KEY = 'admin.sidebarCollapsed'
const BANNER_TEXT = '即時連線中斷，畫面每 15 秒自動更新'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  close(): void {
    this.readyState = 3
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverMessage(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }

  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code, reason: '', wasClean: false } as CloseEvent)
  }
}

const sockets = FakeWebSocket.instances

function lastSocket(): FakeWebSocket {
  const s = sockets.at(-1)
  if (!s) throw new Error('尚未建立 socket')
  return s
}

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [
  { path: '/students', component: Stub, meta: { title: '學生工作台' } },
  { path: '/pickup', component: Stub, meta: { title: '接送', tablet: true } },
  { path: '/login', component: Stub, meta: { title: '登入', layout: 'blank' } },
]

const USER: StaffMe = {
  id: 'u1',
  username: 'clerk01',
  display_name: '林行政',
  role: { id: 'r-clerk', code: 'clerk', name: '行政' },
  permissions: ['students:read', 'pickup:read'],
  must_change_password: false,
}

let mock: MockAdapter

function setViewportWidth(width: number): void {
  vi.stubGlobal('innerWidth', width)
  window.dispatchEvent(new Event('resize'))
}

async function mountLayout(options: { initialRoute?: string } = {}) {
  const mounted = await mountWithApp(AdminLayout, {
    routes: ROUTES,
    initialRoute: options.initialRoute ?? '/students',
    slots: { default: '<div data-test="page-content">頁面內容</div>' },
    piniaInitialState: { auth: { user: USER, status: 'authenticated' } },
  })
  document.body.appendChild(mounted.wrapper.element)
  return mounted
}

const sidebarOf = (wrapper: { find: (selector: string) => { classes: () => string[] } }) =>
  wrapper.find('[data-test=admin-sidebar]')

function drawerEl(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-test=admin-sidebar-drawer]')
}

/**
 * 同一個 pinia 與 router 重複掛載：模擬同一個分頁登出（AdminLayout 卸載）後換人登入。
 * mountWithApp 每次都建新的 pinia，驗不出 store 殘留的上一位使用者資料。
 */
function createSharedApp() {
  const router = createRouter({ history: createMemoryHistory(), routes: ROUTES })
  const pinia = createTestingPinia({
    initialState: { auth: { user: USER, status: 'authenticated' } },
    stubActions: false,
    createSpy: vi.fn,
  })
  return { router, pinia }
}

async function mountShared(app: ReturnType<typeof createSharedApp>) {
  await app.router.push('/students')
  await app.router.isReady()
  const wrapper = mount(AdminLayout, {
    slots: { default: '<div data-test="page-content">頁面內容</div>' },
    global: { plugins: [app.router, app.pinia] },
  })
  await flushPromises()
  document.body.appendChild(wrapper.element)
  return wrapper
}

function makeNotice(id: string, title: string): Notification {
  return {
    id,
    event: 'leave.created',
    title,
    body: `${title}的內文`,
    payload: {},
    read_at: null,
    created_at: '2026-10-02T08:00:00Z',
    deep_link: '/leaves',
  }
}

/** 手動決定何時回應通知清單，重現「上一位的預載還在途中就換人登入」 */
function deferredInbox() {
  let resolve!: (body: { items: Notification[]; total: number; unread_count: number }) => void
  const promise = new Promise<{ items: Notification[]; total: number; unread_count: number }>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const badgeVisible = (wrapper: { find: (selector: string) => { exists: () => boolean; isVisible: () => boolean } }): boolean => {
  const badge = wrapper.find('.el-badge__content')
  return badge.exists() && badge.isVisible()
}

/** 推進 fake timers（只假造 timer，promise 照常） */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
}

describe('AdminLayout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    sockets.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('innerWidth', 1280)
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/notifications').reply(200, { items: [], total: 0, unread_count: 0 })
  })

  afterEach(() => {
    useAdminWsStore().stop()
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('AdminLayout starts ws and loads notifications on mount', async () => {
    await mountLayout()

    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.url.endsWith('/api/ws/admin')).toBe(true)
    expect(useAdminWsStore().status).toBe('connecting')
    expect(mock.history.get.map((r) => r.url)).toContain('/admin/notifications')
    expect(useNotificationsStore().loaded).toBe(true)
  })

  it('AdminLayout renders page content inside the main area below the header', async () => {
    const { wrapper } = await mountLayout()

    const main = wrapper.find('main')
    expect(main.find('[data-test=page-content]').text()).toBe('頁面內容')
    expect(main.element.previousElementSibling?.tagName).toBe('HEADER')
    expect(wrapper.find('header h1').text()).toBe('學生工作台')
  })

  it('AdminLayout binds notification ws messages and unbinds them on unmount', async () => {
    const { wrapper } = await mountLayout()
    lastSocket().serverOpen()
    const notice = {
      id: 'n1',
      event: 'leave.created',
      title: '陳小美 請假',
      body: '陳小美 2026-10-05～2026-10-06 病假。',
      payload: {},
      read_at: null,
      created_at: '2026-10-02T08:00:00Z',
      deep_link: '/leaves',
    }

    lastSocket().serverMessage({ type: 'notification.created', data: notice, sent_at: '2026-10-02T08:00:01Z' })
    await nextTick()

    const store = useNotificationsStore()
    expect(store.items.map((n) => n.id)).toEqual(['n1'])
    expect(store.unreadCount).toBe(1)
    expect(wrapper.find('.el-badge__content').text()).toBe('1')

    wrapper.unmount()
    const ws = useAdminWsStore()
    ws.start()
    lastSocket().serverOpen()
    lastSocket().serverMessage({
      type: 'notification.created',
      data: { ...notice, id: 'n2' },
      sent_at: '2026-10-02T08:00:02Z',
    })
    await nextTick()

    // 卸載時收件匣已清空（換人登入不殘留），且重新啟動的 ws 收到 n2 也不會寫入（通知綁定已解除）
    expect(store.items).toEqual([])
    expect(store.unreadCount).toBe(0)
  })

  it('AdminLayout survives a failed notification fetch', async () => {
    mock.reset()
    mock.onGet('/admin/notifications').reply(500, { error: { code: 'internal_error', message: '伺服器錯誤' } })

    const { wrapper } = await mountLayout()
    await flushPromises()

    expect(wrapper.find('[data-test=page-content]').exists()).toBe(true)
    expect(useNotificationsStore().loaded).toBe(false)
    expect(useAdminWsStore().status).toBe('connecting')
  })

  it('AdminLayout shows reconnect banner after 5 seconds', async () => {
    const { wrapper } = await mountLayout()
    lastSocket().serverOpen()
    await nextTick()
    expect(wrapper.text()).not.toContain('即時連線中斷')

    lastSocket().serverClose(1006)
    await nextTick()
    expect(useAdminWsStore().status).toBe('reconnecting')

    await advance(4000)
    expect(wrapper.text()).not.toContain('即時連線中斷')

    await advance(2000)
    expect(wrapper.text()).toContain(BANNER_TEXT)
    // 橫幅在頂欄正下方、內容區之前，不蓋住內容
    const banner = wrapper.find('.admin-layout__banner')
    expect(banner.element.previousElementSibling?.tagName).toBe('HEADER')
    expect(banner.element.nextElementSibling?.tagName).toBe('MAIN')
    expect(banner.find('.el-alert__close-btn').exists()).toBe(false)

    // 重連 timer 於 1 秒時已建立第二條 socket
    expect(sockets).toHaveLength(2)
    lastSocket().serverOpen()
    await nextTick()
    expect(wrapper.text()).not.toContain('即時連線中斷')
  })

  it('AdminLayout does not show banner when the connection recovers within 5 seconds', async () => {
    const { wrapper } = await mountLayout()
    lastSocket().serverOpen()
    lastSocket().serverClose(1006)
    await nextTick()

    await advance(3000)
    lastSocket().serverOpen()
    await nextTick()
    await advance(10_000)

    expect(useAdminWsStore().status).toBe('open')
    expect(wrapper.text()).not.toContain('即時連線中斷')
  })

  it('AdminLayout does not show banner while still connecting', async () => {
    const { wrapper } = await mountLayout()

    await advance(30_000)

    expect(useAdminWsStore().status).toBe('connecting')
    expect(wrapper.text()).not.toContain('即時連線中斷')
  })

  it('AdminLayout restarts the banner delay on each new disconnect', async () => {
    const { wrapper } = await mountLayout()
    lastSocket().serverOpen()
    lastSocket().serverClose(1006)
    await advance(4000)
    // 第二條 socket（重連）連上後再斷：重新計 5 秒
    lastSocket().serverOpen()
    await nextTick()
    lastSocket().serverClose(1006)
    await advance(4000)
    expect(wrapper.text()).not.toContain('即時連線中斷')

    await advance(1500)
    expect(wrapper.text()).toContain(BANNER_TEXT)
  })

  it('AdminLayout toggles and remembers sidebar collapse', async () => {
    const { wrapper } = await mountLayout()
    expect(sidebarOf(wrapper).classes()).not.toContain('is-collapsed')

    await wrapper.find('[aria-label=切換側欄]').trigger('click')

    expect(sidebarOf(wrapper).classes()).toContain('is-collapsed')
    expect(localStorage.getItem(COLLAPSE_KEY)).toBe('true')

    wrapper.unmount()
    const again = await mountLayout()
    expect(sidebarOf(again.wrapper).classes()).toContain('is-collapsed')

    // 側欄底部的收合按鈕與頂欄切換鈕同步
    await again.wrapper.find('[aria-label=展開側欄]').trigger('click')
    expect(sidebarOf(again.wrapper).classes()).not.toContain('is-collapsed')
    expect(localStorage.getItem(COLLAPSE_KEY)).toBe('false')
  })

  it('AdminLayout collapses sidebar on tablet routes', async () => {
    const tablet = await mountLayout({ initialRoute: '/pickup' })
    expect(sidebarOf(tablet.wrapper).classes()).toContain('is-collapsed')
    expect(localStorage.getItem(COLLAPSE_KEY)).toBeNull()
    tablet.wrapper.unmount()

    const normal = await mountLayout({ initialRoute: '/students' })
    expect(sidebarOf(normal.wrapper).classes()).not.toContain('is-collapsed')
  })

  it('AdminLayout remembered state overrides the tablet default and follows navigation otherwise', async () => {
    localStorage.setItem(COLLAPSE_KEY, 'false')
    const remembered = await mountLayout({ initialRoute: '/pickup' })
    expect(sidebarOf(remembered.wrapper).classes()).not.toContain('is-collapsed')
    remembered.wrapper.unmount()

    localStorage.setItem(COLLAPSE_KEY, 'true')
    const collapsed = await mountLayout({ initialRoute: '/students' })
    expect(sidebarOf(collapsed.wrapper).classes()).toContain('is-collapsed')
    collapsed.wrapper.unmount()

    // 沒有記錄時預設依目前頁面：從一般頁導到平板頁會收合
    localStorage.clear()
    const { wrapper, router } = await mountLayout({ initialRoute: '/students' })
    expect(sidebarOf(wrapper).classes()).not.toContain('is-collapsed')
    await router.push('/pickup')
    await flushPromises()
    expect(sidebarOf(wrapper).classes()).toContain('is-collapsed')
  })

  it('AdminLayout ignores unreadable collapse storage', async () => {
    const denied = () => {
      throw new Error('SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied })

    const { wrapper } = await mountLayout()
    expect(sidebarOf(wrapper).classes()).not.toContain('is-collapsed')

    await wrapper.find('[aria-label=切換側欄]').trigger('click')
    expect(sidebarOf(wrapper).classes()).toContain('is-collapsed')
  })

  it('AdminLayout treats an invalid stored value as no record', async () => {
    localStorage.setItem(COLLAPSE_KEY, 'maybe')

    const { wrapper } = await mountLayout({ initialRoute: '/pickup' })

    expect(sidebarOf(wrapper).classes()).toContain('is-collapsed')
  })

  it('AdminLayout stops ws on unmount', async () => {
    const { wrapper } = await mountLayout()
    lastSocket().serverOpen()
    const count = sockets.length

    wrapper.unmount()
    await advance(60_000)

    expect(sockets).toHaveLength(count)
    expect(lastSocket().readyState).toBe(3)
    expect(useAdminWsStore().status).toBe('idle')
  })

  it('AdminLayout restarts ws and reloads notifications when mounted again', async () => {
    const first = await mountLayout()
    first.wrapper.unmount()
    mock.resetHistory()

    await mountLayout()

    expect(sockets).toHaveLength(2)
    expect(sockets[1]?.readyState).not.toBe(3)
    expect(mock.history.get.map((r) => r.url)).toEqual(['/admin/notifications'])
  })

  it('AdminLayout does not keep the previous user notifications when mounted again on the same pinia', async () => {
    mock.reset()
    mock.onGet('/admin/notifications').replyOnce(200, {
      items: [makeNotice('nA', '陳小美 請假')],
      total: 1,
      unread_count: 1,
    })
    mock.onGet('/admin/notifications').replyOnce(500, { error: { code: 'internal_error', message: '伺服器錯誤' } })
    const app = createSharedApp()
    const store = useNotificationsStore()

    const first = await mountShared(app)
    expect(store.items.map((n) => n.id)).toEqual(['nA'])
    expect(first.find('.el-badge__content').text()).toBe('1')

    // 登出：導向 blank layout，AdminLayout 卸載，通知收件匣一併清空
    first.unmount()
    expect(store.items).toEqual([])
    expect(store.unreadCount).toBe(0)
    expect(store.loaded).toBe(false)

    // 下一位使用者登入，預載失敗：不會看到上一位的通知與未讀數
    const second = await mountShared(app)
    expect(mock.history.get).toHaveLength(2)
    expect(store.items).toEqual([])
    expect(store.unreadCount).toBe(0)
    expect(store.total).toBe(0)
    expect(store.loaded).toBe(false)
    expect(badgeVisible(second)).toBe(false)
    expect(document.body.textContent).not.toContain('陳小美 請假')
  })

  it('AdminLayout ignores an in-flight notification response from the previous mount', async () => {
    mock.reset()
    const inboxA = deferredInbox()
    const inboxB = deferredInbox()
    mock.onGet('/admin/notifications').replyOnce(() => inboxA.promise.then((body) => [200, body]))
    mock.onGet('/admin/notifications').replyOnce(() => inboxB.promise.then((body) => [200, body]))
    const app = createSharedApp()
    const store = useNotificationsStore()

    // A 的預載還在途中就登出，B 登入後重新掛載：不共用 A 的請求
    const first = await mountShared(app)
    first.unmount()
    const second = await mountShared(app)
    expect(mock.history.get).toHaveLength(2)

    // A 的回應（以 A 的 cookie 取得）先到：不得寫進 store
    inboxA.resolve({ items: [makeNotice('nA', '陳小美 請假')], total: 1, unread_count: 1 })
    await flushPromises()
    expect(store.items).toEqual([])
    expect(store.unreadCount).toBe(0)
    expect(badgeVisible(second)).toBe(false)

    // 載入成功後只有 B 的資料
    inboxB.resolve({ items: [makeNotice('nB', '林小華 請假')], total: 1, unread_count: 1 })
    await flushPromises()
    expect(store.items.map((n) => n.id)).toEqual(['nB'])
    expect(store.unreadCount).toBe(1)
    expect(second.find('.el-badge__content').text()).toBe('1')
  })

  it('AdminLayout ignores a previous mount response that arrives after the new user is loaded', async () => {
    mock.reset()
    const inboxA = deferredInbox()
    mock.onGet('/admin/notifications').replyOnce(() => inboxA.promise.then((body) => [200, body]))
    mock.onGet('/admin/notifications').replyOnce(200, {
      items: [makeNotice('nB', '林小華 請假')],
      total: 1,
      unread_count: 1,
    })
    const app = createSharedApp()
    const store = useNotificationsStore()

    const first = await mountShared(app)
    first.unmount()
    await mountShared(app)
    expect(store.items.map((n) => n.id)).toEqual(['nB'])

    inboxA.resolve({ items: [makeNotice('nA', '陳小美 請假'), makeNotice('nA2', '王小明 請假')], total: 2, unread_count: 2 })
    await flushPromises()

    expect(store.items.map((n) => n.id)).toEqual(['nB'])
    expect(store.unreadCount).toBe(1)
    expect(store.total).toBe(1)
  })

  it('AdminLayout does not show a stale banner after remount', async () => {
    const first = await mountLayout()
    lastSocket().serverOpen()
    lastSocket().serverClose(1006)
    await advance(6000)
    expect(first.wrapper.text()).toContain(BANNER_TEXT)
    first.wrapper.unmount()

    const second = await mountLayout()

    expect(second.wrapper.text()).not.toContain('即時連線中斷')
  })

  it('AdminLayout wires header collapse and mobile props', async () => {
    const { wrapper } = await mountLayout()
    const header = () => wrapper.findComponent(AdminHeader)
    expect(header().props('collapsed')).toBe(false)
    expect(header().props('mobile')).toBe(false)

    await wrapper.find('[aria-label=切換側欄]').trigger('click')
    expect(header().props('collapsed')).toBe(true)
    expect(localStorage.getItem(COLLAPSE_KEY)).toBe('true')

    setViewportWidth(390)
    await nextTick()
    expect(header().props('mobile')).toBe(true)
    // 抽屜關閉時還沒渲染側欄
    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(false)
    expect(drawerEl()?.querySelector('[data-test=admin-sidebar]')).toBeNull()

    await wrapper.find('[aria-label=切換側欄]').trigger('click')
    await nextTick()

    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(true)
    expect(drawerEl()?.querySelector('[data-test=admin-sidebar]')).not.toBeNull()
    // 手機開關抽屜不動桌機的收合狀態與記憶
    expect(header().props('collapsed')).toBe(true)
    expect(localStorage.getItem(COLLAPSE_KEY)).toBe('true')
  })

  it('AdminLayout mobile uses a 240px left drawer instead of the sidebar', async () => {
    setViewportWidth(390)
    const { wrapper } = await mountLayout()

    expect(wrapper.find('[data-test=admin-sidebar]').exists()).toBe(false)

    await wrapper.find('[aria-label=切換側欄]').trigger('click')
    await nextTick()

    const drawer = drawerEl()
    expect(drawer?.classList.contains('ltr')).toBe(true)
    expect(drawer?.style.width).toBe('240px')
    const sidebar = drawer?.querySelector('[data-test=admin-sidebar]')
    expect(sidebar?.classList.contains('is-drawer')).toBe(true)
    // 抽屜內沒有收合按鈕
    expect(drawer?.querySelector('[aria-label=收合側欄]')).toBeNull()
    expect(drawer?.textContent).toContain('學生工作台')
  })

  it('AdminLayout mobile drawer closes after choosing a menu item and navigates', async () => {
    setViewportWidth(390)
    const { wrapper, router } = await mountLayout({ initialRoute: '/students' })
    await wrapper.find('[aria-label=切換側欄]').trigger('click')
    await nextTick()
    const drawer = () => wrapper.findComponent({ name: 'ElDrawer' })
    expect(drawer().props('modelValue')).toBe(true)

    const pickup = Array.from(drawerEl()?.querySelectorAll<HTMLElement>('.el-menu-item') ?? []).find((el) =>
      el.textContent?.includes('接送'),
    )
    pickup?.click()
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/pickup')
    expect(drawer().props('modelValue')).toBe(false)
  })

  it('AdminLayout mobile toggle button closes an open drawer', async () => {
    setViewportWidth(390)
    const { wrapper } = await mountLayout()
    const toggle = () => wrapper.find('[aria-label=切換側欄]')
    const drawer = () => wrapper.findComponent({ name: 'ElDrawer' })

    await toggle().trigger('click')
    expect(drawer().props('modelValue')).toBe(true)
    await toggle().trigger('click')

    expect(drawer().props('modelValue')).toBe(false)
  })

  it('AdminLayout leaving mobile width closes the drawer and restores the sidebar', async () => {
    setViewportWidth(390)
    const { wrapper } = await mountLayout()
    await wrapper.find('[aria-label=切換側欄]').trigger('click')
    await nextTick()
    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(true)

    setViewportWidth(1280)
    await nextTick()

    expect(wrapper.findComponent(AdminHeader).props('mobile')).toBe(false)
    expect(wrapper.find('[data-test=admin-sidebar]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'ElDrawer' }).exists()).toBe(false)

    // 回到手機寬度時抽屜是關閉的
    setViewportWidth(390)
    await nextTick()
    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(false)
  })

  it('AdminLayout treats widths below 768 as mobile', async () => {
    const { wrapper } = await mountLayout()
    const mobile = () => wrapper.findComponent(AdminHeader).props('mobile')

    setViewportWidth(767)
    await nextTick()
    expect(mobile()).toBe(true)

    setViewportWidth(768)
    await nextTick()
    expect(mobile()).toBe(false)
  })

  it('AdminLayout removes the resize listener on unmount', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { wrapper } = await mountLayout()
    const resizeHandlers = add.mock.calls.filter(([type]) => type === 'resize').map(([, fn]) => fn)
    expect(resizeHandlers.length).toBeGreaterThan(0)
    const removedBefore = remove.mock.calls.filter(([type]) => type === 'resize').map(([, fn]) => fn)
    expect(resizeHandlers.some((fn) => !removedBefore.includes(fn))).toBe(true)

    wrapper.unmount()

    // 掛載期間加上的每一個 resize 監聽（含本元件的）卸載後都已移除
    const removed = remove.mock.calls.filter(([type]) => type === 'resize').map(([, fn]) => fn)
    expect(resizeHandlers.filter((fn) => !removed.includes(fn))).toEqual([])
  })

  it('AdminLayout keeps only the main area scrollable with the approved paddings', () => {
    // happy-dom 不算版面：以原始碼斷言稿的 decisions（側欄與頂欄固定、只有內容區捲動、內容區 padding 20 / 16 / 12）
    const rule = (selector: string): string =>
      layoutSource.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

    expect(rule('.admin-layout')).toMatch(/height:\s*100dvh/)
    expect(rule('.admin-layout')).toMatch(/overflow:\s*hidden/)
    expect(rule('.admin-layout__body')).toMatch(/min-width:\s*0/)
    expect(rule('.admin-layout__main')).toMatch(/overflow:\s*auto/)
    expect(rule('.admin-layout__main')).toMatch(/min-height:\s*0/)
    expect(rule('.admin-layout__main')).toMatch(/padding:\s*20px/)
    expect(layoutSource).toMatch(/@media \(max-width: 1024px\)\s*\{\s*\.admin-layout__main\s*\{\s*padding:\s*16px/)
    expect(layoutSource).toMatch(/@media \(max-width: 767px\)\s*\{\s*\.admin-layout__main\s*\{\s*padding:\s*12px/)
  })
})
