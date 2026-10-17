import { DOMWrapper, flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { isNavigationFailure, NavigationFailureType, RouterView, type RouteRecordRaw } from 'vue-router'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ChildSummary } from '../api/children'
import { _resetPublicConfigForTests, DEFAULT_PARENT_LIMITS, type ParentLimits, type PublicConfig } from '../api/config'
import { parentHttp } from '../api/http'
import type { ParentAuthorization } from '../api/pickupAuthorizations'
import type { PickupPerson } from '../api/pickupPersons'
import PullToRefresh from '../components/PullToRefresh.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'
import PickupProxyView from './PickupProxyView.vue'

// 系統時間固定 2026-10-02（五）09:00 台北（UTC 01:00）
const NOW = new Date('2026-10-02T01:00:00Z')

const CONFIG_URL = '/parent/config'
const personsUrl = (childId: string) => `/parent/children/${childId}/pickup-persons`
const authsUrl = (childId: string) => `/parent/children/${childId}/pickup-authorizations`
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }
const err = (code: string, message = '錯誤') => ({ error: { code, message, details: null } })

function config(limits: Partial<ParentLimits> = {}): PublicConfig {
  return {
    liff_id: '1650000000-abc',
    org_name: '向日葵安親班',
    org_phone: null,
    logo_url: null,
    add_friend_url: null,
    limits: { ...DEFAULT_PARENT_LIMITS, persons_max: 10, authorization_max_days_ahead: 14, ...limits },
  }
}

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級班', school_name: null, photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

function person(id: string, name: string, overrides: Partial<PickupPerson> = {}): PickupPerson {
  return {
    id,
    student_id: 's1',
    name,
    relation: '保母',
    phone: '0912000123',
    photo_url: null,
    created_at: '2026-09-20T02:00:00Z',
    ...overrides,
  }
}

function persons(count: number): PickupPerson[] {
  return Array.from({ length: count }, (_, i) => person(`pp${i + 1}`, `接送人${i + 1}`))
}

function auth(id: string, overrides: Partial<ParentAuthorization> = {}): ParentAuthorization {
  return {
    id,
    student_id: 's1',
    service_date: '2026-10-03',
    pickup_person_id: null,
    proxy_name: '陳叔叔',
    proxy_phone: '0912000456',
    code_last4: '1234',
    status: 'active',
    effective_status: 'active',
    verified_at: null,
    verification_method: null,
    created_at: '2026-10-01T02:00:00Z',
    ...overrides,
  }
}

const LI_AUNT = person('pp1', '李阿姨')

/** 可手動決定何時回應的 reply */
function deferredReply() {
  let resolve!: (value: [number, unknown]) => void
  const promise = new Promise<[number, unknown]>((r) => {
    resolve = r
  })
  return { reply: () => promise, resolve }
}

let mock: MockAdapter
let mounted: MountedApp | null = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  _resetPublicConfigForTests()
  mock = createApiMock(parentHttp)
})

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted = null
  mock.restore()
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

const RouteStub = { render: () => h('div', 'stub') }
// 以 RouterView 渲染，onBeforeRouteLeave 才會掛上
const Host = defineComponent({ name: 'RouterViewHost', render: () => h(RouterView) })
const ROUTES: RouteRecordRaw[] = [
  { path: '/pickup/proxy', component: PickupProxyView },
  { path: '/:pathMatch(.*)*', component: RouteStub },
]

interface MountOptions {
  selectedId?: string
  /** null：不註冊（由測試自己註冊） */
  persons?: PickupPerson[] | null
  auths?: ParentAuthorization[] | null
  limits?: Partial<ParentLimits>
}

async function mountView(opts: MountOptions = {}): Promise<MountedApp> {
  const selectedId = opts.selectedId ?? 's1'
  mock.onGet(CONFIG_URL).reply(200, config(opts.limits))
  if (opts.persons !== null) mock.onGet(personsUrl(selectedId)).reply(200, opts.persons ?? [])
  if (opts.auths !== null) mock.onGet(authsUrl(selectedId)).reply(200, opts.auths ?? [])
  mounted = await mountWithApp(Host, {
    routes: ROUTES,
    initialRoute: '/pickup/proxy',
    piniaInitialState: { parentChildren: { items: KIDS, loaded: true, selectedId } },
  })
  await flushPromises()
  return mounted
}

