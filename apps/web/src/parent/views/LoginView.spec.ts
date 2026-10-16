import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ParentMe } from '../api/children'
import { _resetPublicConfigForTests, type PublicConfig } from '../api/config'
import { parentHttp } from '../api/http'
import { _resetLiffForTests, type LiffClient } from '../services/liff'
import { useChildrenStore } from '../stores/children'
import { useParentAuthStore } from '../stores/parentAuth'
import LoginView from './LoginView.vue'
import source from './LoginView.vue?raw'

const LOGIN_URL = '/parent/auth/liff-login'
const CONFIG_URL = '/parent/config'
const MARKER = 'parent_liff_relogin_marker'
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

const ME: ParentMe = {
  id: 'p1',
  display_name: '王媽媽',
  picture_url: null,
  phone: null,
  children: [
    { id: 's1', name: '王小明', grade_level: 3, class_name: '中年級班', school_name: '某某國小', photo_url: null, status: 'active' },
  ],
}

function apiError(code: string, message = '發生錯誤') {
  return { error: { code, message, details: null } }
}

type FakeLiff = LiffClient & { login: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn> }

function fakeLiff(overrides: Partial<LiffClient> = {}): FakeLiff {
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    isLoggedIn: vi.fn(() => true),
    isInClient: vi.fn(() => true),
    login: vi.fn(),
    logout: vi.fn(),
    getIDToken: vi.fn(() => 'tok'),
    getDecodedIDToken: vi.fn(() => ({ exp: nowSec + 3600 })),
    ...overrides,
  } as FakeLiff
}

type MockWindow = Window & { __PARENT_LIFF_MOCK__?: LiffClient }

