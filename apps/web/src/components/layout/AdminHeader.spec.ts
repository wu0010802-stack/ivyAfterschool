import { flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { StaffMe } from '@/api/auth'
import { adminHttp } from '@/api/http'
import type { WsStatus } from '@/shared/ws/createWsClient'
import { useAdminWsStore } from '@/stores/adminWs'
import { useAuthStore } from '@/stores/auth'
import { createApiMock, mountWithApp } from '@/test/helpers'
import AdminHeader from './AdminHeader.vue'
import adminHeaderSource from './AdminHeader.vue?raw'

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [
  { path: '/students', component: Stub, meta: { title: '學生工作台' } },
  { path: '/pickup', component: Stub, meta: { title: '接送' } },
  { path: '/login', component: Stub, meta: { title: '登入' } },
  { path: '/change-password', component: Stub, meta: { title: '修改密碼' } },
]

function makeUser(overrides: Partial<StaffMe> = {}): StaffMe {
  return {
    id: 'u1',
    username: 'clerk01',
    display_name: '林行政',
    role: { id: 'r-clerk', code: 'clerk', name: '行政' },
    permissions: ['students:read'],
    must_change_password: false,
    ...overrides,
  }
}

let mock: MockAdapter

/** el-dropdown / el-tooltip 以 setTimeout 開關，推進 fake timers 後再清 promise */
async function settle(): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
}

