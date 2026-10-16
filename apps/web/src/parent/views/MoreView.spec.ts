import { DOMWrapper, flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ChildSummary, ParentMe } from '../api/children'
import { _resetPublicConfigForTests, type PublicConfig } from '../api/config'
import { parentHttp, parentRefreshHttp } from '../api/http'
import { _resetLiffForTests, type LiffClient } from '../services/liff'
import { useChildrenStore } from '../stores/children'
import { useNotificationsStore } from '../stores/notifications'
import MoreView from './MoreView.vue'

const CONFIG_URL = '/parent/config'
const CHILDREN_URL = '/parent/children'
const LOGOUT_URL = '/parent/auth/logout'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }
const LIMITS = {
  leave_past_days: 30,
  leave_future_days: 60,
  leave_max_attachments: 3,
  leave_max_attachment_mb: 10,
  authorization_max_days_ahead: 14,
  persons_max: 10,
}

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

function child(id: string, name: string, overrides: Partial<ChildSummary> = {}): ChildSummary {
  return { id, name, grade_level: 3, class_name: null, school_name: null, photo_url: null, status: 'active', ...overrides }
}

function parentMe(overrides: Partial<ParentMe> = {}): ParentMe {
  return { id: 'p1', display_name: '王媽媽', picture_url: null, phone: null, children: [], ...overrides }
}

/** 登出流程會呼叫 initLiff：一律裝替身，避免載入真實 LIFF SDK */
function fakeLiff(): LiffClient {
  return {
    isLoggedIn: vi.fn(() => false),
    isInClient: vi.fn(() => true),
    login: vi.fn(),
    logout: vi.fn(),
    getIDToken: vi.fn(() => 'tok'),
    getDecodedIDToken: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  }
}

type MockWindow = Window & { __PARENT_LIFF_MOCK__?: LiffClient }

/** 可手動決定何時回應的 reply */
function deferredReply() {
  let resolve!: (value: [number, unknown]) => void
  const promise = new Promise<[number, unknown]>((r) => {
    resolve = r
  })
  return { reply: () => promise, resolve }
}

let mock: MockAdapter
let refreshMock: MockAdapter
let mounted: MountedApp | null = null

beforeEach(() => {
  _resetPublicConfigForTests()
  _resetLiffForTests()
  ;(window as MockWindow).__PARENT_LIFF_MOCK__ = fakeLiff()
  mock = createApiMock(parentHttp)
  refreshMock = createApiMock(parentRefreshHttp)
  mock.onGet(CONFIG_URL).reply(200, config())
})

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted = null
  mock.restore()
  refreshMock.restore()
  delete (window as MockWindow).__PARENT_LIFF_MOCK__
  _resetLiffForTests()
  sessionStorage.clear()
  localStorage.removeItem('parent_selected_child_v1')
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

interface ViewState {
  parent?: ParentMe | null
  children?: ChildSummary[]
  /** 預設 true（登入時已 seed） */
  loaded?: boolean
  selectedId?: string | null
  unreadCount?: number
}

async function mountView(state: ViewState = {}): Promise<MountedApp> {
  const kids = state.children ?? [child('s1', '王小明')]
  mounted = await mountWithApp(MoreView, {
    initialRoute: '/more',
    piniaInitialState: {
      parentAuth: { parent: state.parent === undefined ? parentMe() : state.parent },
      parentChildren: {
        items: kids,
        loaded: state.loaded ?? true,
        selectedId: state.selectedId === undefined ? (kids[0]?.id ?? null) : state.selectedId,
      },
      parentNotifications: { unreadCount: state.unreadCount ?? 0 },
    },
  })
  await flushPromises()
  return mounted
}

type Wrapper = MountedApp['wrapper']

const kidRow = (w: Wrapper, name: string) => {
  const row = w.findAll('button.kid-row').find((b) => b.find('.kid-row__name').text() === name)
  if (!row) throw new Error(`找不到小孩列 ${name}`)
  return row
}

const listItem = (w: Wrapper, headline: string) => {
  const item = w.findAll('li.m3-list-item').find((li) => li.find('.m3-list-item__headline').text() === headline)
  if (!item) throw new Error(`找不到清單列 ${headline}`)
  return item
}

const avatar = (w: Wrapper) => w.get('.profile__avatar')
const alertDialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]')

function dialogButton(label: string): HTMLButtonElement {
  const dialog = alertDialog()
  if (!dialog) throw new Error('確認對話框沒有開啟')
  const found = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!found) throw new Error(`找不到對話框按鈕 ${label}`)
  return found
}

async function click(el: Element): Promise<void> {
  await new DOMWrapper(el).trigger('click')
  await flushPromises()
}

async function openLogout(w: Wrapper): Promise<void> {
  await listItem(w, '登出').get('.m3-list-item__inner').trigger('click')
  await flushPromises()
}

