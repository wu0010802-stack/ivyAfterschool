import { createTestingPinia, type TestingPinia } from '@pinia/testing'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { createApiMock } from '@/test/helpers'
import type { ChildSummary, ParentMe } from '../api/children'
import { _resetPublicConfigForTests, type PublicConfig } from '../api/config'
import { parentHttp, parentRefreshHttp } from '../api/http'
import { useChildrenStore } from '../stores/children'
import { useParentAuthStore, type BindPending } from '../stores/parentAuth'
import { useSnackbarStore } from '../stores/snackbar'
import BindView from './BindView.vue'
import source from './BindView.vue?raw'

const BIND_URL = '/parent/auth/bind'
const REFRESH_URL = '/parent/auth/refresh'
const CONFIG_URL = '/parent/config'
const FIELD_ERROR = '綁定碼為 8 碼英文或數字'
const LIMITS = {
  leave_past_days: 30,
  leave_future_days: 60,
  leave_max_attachments: 3,
  leave_max_attachment_mb: 10,
  authorization_max_days_ahead: 14,
  persons_max: 10,
}
const FRIEND_URL = 'https://line.me/R/ti/p/@happy'

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
  return { id, name, grade_level: 3, class_name: '中年級班', school_name: '某某國小', photo_url: null, status: 'active', ...overrides }
}

const MING = child('s1', '王小明')
const HUA = child('s2', '王小華', { grade_level: 5, class_name: '高年級班' })
const MEI = child('s3', '王小美', { grade_level: 5, class_name: null })

function me(children: ChildSummary[]): ParentMe {
  return { id: 'p1', display_name: '王媽媽', picture_url: null, phone: null, children }
}

function apiError(code: string, message = '發生錯誤') {
  return { error: { code, message, details: null } }
}

interface Mounted {
  wrapper: VueWrapper
  router: Router
  pinia: TestingPinia
}