async function mountHeader(
  options: { initialRoute?: string; props?: Record<string, unknown>; user?: StaffMe } = {},
) {
  const mounted = await mountWithApp(AdminHeader, {
    routes: ROUTES,
    initialRoute: options.initialRoute ?? '/students',
    props: options.props,
    piniaInitialState: {
      auth: { user: options.user ?? makeUser(), status: 'authenticated' },
      notifications: { items: [], unreadCount: 0, total: 0, loading: false, loaded: false },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  return mounted
}

async function openUserMenu(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-test=user-menu]').trigger('click')
  await settle()
}

/** 下拉選單 teleport 到 body；已關閉的選單可能仍留在 DOM，取最後一個符合的項目 */
function menuItem(text: string): HTMLElement {
  const items = Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')).filter((el) =>
    el.textContent?.includes(text),
  )
  const item = items.at(-1)
  if (!item) throw new Error(`下拉選單中找不到「${text}」`)
  return item
}

function setWsStatus(status: WsStatus): void {
  // testing pinia 讓 computed getter 可寫
  ;(useAdminWsStore() as unknown as { status: WsStatus }).status = status
}

describe('AdminHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('AdminHeader shows user and page title', async () => {
    const { wrapper, router } = await mountHeader()

    expect(wrapper.find('h1').text()).toBe('學生工作台')
    const trigger = wrapper.find('[data-test=user-menu]')
    expect(trigger.text()).toContain('林行政')
    expect(trigger.find('.el-tag').text()).toBe('行政')

    await router.push('/pickup')
    await flushPromises()
    expect(wrapper.find('h1').text()).toBe('接送')
  })

  it('AdminHeader logout calls api then routes to login', async () => {
    mock.onPost('/admin/auth/logout').reply(200, {})
    const { wrapper, router } = await mountHeader()

    await openUserMenu(wrapper)
    menuItem('登出').click()
    await settle()

    expect(mock.history.post).toHaveLength(1)
    expect(mock.history.post[0]?.url).toBe('/admin/auth/logout')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(useAuthStore().status).toBe('anonymous')
  })

  it('AdminHeader logout item shows loading while pending', async () => {
    let release: (() => void) | undefined
    mock.onPost('/admin/auth/logout').reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, {}])
        }),
    )
    const { wrapper, router } = await mountHeader()

    await openUserMenu(wrapper)
    menuItem('登出').click()
    await settle()
    await openUserMenu(wrapper)

    const pending = menuItem('登出中…')
    expect(pending.classList.contains('is-disabled')).toBe(true)
    expect(pending.getAttribute('aria-disabled')).toBe('true')
    expect(router.currentRoute.value.path).toBe('/students')

    release?.()
    await settle()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('AdminHeader change password routes to change-password', async () => {
    const { wrapper, router } = await mountHeader()

    await openUserMenu(wrapper)
    menuItem('修改密碼').click()
    await settle()

    expect(router.currentRoute.value.path).toBe('/change-password')
    expect(mock.history.post).toHaveLength(0)
  })

  it('AdminHeader emits toggle sidebar', async () => {
    const { wrapper } = await mountHeader()

    await wrapper.find('[aria-label=切換側欄]').trigger('click')

    expect(wrapper.emitted('toggle-sidebar')).toHaveLength(1)
  })

  it('AdminHeader toggle icon follows collapsed and mobile', async () => {
    const { wrapper } = await mountHeader()
    const toggle = () => wrapper.find('[aria-label=切換側欄]')
    expect(toggle().find('[data-test=icon-fold]').exists()).toBe(true)
    expect(toggle().find('[data-test=icon-expand]').exists()).toBe(false)

    await wrapper.setProps({ collapsed: true })
    expect(toggle().find('[data-test=icon-expand]').exists()).toBe(true)
    expect(toggle().find('[data-test=icon-fold]').exists()).toBe(false)

    await wrapper.setProps({ collapsed: false, mobile: true })
    expect(toggle().find('[data-test=icon-expand]').exists()).toBe(true)
  })

  it('AdminHeader reflects ws status dot', async () => {
    const { wrapper } = await mountHeader()
    const dot = () => wrapper.find('[data-test=ws-dot]')

    setWsStatus('reconnecting')
    await nextTick()
    expect(dot().classes()).toContain('is-reconnecting')
    expect(dot().classes()).not.toContain('is-open')
    expect(dot().attributes('aria-label')).toBe('即時連線重試中')

    setWsStatus('open')
    await nextTick()
    expect(dot().classes()).toContain('is-open')
    expect(dot().classes()).not.toContain('is-reconnecting')
    expect(dot().attributes('aria-label')).toBe('即時連線正常')

    for (const status of ['idle', 'connecting', 'closed'] as const) {
      setWsStatus(status)
      await nextTick()
      expect(dot().classes()).not.toContain('is-open')
      expect(dot().classes()).not.toContain('is-reconnecting')
      expect(dot().attributes('aria-label')).toBe('即時連線未建立')
    }
  })

  it('AdminHeader renders notification bell between ws dot and user menu', async () => {
    const { wrapper } = await mountHeader()

    const order = Array.from(wrapper.element.querySelectorAll('[data-test=ws-dot], [aria-label=通知], [data-test=user-menu]')).map(
      (el) => el.getAttribute('data-test') ?? el.getAttribute('aria-label'),
    )
    expect(order).toEqual(['ws-dot', '通知', 'user-menu'])
  })

  it('AdminHeader moves name into menu on mobile', async () => {
    const { wrapper } = await mountHeader({ props: { mobile: true } })

    const trigger = wrapper.find('[data-test=user-menu]')
    expect(trigger.text()).not.toContain('林行政')
    expect(trigger.find('.el-tag').exists()).toBe(false)
    expect(trigger.attributes('aria-label')).toBe('帳號選單')

    await openUserMenu(wrapper)
    const info = menuItem('林行政（行政）')
    expect(info.classList.contains('is-disabled')).toBe(true)
  })

  it('AdminHeader keeps header sizes from mockup', () => {
    // happy-dom 不計算版面：以原始碼斷言稿的尺寸（頂欄 56、切換鈕 44×44、標題 16px 粗體、圓點 8px）
    const style = adminHeaderSource.slice(adminHeaderSource.indexOf('<style'))
    expect(style).toMatch(/\.admin-header\s*\{[^}]*height:\s*56px/)
    expect(style).toMatch(/\.admin-header__toggle\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/)
    expect(style).toMatch(/\.admin-header__title\s*\{[^}]*font-size:\s*16px[^}]*font-weight:\s*600/)
    expect(style).toMatch(/\.ws-dot\s*\{[^}]*width:\s*8px[^}]*height:\s*8px/)
  })
})