const logoutPosts = () => mock.history.post.filter((r) => r.url === LOGOUT_URL)
const childrenGets = () => mock.history.get.filter((r) => r.url === CHILDREN_URL)

describe('MoreView', () => {
  it('MoreView lists children and switches', async () => {
    const { wrapper, router, pinia } = await mountView({
      children: [child('s1', '王小明', { grade_level: 3 }), child('s2', '王小華', { grade_level: 1 })],
      selectedId: 's1',
    })

    const first = kidRow(wrapper, '王小明')
    expect(first.text()).toContain('目前查看')
    expect(first.attributes('aria-current')).toBe('true')
    const second = kidRow(wrapper, '王小華')
    expect(second.text()).not.toContain('目前查看')
    expect(second.attributes('aria-current')).toBeUndefined()

    await second.trigger('click')
    await flushPromises()

    expect(useChildrenStore(pinia).selectedId).toBe('s2')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('MoreView marks single child as current', async () => {
    const { wrapper } = await mountView({
      children: [child('s1', '王小明', { grade_level: 3, class_name: '中年級班' })],
      selectedId: 's1',
    })

    const row = kidRow(wrapper, '王小明')
    expect(row.text()).toContain('目前查看')
    expect(row.text()).toContain('3 年級 · 中年級班')
    expect(row.attributes('aria-current')).toBe('true')
  })

  it('MoreView shows suspended pill and null class', async () => {
    const { wrapper } = await mountView({
      children: [
        child('s3', '王小美', { grade_level: 5, class_name: null, status: 'suspended' }),
        child('s1', '王小明', { grade_level: 3, class_name: '中年級班', status: 'active' }),
      ],
      selectedId: 's1',
    })

    const suspended = kidRow(wrapper, '王小美')
    expect(suspended.text()).toContain('暫停')
    expect(suspended.find('.kid-row__sub').text()).toBe('5 年級')
    expect(suspended.text()).not.toContain('null')
    expect(kidRow(wrapper, '王小明').text()).not.toContain('暫停')
  })

  it('MoreView loads children on mount', async () => {
    mock.onGet(CHILDREN_URL).reply(200, [child('s1', '王小明', { grade_level: 3, class_name: '中年級班' })])

    const { wrapper } = await mountView({ children: [], loaded: false, selectedId: null })

    expect(childrenGets()).toHaveLength(1)
    expect(kidRow(wrapper, '王小明').text()).toContain('3 年級 · 中年級班')
    wrapper.unmount()
    mounted = null

    // 已 seed（登入 / 綁定時）→ 不重打
    mock.resetHistory()
    const seeded = await mountView({ children: [child('s1', '王小明')], loaded: true })
    expect(seeded.wrapper.text()).toContain('王小明')
    expect(childrenGets()).toHaveLength(0)
  })

  it('MoreView shows skeleton while children load', async () => {
    const pending = deferredReply()
    mock.onGet(CHILDREN_URL).reply(pending.reply)

    const { wrapper } = await mountView({ children: [], loaded: false, selectedId: null })

    expect(wrapper.find('.skeleton--row').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('尚未綁定小孩')

    pending.resolve([200, [child('s1', '王小明')]])
    await flushPromises()

    expect(wrapper.find('.skeleton--row').exists()).toBe(false)
    expect(kidRow(wrapper, '王小明').exists()).toBe(true)
  })

  it('MoreView retries failed children load', async () => {
    mock
      .onGet(CHILDREN_URL)
      .replyOnce(500, SERVER_ERROR)
      .onGet(CHILDREN_URL)
      .replyOnce(200, [child('s1', '王小明', { grade_level: 3 })])

    const { wrapper } = await mountView({ children: [], loaded: false, selectedId: null })
    expect(wrapper.text()).toContain('小孩清單載入失敗')

    const retry = wrapper.findAll('button').find((b) => b.text().endsWith('重試'))
    if (!retry) throw new Error('找不到重試按鈕')
    await retry.trigger('click')
    await flushPromises()

    expect(childrenGets()).toHaveLength(2)
    expect(kidRow(wrapper, '王小明').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('小孩清單載入失敗')
  })

  it('MoreView empty children links to bind', async () => {
    mock.onGet(CHILDREN_URL).reply(200, [])

    const { wrapper, router } = await mountView({ children: [], loaded: false, selectedId: null })
    expect(wrapper.text()).toContain('尚未綁定小孩')

    const action = wrapper.findAll('button').find((b) => b.text().endsWith('輸入綁定碼'))
    if (!action) throw new Error('找不到輸入綁定碼按鈕')
    await action.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/bind')
  })

  it('MoreView shows unread badge on notifications', async () => {
    const { wrapper, pinia } = await mountView({ unreadCount: 5 })
    const notifications = useNotificationsStore(pinia)

    let row = listItem(wrapper, '通知')
    expect(row.get('.count-badge').text()).toBe('5')
    expect(row.get('.count-badge').attributes('aria-hidden')).toBe('true')
    expect(row.text()).toContain('5 則未讀')

    notifications.unreadCount = 120
    await flushPromises()
    row = listItem(wrapper, '通知')
    expect(row.get('.count-badge').text()).toBe('99+')
    expect(row.text()).toContain('120 則未讀')

    notifications.unreadCount = 0
    await flushPromises()
    row = listItem(wrapper, '通知')
    expect(row.find('.count-badge').exists()).toBe(false)
    expect(/\d/.test(row.text())).toBe(false)
  })

  it('MoreView entries link to feature pages', async () => {
    const { wrapper } = await mountView()

    // memory history 的 href 不帶 '#'
    const expected: Record<string, string> = {
      出勤紀錄: '/attendance',
      請假: '/leaves',
      代理接送: '/pickup/proxy',
      通知: '/notifications',
      通知設定: '/notifications/preferences',
      加綁其他小孩: '/bind',
    }
    for (const [headline, path] of Object.entries(expected)) {
      expect(listItem(wrapper, headline).get('a').attributes('href')).toBe(path)
    }
  })

  it('MoreView logout requires confirm', async () => {
    mock.onPost(LOGOUT_URL).reply(200)
    const { wrapper, router } = await mountView()

    await openLogout(wrapper)
    expect(alertDialog()?.querySelector('h2')?.textContent?.trim()).toBe('確定要登出？')
    expect(alertDialog()?.textContent).toContain('登出後需重新以 LINE 登入')

    await click(dialogButton('取消'))
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
    expect(logoutPosts()).toHaveLength(0)
    expect(router.currentRoute.value.path).toBe('/more')

    await openLogout(wrapper)
    await click(dialogButton('登出'))
    await flushPromises()

    expect(logoutPosts()).toHaveLength(1)
    expect(router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
  })

  it('MoreView logout shows loading until done', async () => {
    const pending = deferredReply()
    mock.onPost(LOGOUT_URL).reply(pending.reply)
    const { wrapper, router } = await mountView()

    await openLogout(wrapper)
    await click(dialogButton('登出'))

    expect(alertDialog()).not.toBeNull()
    expect(dialogButton('登出').getAttribute('aria-busy')).toBe('true')
    expect(dialogButton('取消').disabled).toBe(true)
    expect(router.currentRoute.value.path).toBe('/more')

    pending.resolve([200, null])
    await flushPromises()

    expect(logoutPosts()).toHaveLength(1)
    expect(router.currentRoute.value.fullPath).toBe('/login?logged_out=1')
  })

  it('MoreView avatar fallback', async () => {
    const { wrapper } = await mountView({ parent: parentMe({ picture_url: null, display_name: '王媽媽' }) })
    expect(avatar(wrapper).find('img').exists()).toBe(false)
    expect(avatar(wrapper).text()).toBe('王')
    expect(wrapper.get('h2.profile__name').text()).toBe('王媽媽')
    wrapper.unmount()
    mounted = null

    const withPhoto = await mountView({
      parent: parentMe({ picture_url: 'https://profile.line-scdn.net/abc', display_name: '王媽媽' }),
    })
    const img = avatar(withPhoto.wrapper).get('img')
    expect(img.attributes('src')).toBe('https://profile.line-scdn.net/abc')
    expect(img.attributes('alt')).toBe('')
    await img.trigger('error')
    expect(avatar(withPhoto.wrapper).find('img').exists()).toBe(false)
    expect(avatar(withPhoto.wrapper).text()).toBe('王')
  })

  it('MoreView avatar fallback for blank name', async () => {
    const { wrapper } = await mountView({ parent: parentMe({ display_name: '  ' }) })

    expect(avatar(wrapper).text()).toBe('家')
  })

  it('MoreView shows add friend card from config', async () => {
    mock.onGet(CONFIG_URL).reply(200, config({ add_friend_url: 'https://line.me/R/ti/p/@happy' }))
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('加入官方帳號好友')
    expect(wrapper.get('a.add-friend__link').attributes('href')).toBe('https://line.me/R/ti/p/@happy')
    wrapper.unmount()
    mounted = null

    _resetPublicConfigForTests()
    mock.onGet(CONFIG_URL).reply(200, config({ add_friend_url: null }))
    const without = await mountView()
    expect(without.wrapper.text()).not.toContain('加入官方帳號好友')
  })

  it('MoreView footer shows org name', async () => {
    mock.onGet(CONFIG_URL).reply(200, config({ org_name: '向日葵安親班' }))
    const { wrapper } = await mountView()
    expect(wrapper.get('.more-footer').text()).toBe('向日葵安親班')
    wrapper.unmount()
    mounted = null

    _resetPublicConfigForTests()
    mock.onGet(CONFIG_URL).reply(500, SERVER_ERROR)
    const failed = await mountView()
    expect(failed.wrapper.text()).not.toContain('向日葵安親班')
    expect(failed.wrapper.find('.more-footer').exists()).toBe(false)
  })
})