describe('BindView', () => {
  let mock: MockAdapter
  let refreshMock: MockAdapter
  let mounted: Mounted | null = null

  beforeEach(() => {
    _resetPublicConfigForTests()
    mock = createApiMock(parentHttp)
    refreshMock = createApiMock(parentRefreshHttp)
  })

  afterEach(() => {
    mounted?.wrapper.unmount()
    mounted = null
    mock.restore()
    refreshMock.restore()
    document.body.innerHTML = ''
  })

  /** 掛在 document 上（焦點與送出鈕的 submit 才會生效） */
  async function mountBind(
    opts: { route?: string; parent?: ParentMe | null; bindPending?: BindPending | null; kids?: ChildSummary[] } = {},
  ): Promise<Mounted> {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { render: () => null } }],
    })
    await router.push(opts.route ?? '/bind')
    await router.isReady()
    const pinia = createTestingPinia({
      createSpy: vi.fn,
      stubActions: false,
      initialState: {
        parentAuth: { parent: opts.parent ?? null, bindPending: opts.bindPending ?? null },
        parentChildren: { items: opts.kids ?? [], loaded: true, selectedId: opts.kids?.[0]?.id ?? null },
      },
    })
    const wrapper = mount(BindView, { attachTo: document.body, global: { plugins: [router, pinia] } })
    await flushPromises()
    mounted = { wrapper, router, pinia }
    return mounted
  }

  const firstMode = (route = '/bind', nameHint: string | null = '王媽媽') =>
    mountBind({ route, bindPending: { nameHint } })
  const additionalMode = (kids: ChildSummary[] = [MING]) => mountBind({ parent: me(kids), kids })

  const bindPosts = () => mock.history.post.filter((r) => r.url === BIND_URL)
  const refreshPosts = () => refreshMock.history.post.filter((r) => r.url === REFRESH_URL)

  async function submit(wrapper: VueWrapper, code: string): Promise<void> {
    await wrapper.get('form input').setValue(code)
    await wrapper.get('form').trigger('submit')
    await flushPromises()
  }

  function button(wrapper: VueWrapper, label: string) {
    return wrapper.findAll('button').find((b) => b.text().endsWith(label))
  }

  it('BindView first bind normalizes and redirects', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).reply(200, { parent: me([MING]) })
    const { wrapper, router, pinia } = await firstMode('/bind?redirect=/homework')

    expect(wrapper.text()).toContain('第一次使用')
    expect(wrapper.get('h1').text()).toBe('綁定小孩')
    expect(wrapper.text()).toContain('您好，王媽媽')
    expect(wrapper.find('[aria-label="返回"]').exists()).toBe(false)

    await submit(wrapper, ' abcd-2345 ')

    expect(JSON.parse(bindPosts()[0]!.data as string)).toEqual({ code: 'ABCD2345' })
    expect(router.currentRoute.value.path).toBe('/homework')
    const auth = useParentAuthStore(pinia)
    expect(auth.isAuthed).toBe(true)
    expect(auth.bindPending).toBeNull()
    expect(useChildrenStore(pinia).items.map((c) => c.id)).toEqual(['s1'])
    expect(refreshPosts()).toHaveLength(0)
  })

  it('BindView first bind ignores unsafe redirect', async () => {
    mock.onGet(CONFIG_URL).reply(500, apiError('internal_error'))
    mock.onPost(BIND_URL).reply(200, { parent: me([MING]) })
    const { wrapper, router } = await firstMode('/bind?redirect=//evil.com', null)

    expect(wrapper.text()).not.toContain('您好')

    await submit(wrapper, 'ABCD2345')

    // 設定取得失敗：不顯示成功畫面，直接導頁（不安全的 redirect 回首頁）
    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(wrapper.text()).not.toContain('綁定完成')
  })

  it('BindView rejects malformed code locally', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    const { wrapper } = await firstMode()

    await submit(wrapper, 'ABC12')

    expect(wrapper.text()).toContain(FIELD_ERROR)
    expect(wrapper.get('input').attributes('aria-invalid')).toBe('true')
    expect(mock.history.post).toHaveLength(0)
    // 欄位顯示原輸入值，不即時改寫
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('ABC12')

    await wrapper.get('input').setValue('ABC123')

    expect(wrapper.text()).not.toContain(FIELD_ERROR)
    expect(wrapper.text()).toContain('請輸入安親班提供的 8 碼綁定碼。綁定碼只能使用一次，過期或已使用請向安親班索取新的綁定碼。')
  })

  it('BindView rejects codes with symbols or wrong length', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    const { wrapper } = await firstMode()

    for (const bad of ['ABCD234', 'ABCD23456', 'ABCD_234', '王ABC2345', '']) {
      await submit(wrapper, bad)
      expect(wrapper.text()).toContain(FIELD_ERROR)
    }
    expect(mock.history.post).toHaveLength(0)
  })

  it('BindView submits once via form', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).reply(200, { parent: me([MING]) })
    const { wrapper } = await firstMode()

    const form = wrapper.get('form')
    expect(form.attributes('autocapitalize')).toBe('characters')
    expect(form.attributes('novalidate')).toBeDefined()
    const input = wrapper.get('form input')
    expect(input.attributes('autocomplete')).toBe('one-time-code')
    expect(input.attributes('maxlength')).toBeUndefined()
    expect(wrapper.get('form button').attributes('type')).toBe('submit')

    await input.setValue('ABCD2345')
    // 欄位上的 Enter 不另外送出（瀏覽器的隱式送出會走 form submit）
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await form.trigger('submit')
    await flushPromises()

    expect(bindPosts()).toHaveLength(1)
  })

  it('BindView additional bind selects new child', async () => {
    mock.onGet(CONFIG_URL).reply(200, config({ add_friend_url: FRIEND_URL }))
    mock.onPost(BIND_URL).reply(200, { parent: me([MING, HUA]) })
    const { wrapper, router, pinia } = await additionalMode([MING])

    expect(wrapper.get('h1').text()).toBe('加綁其他小孩')
    expect(wrapper.text()).not.toContain('第一次使用')

    await submit(wrapper, 'ABCD2345')

    const children = useChildrenStore(pinia)
    expect(children.items.map((c) => c.id)).toEqual(['s1', 's2'])
    expect(children.selectedId).toBe('s2')
    expect(useSnackbarStore(pinia).items[0]?.message).toBe('已加綁 王小華')
    expect(useParentAuthStore(pinia).parent?.children).toHaveLength(2)
    expect(router.currentRoute.value.path).toBe('/')
    // 加綁不顯示首綁的成功畫面
    expect(wrapper.text()).not.toContain('綁定完成')
  })

  it('BindView additional mode lists bound children', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    const photo = 'https://cdn.example.com/s1.jpg'
    const { wrapper, router } = await additionalMode([{ ...MING, photo_url: photo }, MEI])

    expect(wrapper.text()).toContain('目前已綁定')
    expect(wrapper.text()).toContain('輸入新的綁定碼')
    const rows = wrapper.findAll('.bound-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('王小明')
    expect(rows[0]!.text()).toContain('3 年級 · 中年級班')
    expect(rows[1]!.text()).toContain('王小美')
    expect(rows[1]!.get('.bound-row__sub').text()).toBe('5 年級')
    expect(wrapper.text()).not.toContain('null')
    // 列不可點
    expect(rows[0]!.find('button, a').exists()).toBe(false)

    // 頭像：照片載入失敗退回首字
    const img = rows[0]!.get('img')
    expect(img.attributes('src')).toBe(photo)
    await img.trigger('error')
    expect(rows[0]!.find('img').exists()).toBe(false)
    expect(rows[0]!.get('.bound-row__avatar').text()).toBe('王')
    expect(rows[1]!.get('.bound-row__avatar').text()).toBe('王')

    await wrapper.get('[aria-label="返回"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/more')
  })

  it('BindView additional mode shows empty bound list', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    const { wrapper } = await additionalMode([])

    expect(wrapper.text()).toContain('目前沒有已綁定的小孩')
    expect(wrapper.findAll('.bound-row')).toHaveLength(0)
  })

  it('BindView additional bind refreshes on 401 and resends', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock
      .onPost(BIND_URL)
      .replyOnce(401, apiError('unauthenticated'))
      .onPost(BIND_URL)
      .replyOnce(200, { parent: me([MING, HUA]) })
    refreshMock.onPost(REFRESH_URL).reply(200, { parent: me([MING]) })
    const { wrapper, router, pinia } = await additionalMode([MING])

    await submit(wrapper, 'abcd 2345')

    expect(bindPosts()).toHaveLength(2)
    expect(bindPosts().map((r) => JSON.parse(r.data as string))).toEqual([{ code: 'ABCD2345' }, { code: 'ABCD2345' }])
    expect(refreshPosts()).toHaveLength(1)
    expect(useChildrenStore(pinia).selectedId).toBe('s2')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('BindView additional bind keeps loading while refreshing', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).replyOnce(401, apiError('unauthenticated'))
    let releaseRefresh!: () => void
    refreshMock.onPost(REFRESH_URL).reply(
      () =>
        new Promise<[number, unknown]>((resolve) => {
          releaseRefresh = () => resolve([401, apiError('unauthenticated')])
        }),
    )
    const { wrapper } = await additionalMode([MING])

    await submit(wrapper, 'ABCD2345')

    expect(refreshPosts()).toHaveLength(1)
    expect(button(wrapper, '綁定')?.attributes('aria-busy')).toBe('true')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    releaseRefresh()
    await flushPromises()
  })

  it('BindView additional bind logs out when refresh fails', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).reply(401, apiError('unauthenticated'))
    refreshMock.onPost(REFRESH_URL).reply(401, apiError('unauthenticated'))
    const { wrapper, router, pinia } = await additionalMode([MING])

    await submit(wrapper, 'ABCD2345')

    expect(bindPosts()).toHaveLength(1)
    expect(refreshPosts()).toHaveLength(1)
    expect(useParentAuthStore(pinia).isAuthed).toBe(false)
    expect(useChildrenStore(pinia).items).toEqual([])
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('BindView additional bind stops after second 401', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).reply(401, apiError('unauthenticated'))
    refreshMock.onPost(REFRESH_URL).reply(200, { parent: me([MING]) })
    const { wrapper, router, pinia } = await additionalMode([MING])

    await submit(wrapper, 'ABCD2345')

    expect(bindPosts()).toHaveLength(2)
    expect(refreshPosts()).toHaveLength(1)
    expect(useParentAuthStore(pinia).isAuthed).toBe(false)
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('BindView additional bind resend shows business error', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock
      .onPost(BIND_URL)
      .replyOnce(401, apiError('unauthenticated'))
      .onPost(BIND_URL)
      .replyOnce(409, apiError('already_bound_to_student'))
    refreshMock.onPost(REFRESH_URL).reply(200, { parent: me([MING]) })
    const { wrapper, router, pinia } = await additionalMode([MING])

    await submit(wrapper, 'ABCD2345')

    expect(wrapper.get('[role="alert"]').text()).toContain('您已經綁定過這位小孩')
    expect(useParentAuthStore(pinia).isAuthed).toBe(true)
    expect(router.currentRoute.value.path).toBe('/bind')
  })

  it('BindView shows expired code error', async () => {
    mock.onGet(CONFIG_URL).reply(200, config({ org_phone: '02-2345-6789' }))
    mock.onPost(BIND_URL).reply(400, apiError('binding_code_expired', '綁定碼已過期'))
    const { wrapper } = await firstMode()

    await submit(wrapper, 'ABCD2345')

    expect(wrapper.get('[role="alert"]').text()).toContain('綁定碼已過期')
    const call = wrapper.findAll('a').find((a) => a.text().includes('聯絡安親班'))
    expect(call?.attributes('href')).toBe('tel:0223456789')
    const input = wrapper.get('form input')
    expect((input.element as HTMLInputElement).value).toBe('ABCD2345')

    await button(wrapper, '重新輸入')!.trigger('click')
    await flushPromises()

    expect((wrapper.get('form input').element as HTMLInputElement).value).toBe('')
    expect(wrapper.text()).not.toContain('綁定碼已過期')
    expect(document.activeElement).toBe(wrapper.get('form input').element)
  })

  it('BindView clears previous error when submitting again', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock
      .onPost(BIND_URL)
      .replyOnce(400, apiError('binding_code_invalid'))
      .onPost(BIND_URL)
      .replyOnce(() => new Promise<[number, unknown]>(() => undefined))
    const { wrapper } = await firstMode()

    await submit(wrapper, 'ABCD2345')
    expect(wrapper.text()).toContain('綁定碼不正確')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.text()).not.toContain('綁定碼不正確')
    expect(button(wrapper, '綁定')?.attributes('aria-busy')).toBe('true')
    // 送出中輸入框維持可編輯
    expect(wrapper.get('form input').attributes('disabled')).toBeUndefined()
  })

  it('BindView hides raw server message', async () => {
    mock.onGet(CONFIG_URL).reply(200, config({ org_phone: '02-2345-6789' }))
    mock.onPost(BIND_URL).reply(500, apiError('internal_error', 'Internal Server Error'))
    const { wrapper } = await firstMode()

    await submit(wrapper, 'ABCD2345')

    expect(wrapper.get('[role="alert"]').text()).toContain('綁定失敗，請稍後再試')
    expect(wrapper.text()).not.toContain('Internal Server Error')
    expect(wrapper.findAll('a').some((a) => (a.attributes('href') ?? '').startsWith('tel:'))).toBe(false)
  })

  it('BindView treats network error as generic failure', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).networkError()
    const { wrapper } = await firstMode()

    await submit(wrapper, 'ABCD2345')

    expect(wrapper.get('[role="alert"]').text()).toContain('綁定失敗，請稍後再試')
    expect(wrapper.text()).not.toContain('網路連線異常')
  })

  it('BindView first bind timeout requires relogin', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).reply(401, apiError('unauthenticated'))
    const { wrapper, router, pinia } = await firstMode()

    await submit(wrapper, 'ABCD2345')

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('綁定時間已逾時，請重新以 LINE 登入')
    expect(alert.get('.m3-icon').text()).toBe('timer_off')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(refreshPosts()).toHaveLength(0)
    expect(useParentAuthStore(pinia).bindPending?.nameHint).toBe('王媽媽')

    await button(wrapper, '重新登入')!.trigger('click')
    await flushPromises()

    expect(useParentAuthStore(pinia).bindPending).toBeNull()
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it('BindView prevents double submit', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mock.onPost(BIND_URL).reply(() => new Promise<[number, unknown]>(() => undefined))
    const { wrapper } = await firstMode()

    await wrapper.get('form input').setValue('ABCD2345')
    await button(wrapper, '綁定')!.trigger('click')
    await flushPromises()
    expect(button(wrapper, '綁定')?.attributes('aria-busy')).toBe('true')

    await button(wrapper, '綁定')!.trigger('click')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(mock.history.post).toHaveLength(1)
  })

  it('BindView first bind shows add friend step', async () => {
    mock.onGet(CONFIG_URL).reply(200, config({ add_friend_url: FRIEND_URL }))
    mock.onPost(BIND_URL).reply(200, { parent: me([MING, MEI]) })
    const { wrapper, router } = await firstMode('/bind?redirect=/homework')

    await submit(wrapper, 'ABCD2345')

    expect(router.currentRoute.value.path).toBe('/bind')
    expect(wrapper.get('h1').text()).toBe('綁定完成')
    expect(wrapper.text()).toContain('已綁定：王小明（3 年級 · 中年級班）、王小美（5 年級）')
    expect(wrapper.text()).toContain('加入官方帳號好友')
    expect(wrapper.findAll('a').find((a) => a.text().includes('加入好友'))?.attributes('href')).toBe(FRIEND_URL)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.get('.success-head .m3-icon').text()).toBe('check_circle')

    await button(wrapper, '開始使用')!.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/homework')
  })

  it('BindView style follows design decisions', () => {
    expect(source).toMatch(/\.bind\s*\{[^}]*padding:\s*32px 16px 24px/)
    expect(source).toMatch(/\.bind\.has-bar\s*\{[^}]*padding-top:\s*8px/)
    expect(source).toMatch(/\.bind-head__eyebrow\s*\{[^}]*var\(--m3-primary\)/)
    expect(source).toMatch(/\.bound-row\s*\{[^}]*min-height:\s*56px/)
    expect(source).toMatch(/\.bound-row__avatar\s*\{[^}]*width:\s*40px/)
    expect(source).toMatch(/\.bound-row__avatar\s*\{[^}]*var\(--m3-tertiary-container\)/)
    expect(source).toMatch(/\.bind-timeout__box\s*\{[^}]*var\(--m3-warning-container\)/)
    expect(source).toMatch(/\.bind-footer\s*\{[^}]*position:\s*sticky/)
    expect(source).toMatch(/\.bind-footer\s*\{[^}]*border-top:\s*1px solid var\(--m3-outline-variant\)/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    // 綁定碼不得寫進 console 或 storage
    expect(source).not.toMatch(/console\.|localStorage|sessionStorage/)
  })
})