type Wrapper = MountedApp['wrapper']

const getCount = (url: string) => mock.history.get.filter((r) => r.url === url).length
const postsTo = (url: string) => mock.history.post.filter((r) => r.url === url)
const body = () => document.body

/** M3Button 的文字在最後一個 span（前面可能有圖示 ligature） */
function findButton(scope: ParentNode, label: string): HTMLButtonElement | null {
  return (
    Array.from(scope.querySelectorAll('button')).find((b) => b.lastElementChild?.textContent?.trim() === label) ?? null
  )
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = findButton(scope, label)
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

function root(w: Wrapper): ParentNode {
  const el = w.element as HTMLElement
  return el.parentNode ?? el
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('找不到要點擊的元素')
  await new DOMWrapper(el).trigger('click')
  await flushPromises()
}

function sheet(title: string): HTMLElement | null {
  return (
    Array.from(body().querySelectorAll<HTMLElement>('[role="dialog"]')).find(
      (s) => s.querySelector('h2')?.textContent?.trim() === title,
    ) ?? null
  )
}

function requireSheet(title: string): HTMLElement {
  const found = sheet(title)
  if (!found) throw new Error(`sheet ${title} 沒有開啟`)
  return found
}

function alertDialog(): HTMLElement | null {
  const all = body().querySelectorAll<HTMLElement>('[role="alertdialog"]')
  return all[all.length - 1] ?? null
}

function requireDialog(): HTMLElement {
  const found = alertDialog()
  if (!found) throw new Error('確認對話框沒有開啟')
  return found
}

/** 欄位以 label 文字找 input */
function field(scope: HTMLElement, label: string): HTMLInputElement {
  const lab = Array.from(scope.querySelectorAll('label')).find((l) => l.textContent?.trim() === label)
  const id = lab?.getAttribute('for')
  const input = id ? scope.querySelector<HTMLInputElement>(`[id="${id}"]`) : null
  if (!input) throw new Error(`找不到欄位 ${label}`)
  return input
}

async function fill(input: HTMLInputElement, value: string): Promise<void> {
  await new DOMWrapper(input).setValue(value)
}

function sectionCard(w: Wrapper, title: string): HTMLElement {
  const heading = Array.from((w.element as HTMLElement).querySelectorAll('h2')).find(
    (el) => el.textContent?.trim() === title,
  )
  const section = heading?.closest('.px-section')
  let next = section?.nextElementSibling ?? null
  while (next && !next.classList.contains('px-card')) next = next.nextElementSibling
  if (!next) throw new Error(`找不到區塊 ${title} 的卡片`)
  return next as HTMLElement
}

const snackbarItems = (m: MountedApp) => useSnackbarStore(m.pinia).items
const lastSnackbar = (m: MountedApp) => {
  const items = snackbarItems(m)
  return items[items.length - 1]
}

/** 開「新增代理接送」選常用接送人送出，回應 a2 / 048213 */
async function createAuthorizationWithCode(m: MountedApp): Promise<void> {
  mock.onPost(authsUrl('s1')).reply(201, {
    authorization: auth('a2', { proxy_name: '李阿姨', pickup_person_id: 'pp1', code_last4: '8213', service_date: '2026-10-02' }),
    code: '048213',
  })
  await click(button(root(m.wrapper), '新增代理接送'))
  const form = requireSheet('新增代理接送')
  await click(Array.from(form.querySelectorAll('.af-person')).find((b) => b.textContent?.includes('李阿姨')))
  await click(button(form, '建立代理接送'))
}

describe('PickupProxyView', () => {
  it('PickupProxyView loads both sections for selected child', async () => {
    const m = await mountView({ selectedId: 's2', persons: [LI_AUNT], auths: [auth('a1', { code_last4: '5566' })] })

    expect(getCount(personsUrl('s2'))).toBe(1)
    expect(getCount(authsUrl('s2'))).toBe(1)
    expect(getCount(personsUrl('s1'))).toBe(0)
    const text = m.wrapper.text()
    expect(text).toContain('1/10')
    expect(text).toContain('有效 1 筆')
    expect(text).toContain('李阿姨')
    expect(text).toContain('接送碼末四碼')
    expect(text).toContain('5566')
  })

  it('PickupProxyView shows authorizations before persons', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [auth('a1')] })

    const titles = m.wrapper.findAll('h2').map((el) => el.text())
    expect(titles.indexOf('代理接送授權')).toBeGreaterThanOrEqual(0)
    expect(titles.indexOf('代理接送授權')).toBeLessThan(titles.indexOf('常用接送人'))
    // 「新增代理接送」在授權區之前
    const html = m.wrapper.html()
    expect(html.indexOf('新增代理接送')).toBeLessThan(html.indexOf('代理接送授權'))
  })

  it('PickupProxyView past authorizations collapsed', async () => {
    const m = await mountView({
      persons: [LI_AUNT],
      auths: [
        auth('a1'),
        auth('a2', { status: 'completed', effective_status: 'completed', service_date: '2026-09-30' }),
        auth('a3', { effective_status: 'expired', service_date: '2026-09-29' }),
      ],
    })

    expect(m.wrapper.findAll('ul[aria-label="有效的代理接送授權"] > li')).toHaveLength(1)
    const expander = m.wrapper.get('button.px-expander')
    expect(expander.text()).toContain('過去的授權（2）')
    expect(expander.attributes('aria-expanded')).toBe('false')
    expect(m.wrapper.find('ul[aria-label="過去的代理接送授權"]').exists()).toBe(false)

    await expander.trigger('click')

    expect(expander.attributes('aria-expanded')).toBe('true')
    const controls = expander.attributes('aria-controls')
    expect(controls).toBeTruthy()
    expect(m.wrapper.get(`[id="${controls}"]`).findAll('ul[aria-label="過去的代理接送授權"] > li')).toHaveLength(2)
    m.wrapper.unmount()
    mounted = null

    const onlyActive = await mountView({ persons: [LI_AUNT], auths: [auth('a1')] })
    expect(onlyActive.wrapper.text()).not.toContain('過去的授權')
  })

  it('PickupProxyView create authorization shows code once', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })

    await createAuthorizationWithCode(m)

    expect(JSON.parse(postsTo(authsUrl('s1'))[0]!.data as string)).toEqual({
      service_date: '2026-10-02',
      pickup_person_id: 'pp1',
    })
    expect(sheet('新增代理接送')).toBeNull()
    const codeSheet = requireSheet('接送碼')
    expect(codeSheet.textContent).toContain('048213')
    // 不可關閉：沒有關閉鈕，點 scrim 不關
    expect(codeSheet.querySelector('[aria-label="關閉"]')).toBeNull()
    await click(codeSheet.closest('.sheet-layer')?.querySelector('.sheet-scrim'))
    expect(sheet('接送碼')).not.toBeNull()
    expect(m.wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)

    await click(button(requireSheet('接送碼'), '我已記下'))

    expect(sheet('接送碼')).toBeNull()
    expect(body().textContent).not.toContain('048213')
    expect(m.wrapper.text()).not.toContain('048213')
    expect(getCount(authsUrl('s1'))).toBe(2)
  })

  it('PickupProxyView authorization limit message', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })
    mock.onPost(authsUrl('s1')).reply(409, err('authorization_limit_reached', '同一天最多 3 筆代理接送'))

    await click(button(root(m.wrapper), '新增代理接送'))
    const form = requireSheet('新增代理接送')
    await click(Array.from(form.querySelectorAll('.af-person')).find((b) => b.textContent?.includes('李阿姨')))
    await click(button(form, '建立代理接送'))

    const first = snackbarItems(m)[0]
    expect(first?.tone).toBe('error')
    expect(first?.message).toBe('這一天的代理接送已達上限')
    expect(/\d/.test(first?.message ?? '0')).toBe(false)
    expect(sheet('新增代理接送')).not.toBeNull()
    expect(sheet('接送碼')).toBeNull()
  })

  it('PickupProxyView regenerate requires confirm and shows new code', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [auth('a1')] })
    const url = '/parent/pickup-authorizations/a1/regenerate-code'
    mock.onPost(url).reply(200, { authorization: auth('a1', { code_last4: '1100' }), code: '771100' })

    await click(button(root(m.wrapper), '重新產生接送碼'))

    const dialog = requireDialog()
    expect(dialog.querySelector('h2')?.textContent?.trim()).toBe('重新產生接送碼？')
    expect(dialog.textContent).toContain('舊的接送碼會立即失效')
    expect(dialog.textContent).toContain('陳叔叔 · 10/03（六）')
    expect(postsTo(url)).toHaveLength(0)

    await click(button(dialog, '重新產生'))

    expect(postsTo(url)).toHaveLength(1)
    expect(alertDialog()).toBeNull()
    expect(requireSheet('接送碼').textContent).toContain('771100')
  })

  it('PickupProxyView cancel authorization updates row', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [auth('a1')] })
    const url = '/parent/pickup-authorizations/a1/cancel'
    mock.onPost(url).reply(200, auth('a1', { status: 'cancelled', effective_status: 'cancelled' }))

    await click(button(root(m.wrapper), '取消授權'))
    const dialog = requireDialog()
    expect(dialog.querySelector('h2')?.textContent?.trim()).toBe('取消這筆代理接送？')
    expect(dialog.textContent).toContain('陳叔叔 · 10/03（六）')

    await click(button(dialog, '確定取消'))

    expect(postsTo(url)).toHaveLength(1)
    expect(alertDialog()).toBeNull()
    expect(sectionCard(m.wrapper, '代理接送授權').textContent).toContain('目前沒有代理接送授權')
    const expander = m.wrapper.get('button.px-expander')
    expect(expander.text()).toContain('過去的授權（1）')
    await expander.trigger('click')
    expect(m.wrapper.findAll('ul[aria-label="過去的代理接送授權"] > li')).toHaveLength(1)
    expect(lastSnackbar(m)?.message).toBe('已取消代理接送')
    expect(getCount(authsUrl('s1'))).toBe(1)
  })

  it('PickupProxyView expired authorization error refreshes', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [auth('a1')] })
    mock.onPost('/parent/pickup-authorizations/a1/regenerate-code').reply(409, err('authorization_expired', '授權已過期'))

    await click(button(root(m.wrapper), '重新產生接送碼'))
    await click(button(requireDialog(), '重新產生'))

    expect(lastSnackbar(m)?.tone).toBe('error')
    expect(lastSnackbar(m)?.message).toBe('這筆授權已失效')
    expect(getCount(authsUrl('s1'))).toBe(2)
    expect(alertDialog()).toBeNull()
    expect(sheet('接送碼')).toBeNull()
  })

  it('PickupProxyView unknown error falls back', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [auth('a1')] })
    const url = '/parent/pickup-authorizations/a1/cancel'
    mock.onPost(url).reply(409, err('student_not_active', '此學生已退班，無法進行此操作'))

    await click(button(root(m.wrapper), '取消授權'))
    await click(button(requireDialog(), '確定取消'))

    expect(lastSnackbar(m)?.tone).toBe('error')
    expect(lastSnackbar(m)?.message).toBe('此學生已退班，無法進行此操作')
    // 不自動重試、對話框保留，可直接再按一次
    expect(postsTo(url)).toHaveLength(1)

    mock.onPost(url).networkError()
    await click(button(requireDialog(), '確定取消'))

    expect(postsTo(url)).toHaveLength(2)
    expect(lastSnackbar(m)?.tone).toBe('error')
    expect(lastSnackbar(m)?.message).toBe('操作失敗，請稍後再試')
  })

  it('PickupProxyView add person limit and errors', async () => {
    const full = await mountView({ persons: persons(10), auths: [], limits: { persons_max: 10 } })
    expect(button(root(full.wrapper), '新增接送人').disabled).toBe(true)
    expect(full.wrapper.text()).toContain('最多 10 位')
    expect(full.wrapper.text()).toContain('10/10')
    full.wrapper.unmount()
    mounted = null

    const m = await mountView({ persons: persons(9), auths: [], limits: { persons_max: 10 } })
    const add = button(root(m.wrapper), '新增接送人')
    expect(add.disabled).toBe(false)
    expect(m.wrapper.text()).not.toContain('最多 10 位')
    mock.onPost(personsUrl('s1')).reply(413)

    await click(add)
    const form = requireSheet('新增接送人')
    expect(form.textContent).toContain('為 王小明 新增常用接送人')
    await fill(field(form, '姓名'), '張阿姨')
    await click(Array.from(form.querySelectorAll('[role="radio"]')).find((c) => c.textContent?.includes('保母')))
    await fill(field(form, '電話'), '0912-000-789')
    await click(button(form, '儲存'))

    expect(postsTo(personsUrl('s1'))).toHaveLength(1)
    expect(sheet('新增接送人')).not.toBeNull()
    expect(field(requireSheet('新增接送人'), '姓名').value).toBe('張阿姨')
    expect(lastSnackbar(m)?.tone).toBe('error')
    expect(lastSnackbar(m)?.message).toBe('照片檔案過大')
  })

  it('PickupProxyView add person success', async () => {
    const m = await mountView({ persons: [], auths: [] })
    mock.onPost(personsUrl('s1')).reply(201, person('pp9', '張阿姨'))

    await click(button(root(m.wrapper), '新增接送人'))
    const form = requireSheet('新增接送人')
    await fill(field(form, '姓名'), '張阿姨')
    await click(Array.from(form.querySelectorAll('[role="radio"]')).find((c) => c.textContent?.includes('保母')))
    await fill(field(form, '電話'), '0912000789')
    mock.onGet(personsUrl('s1')).reply(200, [person('pp9', '張阿姨')])
    await click(button(form, '儲存'))

    expect(postsTo(personsUrl('s1'))).toHaveLength(1)
    expect(sheet('新增接送人')).toBeNull()
    expect(lastSnackbar(m)?.message).toBe('已新增接送人')
    expect(lastSnackbar(m)?.tone).toBe('info')
    expect(getCount(personsUrl('s1'))).toBe(2)
    expect(m.wrapper.text()).toContain('張阿姨')
    expect(m.wrapper.text()).toContain('1/10')
  })

  it('PickupProxyView delete person with confirm', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })
    mock.onDelete('/parent/pickup-persons/pp1').reply(204)

    await click(root(m.wrapper).querySelector('[aria-label="刪除 李阿姨"]'))
    const dialog = requireDialog()
    expect(dialog.querySelector('h2')?.textContent?.trim()).toBe('刪除 李阿姨？')
    expect(dialog.textContent).toContain('已建立的代理接送授權不受影響')
    expect(mock.history.delete).toHaveLength(0)

    mock.onGet(personsUrl('s1')).reply(200, [])
    await click(button(dialog, '刪除'))

    expect(mock.history.delete.map((r) => r.url)).toEqual(['/parent/pickup-persons/pp1'])
    expect(lastSnackbar(m)?.message).toBe('已刪除 李阿姨')
    expect(getCount(personsUrl('s1'))).toBe(2)
    expect(sectionCard(m.wrapper, '常用接送人').textContent).toContain('尚未新增常用接送人')
  })

  it('PickupProxyView delete missing person', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })
    mock.onDelete('/parent/pickup-persons/pp1').reply(404, err('pickup_person_not_found', '找不到接送人'))

    await click(root(m.wrapper).querySelector('[aria-label="刪除 李阿姨"]'))
    mock.onGet(personsUrl('s1')).reply(200, [])
    await click(button(requireDialog(), '刪除'))

    const first = snackbarItems(m)[0]
    expect(first?.tone).toBe('error')
    expect(first?.message).toBe('接送人已不存在')
    expect(getCount(personsUrl('s1'))).toBe(2)
    expect(alertDialog()).toBeNull()
  })

  it('PickupProxyView empty states', async () => {
    const m = await mountView({ persons: [], auths: [] })

    expect(sectionCard(m.wrapper, '常用接送人').textContent).toContain('尚未新增常用接送人')
    expect(sectionCard(m.wrapper, '代理接送授權').textContent).toContain('目前沒有代理接送授權')
    expect(m.wrapper.text()).toContain('0/10')
    expect(m.wrapper.text()).not.toContain('有效 0 筆')
  })

  it('PickupProxyView sections fail independently', async () => {
    mock.onGet(authsUrl('s1')).reply(500, SERVER_ERROR)
    const m = await mountView({ persons: [LI_AUNT], auths: null })

    const authCard = sectionCard(m.wrapper, '代理接送授權')
    expect(authCard.textContent).toContain('代理接送授權載入失敗')
    expect(sectionCard(m.wrapper, '常用接送人').textContent).toContain('李阿姨')
    expect(button(root(m.wrapper), '新增代理接送').disabled).toBe(false)

    mock.onGet(authsUrl('s1')).reply(200, [auth('a1')])
    await click(button(authCard, '重試'))

    expect(getCount(authsUrl('s1'))).toBe(2)
    expect(getCount(personsUrl('s1'))).toBe(1)
    expect(sectionCard(m.wrapper, '代理接送授權').textContent).not.toContain('代理接送授權載入失敗')
    expect(m.wrapper.text()).toContain('有效 1 筆')
  })

  it('PickupProxyView confirms leaving with code open', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })
    await createAuthorizationWithCode(m)
    expect(requireSheet('接送碼').textContent).toContain('048213')

    const stay = m.router.push('/pickup')
    await flushPromises()

    const dialog = requireDialog()
    expect(dialog.querySelector('h2')?.textContent?.trim()).toBe('確定已記下接送碼？')
    expect(dialog.textContent).toContain('離開後就無法再查看這組接送碼，遺失時只能重新產生')
    expect(m.router.currentRoute.value.path).toBe('/pickup/proxy')

    await click(button(dialog, '留在這裡'))
    await stay

    expect(m.router.currentRoute.value.path).toBe('/pickup/proxy')
    expect(alertDialog()).toBeNull()
    expect(requireSheet('接送碼').textContent).toContain('048213')

    const leave = m.router.push('/pickup')
    await flushPromises()
    await click(button(requireDialog(), '已記下，離開'))
    await leave
    await flushPromises()

    expect(m.router.currentRoute.value.path).toBe('/pickup')
    expect(body().textContent).not.toContain('048213')
    expect(m.wrapper.text()).not.toContain('048213')
  })

  it('PickupProxyView leaves without confirm when no code is open', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })

    await m.router.push('/pickup')
    await flushPromises()

    expect(m.router.currentRoute.value.path).toBe('/pickup')
    expect(alertDialog()).toBeNull()
  })

  it('PickupProxyView follows configured limits', async () => {
    const m = await mountView({ persons: persons(3), auths: [], limits: { persons_max: 3, authorization_max_days_ahead: 7 } })

    expect(m.wrapper.text()).toContain('3/3')
    expect(button(root(m.wrapper), '新增接送人').disabled).toBe(true)
    expect(m.wrapper.text()).toContain('最多 3 位')

    await click(button(root(m.wrapper), '新增代理接送'))
    const form = requireSheet('新增代理接送')
    expect(form.textContent).toContain('為 王小明 建立代理接送')
    const date = field(form, '接送日期')
    expect(date.min).toBe('2026-10-02')
    expect(date.max).toBe('2026-10-09')
  })

  it('PickupProxyView switching child reloads both sections', async () => {
    const m = await mountView({
      persons: [LI_AUNT],
      auths: [auth('a1'), auth('a2', { effective_status: 'expired', service_date: '2026-09-29' })],
    })
    await m.wrapper.get('button.px-expander').trigger('click')
    expect(m.wrapper.get('button.px-expander').attributes('aria-expanded')).toBe('true')

    mock.onGet(personsUrl('s2')).reply(200, [person('pp7', '王伯伯', { student_id: 's2' })])
    mock.onGet(authsUrl('s2')).reply(200, [auth('b1', { student_id: 's2', effective_status: 'expired' })])
    useChildrenStore(m.pinia).select('s2')
    await flushPromises()

    expect(getCount(personsUrl('s2'))).toBe(1)
    expect(getCount(authsUrl('s2'))).toBe(1)
    expect(m.wrapper.text()).toContain('王伯伯')
    expect(m.wrapper.text()).not.toContain('李阿姨')
    // 過去的授權回到收合
    expect(m.wrapper.get('button.px-expander').attributes('aria-expanded')).toBe('false')
  })

  it('PickupProxyView discards stale responses after switching child', async () => {
    const slowPersons = deferredReply()
    const slowAuths = deferredReply()
    mock.onGet(personsUrl('s1')).reply(slowPersons.reply)
    mock.onGet(authsUrl('s1')).reply(slowAuths.reply)
    const m = await mountView({ persons: null, auths: null })
    expect(m.wrapper.findAll('.skeleton--row')).toHaveLength(2)

    mock.onGet(personsUrl('s2')).reply(200, [person('pp7', '王伯伯', { student_id: 's2' })])
    mock.onGet(authsUrl('s2')).reply(200, [])
    useChildrenStore(m.pinia).select('s2')
    await flushPromises()
    slowPersons.resolve([200, [LI_AUNT]])
    slowAuths.resolve([200, [auth('a1', { proxy_name: '舊資料' })]])
    await flushPromises()

    expect(m.wrapper.text()).toContain('王伯伯')
    expect(m.wrapper.text()).not.toContain('李阿姨')
    expect(m.wrapper.text()).not.toContain('舊資料')
    expect(sectionCard(m.wrapper, '代理接送授權').textContent).toContain('目前沒有代理接送授權')
  })

  it('PickupProxyView pull to refresh keeps content and reports failure', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [auth('a1')] })
    mock.onGet(personsUrl('s1')).reply(500, SERVER_ERROR)
    mock.onGet(authsUrl('s1')).reply(200, [auth('a1'), auth('a5', { proxy_name: '林阿公', code_last4: '9090' })])

    await m.wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(getCount(personsUrl('s1'))).toBe(2)
    expect(getCount(authsUrl('s1'))).toBe(2)
    // 失敗的區塊保留現有內容
    expect(sectionCard(m.wrapper, '常用接送人').textContent).toContain('李阿姨')
    expect(m.wrapper.text()).toContain('林阿公')
    expect(lastSnackbar(m)?.tone).toBe('error')
    expect(lastSnackbar(m)?.message).toBe('更新失敗，請稍後再試')
  })

  it('PickupProxyView sorts authorizations by service date', async () => {
    const m = await mountView({
      persons: [LI_AUNT],
      auths: [
        auth('a1', { proxy_name: '陳叔叔', service_date: '2026-10-16' }),
        auth('a2', { proxy_name: '林阿公', service_date: '2026-10-14' }),
        auth('a3', { proxy_name: '張阿姨', service_date: '2026-10-15' }),
      ],
    })

    const order = m.wrapper
      .findAll('ul[aria-label="有效的代理接送授權"] > li')
      .map((li) => ['陳叔叔', '林阿公', '張阿姨'].find((name) => li.text().includes(name)))
    expect(order).toEqual(['林阿公', '張阿姨', '陳叔叔'])
  })

  it('PickupProxyView disables add person until persons load', async () => {
    const slowPersons = deferredReply()
    mock.onGet(personsUrl('s1')).reply(slowPersons.reply)
    const m = await mountView({ persons: null, auths: [] })

    // 未回應：不知道目前人數
    expect(button(root(m.wrapper), '新增接送人').disabled).toBe(true)

    slowPersons.resolve([200, [LI_AUNT]])
    await flushPromises()

    expect(button(root(m.wrapper), '新增接送人').disabled).toBe(false)
    m.wrapper.unmount()
    mounted = null

    mock.onGet(personsUrl('s1')).reply(500, SERVER_ERROR)
    const failed = await mountView({ persons: null, auths: [] })

    expect(sectionCard(failed.wrapper, '常用接送人').textContent).toContain('常用接送人載入失敗')
    expect(button(root(failed.wrapper), '新增接送人').disabled).toBe(true)
  })

  it('PickupProxyView upserts created authorization', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })

    await createAuthorizationWithCode(m)

    // 接送碼 sheet 還開著、尚未重抓：清單已含回應的 a2
    expect(requireSheet('接送碼').textContent).toContain('048213')
    expect(getCount(authsUrl('s1'))).toBe(1)
    const items = m.wrapper.findAll('ul[aria-label="有效的代理接送授權"] > li')
    expect(items).toHaveLength(1)
    expect(items[0]!.text()).toContain('李阿姨')
    expect(items[0]!.text()).toContain('8213')
    expect(m.wrapper.text()).toContain('有效 1 筆')
  })

  it('PickupProxyView keeps delete dialog on generic error', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })
    mock.onDelete('/parent/pickup-persons/pp1').reply(500, SERVER_ERROR)

    await click(root(m.wrapper).querySelector('[aria-label="刪除 李阿姨"]'))
    await click(button(requireDialog(), '刪除'))

    expect(mock.history.delete).toHaveLength(1)
    expect(requireDialog().querySelector('h2')?.textContent?.trim()).toBe('刪除 李阿姨？')
    expect(lastSnackbar(m)?.tone).toBe('error')
    expect(lastSnackbar(m)?.message).toBe('伺服器錯誤')
    expect(sectionCard(m.wrapper, '常用接送人').textContent).toContain('李阿姨')
    expect(getCount(personsUrl('s1'))).toBe(1)
  })

  it('PickupProxyView disables add authorization without child', async () => {
    mock.onGet(CONFIG_URL).reply(200, config())
    mounted = await mountWithApp(Host, {
      routes: ROUTES,
      initialRoute: '/pickup/proxy',
      piniaInitialState: { parentChildren: { items: [], loaded: true, selectedId: null } },
    })
    await flushPromises()

    expect(useChildrenStore(mounted.pinia).selectedId).toBeNull()
    expect(button(root(mounted.wrapper), '新增代理接送').disabled).toBe(true)
    expect(mock.history.get.filter((r) => r.url?.includes('/pickup-'))).toHaveLength(0)
  })

  it('PickupProxyView resolves pending leave confirm as false', async () => {
    const m = await mountView({ persons: [LI_AUNT], auths: [] })
    await createAuthorizationWithCode(m)

    let firstResult: unknown = 'pending'
    void m.router.push('/pickup').then((result) => {
      firstResult = result
    })
    await flushPromises()
    expect(requireDialog().querySelector('h2')?.textContent?.trim()).toBe('確定已記下接送碼？')
    expect(firstResult).toBe('pending')

    // 前一次還沒回答又觸發離頁：前一次視為「留在這裡」
    const second = m.router.push('/more')
    await flushPromises()

    expect(isNavigationFailure(firstResult)).toBe(true)
    expect(m.router.currentRoute.value.path).toBe('/pickup/proxy')
    expect(requireDialog().querySelector('h2')?.textContent?.trim()).toBe('確定已記下接送碼？')
    expect(requireSheet('接送碼').textContent).toContain('048213')

    await click(button(requireDialog(), '留在這裡'))
    const secondResult = await second
    expect(isNavigationFailure(secondResult, NavigationFailureType.aborted)).toBe(true)
    expect(m.router.currentRoute.value.path).toBe('/pickup/proxy')
  })
})