describe('LoginView', () => {
  let mock: MockAdapter
  let mounted: MountedApp | null = null

  beforeEach(() => {
    _resetPublicConfigForTests()
    _resetLiffForTests()
    mock = createApiMock(parentHttp)
    mock.onGet(CONFIG_URL).reply(200, config())
  })

  afterEach(() => {
    mounted?.wrapper.unmount()
    mounted = null
    delete (window as MockWindow).__PARENT_LIFF_MOCK__
    mock.restore()
    _resetLiffForTests()
  })

  function installLiff(fake: LiffClient): void {
    ;(window as MockWindow).__PARENT_LIFF_MOCK__ = fake
  }

  async function mountLogin(initialRoute = '/login'): Promise<MountedApp> {
    mounted = await mountWithApp(LoginView, { initialRoute })
    await flushPromises()
    return mounted
  }

  const loginPosts = () => mock.history.post.filter((r) => r.url === LOGIN_URL)
  const telLinks = (w: MountedApp['wrapper']) => w.findAll('a').filter((a) => (a.attributes('href') ?? '').startsWith('tel:'))
  const button = (w: MountedApp['wrapper'], label: string) => w.findAll('button').find((b) => b.text() === label)

  it('LoginView logs in bound parent and redirects', async () => {
    installLiff(fakeLiff())
    mock.onPost(LOGIN_URL).reply(200, { status: 'ok', parent: ME, name_hint: null })
    sessionStorage.setItem(MARKER, '1')

    const { router, pinia } = await mountLogin('/login?redirect=/pickup')

    expect(JSON.parse(loginPosts()[0]!.data as string)).toEqual({ id_token: 'tok' })
    expect(router.currentRoute.value.path).toBe('/pickup')
    expect(useChildrenStore(pinia).items[0]?.name).toBe('王小明')
    expect(useParentAuthStore(pinia).parent?.id).toBe('p1')
    // 登入成功後清掉強制重登的 marker，下一輪 id_token 過期仍可自動重登
    expect(sessionStorage.getItem(MARKER)).toBeNull()
  })

  it('LoginView sends unbound parent to bind', async () => {
    installLiff(fakeLiff())
    mock.onPost(LOGIN_URL).reply(200, { status: 'needs_binding', parent: null, name_hint: '王媽媽' })

    const { router, pinia } = await mountLogin('/login?redirect=/leaves')

    expect(router.currentRoute.value.fullPath).toBe('/bind?redirect=/leaves')
    expect(useParentAuthStore(pinia).bindPending?.nameHint).toBe('王媽媽')
    expect(useParentAuthStore(pinia).isAuthed).toBe(false)
  })

  it('LoginView drops unsafe redirect when sending to bind', async () => {
    installLiff(fakeLiff())
    mock.onPost(LOGIN_URL).reply(200, { status: 'needs_binding', parent: null, name_hint: null })

    const { router } = await mountLogin('/login?redirect=//evil.com')

    expect(router.currentRoute.value.fullPath).toBe('/bind')
  })

  it('LoginView external browser shows choice', async () => {
    const fake = fakeLiff({ isLoggedIn: vi.fn(() => false), isInClient: vi.fn(() => false) })
    installLiff(fake)

    const { wrapper } = await mountLogin()

    expect(wrapper.text()).toContain('請使用 LINE 帳號登入')
    expect(wrapper.text()).toContain('登入後即可查看小孩的到班、作業與接送狀態')
    const login = button(wrapper, '使用 LINE 登入')
    expect(login).toBeDefined()
    expect(fake.login).not.toHaveBeenCalled()

    await login!.trigger('click')
    await flushPromises()

    expect(fake.login).toHaveBeenCalledTimes(1)
    expect(fake.login).toHaveBeenCalledWith({ redirectUri: location.href })
    expect(button(wrapper, '使用 LINE 登入')?.attributes('aria-busy')).toBe('true')
    expect(loginPosts()).toHaveLength(0)
  })

  it('LoginView in client auto redirects to LINE', async () => {
    const fake = fakeLiff({ isLoggedIn: vi.fn(() => false), isInClient: vi.fn(() => true) })
    installLiff(fake)

    const { wrapper } = await mountLogin()

    expect(fake.login).toHaveBeenCalledTimes(1)
    expect(fake.login).toHaveBeenCalledWith({ redirectUri: location.href })
    expect(button(wrapper, '使用 LINE 登入')).toBeUndefined()
    expect(wrapper.get('[role="status"]').text()).toContain('正在連線 LINE…')
    expect(loginPosts()).toHaveLength(0)
  })

  it('LoginView stays after logout', async () => {
    const fake = fakeLiff({ isLoggedIn: vi.fn(() => false), isInClient: vi.fn(() => true) })
    installLiff(fake)

    const { wrapper } = await mountLogin('/login?logged_out=1')

    expect(wrapper.text()).toContain('您已登出')
    expect(wrapper.text()).toContain('需要時可再以 LINE 登入')
    expect(button(wrapper, '使用 LINE 登入')).toBeDefined()
    expect(fake.login).not.toHaveBeenCalled()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)

    await button(wrapper, '使用 LINE 登入')!.trigger('click')
    await flushPromises()
    expect(fake.login).toHaveBeenCalledTimes(1)
  })

  it('LoginView shows disabled account error', async () => {
    const fake = fakeLiff()
    installLiff(fake)
    mock.onPost(LOGIN_URL).reply(403, apiError('parent_disabled', '帳號已停用'))

    const { wrapper } = await mountLogin()

    expect(wrapper.text()).toContain('您的家長帳號已停用，請聯絡安親班')
    expect(wrapper.get('.empty-state__icon').text()).toBe('block')
    const retry = button(wrapper, '重試')
    expect(retry).toBeDefined()
    expect(sessionStorage.getItem(MARKER)).toBeNull()

    await retry!.trigger('click')
    await flushPromises()

    expect(sessionStorage.getItem(MARKER)).not.toBeNull()
    expect(fake.logout).toHaveBeenCalledTimes(1)
    expect(fake.login).toHaveBeenCalledTimes(1)
    // 等 LINE 轉址：停在 init 畫面，不顯示錯誤
    expect(wrapper.get('[role="status"]').text()).toContain('正在連線 LINE…')
    expect(wrapper.text()).not.toContain('您的家長帳號已停用')
  })

  it('LoginView relogins once on expired token', async () => {
    const fake = fakeLiff()
    installLiff(fake)
    mock.onPost(LOGIN_URL).reply(401, apiError('invalid_id_token', 'id_token 無效'))

    const first = await mountLogin()

    expect(fake.logout).toHaveBeenCalledTimes(1)
    expect(fake.login).toHaveBeenCalledTimes(1)
    expect(first.wrapper.text()).not.toContain('LINE 登入已逾時')
    expect(first.wrapper.get('[role="status"]').text()).toContain('正在連線 LINE…')
    expect(sessionStorage.getItem(MARKER)).not.toBeNull()
    first.wrapper.unmount()
    mounted = null

    // 本輪已強制重登過（marker 仍在）：同樣錯誤改顯示逾時訊息
    _resetLiffForTests()
    const second = await mountLogin()

    expect(fake.login).toHaveBeenCalledTimes(1)
    expect(second.wrapper.text()).toContain('LINE 登入已逾時，請關閉後重新開啟')
    expect(second.wrapper.get('.empty-state__icon').text()).toBe('timer_off')
    expect(telLinks(second.wrapper)).toHaveLength(0)
  })

  it('LoginView relogins when id token is about to expire', async () => {
    const fake = fakeLiff({ getDecodedIDToken: vi.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 10 })) })
    installLiff(fake)

    await mountLogin()

    expect(fake.logout).toHaveBeenCalledTimes(1)
    expect(fake.login).toHaveBeenCalledTimes(1)
    expect(loginPosts()).toHaveLength(0)
  })

  it('LoginView shows liff not configured', async () => {
    mock.reset()
    mock.onGet(CONFIG_URL).reply(200, config({ liff_id: '' }))

    const { wrapper } = await mountLogin()

    expect(wrapper.text()).toContain('安親班尚未設定 LINE 登入，請聯絡安親班')
    expect(wrapper.get('.empty-state__icon').text()).toBe('settings')
    expect(button(wrapper, '重試')).toBeDefined()
  })

  it('LoginView shows contact button for unrecoverable errors', async () => {
    mock.reset()
    mock.onGet(CONFIG_URL).reply(200, config({ org_phone: '02-2345-6789 #12' }))
    installLiff(fakeLiff())
    mock.onPost(LOGIN_URL).replyOnce(403, apiError('parent_disabled'))

    const disabled = await mountLogin()
    const link = telLinks(disabled.wrapper)
    expect(link).toHaveLength(1)
    expect(link[0]!.attributes('href')).toBe('tel:0223456789')
    expect(link[0]!.text()).toBe('聯絡安親班 02-2345-6789 #12')
    disabled.wrapper.unmount()
    mounted = null

    _resetLiffForTests()
    mock.onPost(LOGIN_URL).replyOnce(503, apiError('line_login_not_configured'))
    const notConfigured = await mountLogin()
    expect(notConfigured.wrapper.text()).toContain('安親班尚未設定 LINE 登入，請聯絡安親班')
    expect(telLinks(notConfigured.wrapper)[0]?.attributes('href')).toBe('tel:0223456789')
    notConfigured.wrapper.unmount()
    mounted = null

    _resetLiffForTests()
    mock.onPost(LOGIN_URL).replyOnce(429, apiError('too_many_attempts'))
    const tooMany = await mountLogin()
    expect(tooMany.wrapper.text()).toContain('嘗試次數過多，請稍後再試')
    expect(tooMany.wrapper.get('.empty-state__icon').text()).toBe('hourglass_top')
    expect(telLinks(tooMany.wrapper)).toHaveLength(0)
  })

  it('LoginView shows contact button when liff is not configured', async () => {
    mock.reset()
    mock.onGet(CONFIG_URL).reply(200, config({ liff_id: '', org_phone: '+886-2-2345-6789 轉 12' }))

    const { wrapper } = await mountLogin()

    expect(telLinks(wrapper)[0]?.attributes('href')).toBe('tel:+886223456789')
    expect(telLinks(wrapper)[0]?.text()).toBe('聯絡安親班 +886-2-2345-6789 轉 12')
  })

  it('LoginView hides contact button without phone', async () => {
    installLiff(fakeLiff())
    mock.onPost(LOGIN_URL).reply(403, apiError('parent_disabled'))

    const { wrapper } = await mountLogin()

    expect(wrapper.text()).toContain('您的家長帳號已停用，請聯絡安親班')
    expect(telLinks(wrapper)).toHaveLength(0)
  })

  it('LoginView maps remaining login errors', async () => {
    installLiff(fakeLiff())
    mock.onPost(LOGIN_URL).replyOnce(503, apiError('line_unavailable'))
    const unavailable = await mountLogin()
    expect(unavailable.wrapper.text()).toContain('LINE 驗證服務暫時無法連線，請稍後再試')
    expect(unavailable.wrapper.get('.empty-state__icon').text()).toBe('cloud_off')
    unavailable.wrapper.unmount()
    mounted = null

    _resetLiffForTests()
    mock.onPost(LOGIN_URL).replyOnce(500, apiError('internal_error', '伺服器發生錯誤'))
    const other = await mountLogin()
    expect(other.wrapper.text()).toContain('伺服器發生錯誤')
    expect(other.wrapper.get('.empty-state__icon').text()).toBe('error')
    other.wrapper.unmount()
    mounted = null

    _resetLiffForTests()
    mock.onPost(LOGIN_URL).replyOnce(500, 'oops')
    const noEnvelope = await mountLogin()
    expect(noEnvelope.wrapper.text()).toContain('伺服器暫時無法回應（500）')
    noEnvelope.wrapper.unmount()
    mounted = null

    _resetLiffForTests()
    installLiff(fakeLiff({ getIDToken: vi.fn(() => null) }))
    const noToken = await mountLogin()
    expect(noToken.wrapper.text()).toContain('登入失敗，請稍後再試')
    expect(loginPosts()).toHaveLength(2)
  })

  it('LoginView shows brand from config', async () => {
    mock.reset()
    mock.onGet(CONFIG_URL).reply(200, config({ logo_url: 'https://cdn.example.com/logo.png' }))
    installLiff(fakeLiff({ isLoggedIn: vi.fn(() => false), isInClient: vi.fn(() => false) }))

    const withLogo = await mountLogin()
    const img = withLogo.wrapper.get('.login-brand img')
    expect(img.attributes('src')).toBe('https://cdn.example.com/logo.png')
    expect(img.attributes('alt')).toBe('')
    expect(withLogo.wrapper.get('h1').text()).toBe('向日葵安親班')
    expect(withLogo.wrapper.text()).toContain('家長端')
    expect(withLogo.wrapper.find('.login-brand__mark').exists()).toBe(false)

    // 圖片載入失敗退回首字
    await img.trigger('error')
    expect(withLogo.wrapper.find('.login-brand img').exists()).toBe(false)
    expect(withLogo.wrapper.get('.login-brand__mark').text()).toBe('向')
    withLogo.wrapper.unmount()
    mounted = null

    _resetPublicConfigForTests()
    mock.reset()
    mock.onGet(CONFIG_URL).reply(200, config({ logo_url: null }))
    const noLogo = await mountLogin()
    expect(noLogo.wrapper.find('.login-brand img').exists()).toBe(false)
    expect(noLogo.wrapper.get('.login-brand__mark').text()).toBe('向')
    expect(noLogo.wrapper.get('h1').text()).toBe('向日葵安親班')
  })

  it('LoginView shows brand skeleton while config loads', async () => {
    mock.reset()
    mock.onGet(CONFIG_URL).reply(() => new Promise<[number, unknown]>(() => undefined))
    installLiff(fakeLiff({ isLoggedIn: vi.fn(() => false), isInClient: vi.fn(() => false) }))

    const { wrapper } = await mountLogin()

    expect(wrapper.find('.login-brand [aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.find('h1').exists()).toBe(false)
    expect(wrapper.text()).toContain('請使用 LINE 帳號登入')
  })

  it('LoginView falls back to generic brand', async () => {
    mock.reset()
    mock.onGet(CONFIG_URL).reply(500, apiError('internal_error', '伺服器發生錯誤'))

    const { wrapper } = await mountLogin()

    expect(wrapper.get('h1').text()).toBe('家長端')
    expect(wrapper.text().split('家長端')).toHaveLength(2)
    expect(wrapper.get('.login-brand__mark').text()).toBe('家')
    expect(wrapper.text()).toContain('LINE 登入初始化失敗，請稍後再試')
    expect(wrapper.get('.empty-state__icon').text()).toBe('error')
  })

  it('LoginView style follows design decisions', () => {
    expect(source).toMatch(/\.login\s*\{[^}]*padding:\s*96px 16px 24px/)
    expect(source).toMatch(/\.login-brand\s*\{[^}]*min-height:\s*160px/)
    expect(source).toMatch(/\.login-body\s*\{[^}]*max-width:\s*360px/)
    expect(source).toMatch(/\.login-body\s*\{[^}]*min-height:\s*220px/)
    expect(source).toMatch(/\.login-brand__logo[^{]*\{[^}]*object-fit:\s*cover/)
    expect(source).toMatch(/\.login-brand__mark\s*\{[^}]*var\(--m3-primary-container\)/)
    expect(source).toMatch(/\.login-spinner\s*\{[^}]*width:\s*40px/)
    expect(source).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.login-spinner\s*\{[^}]*animation:\s*none/)
    expect(source).toMatch(/\.login-call\s*\{[^}]*min-height:\s*48px/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
