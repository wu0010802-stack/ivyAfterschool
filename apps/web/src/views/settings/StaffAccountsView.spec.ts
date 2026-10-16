import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { PermissionCatalog, Role } from '@/api/roles'
import type { StaffUser } from '@/api/staffUsers'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StaffAccountsView from './StaffAccountsView.vue'

const LIST_URL = '/admin/staff-users'

const CATALOG: PermissionCatalog = {
  groups: [
    {
      key: 'accounts',
      label: '帳號與權限',
      permissions: [
        { code: 'staff:read', label: '查看員工帳號' },
        { code: 'staff:write', label: '管理員工帳號' },
        { code: 'roles:read', label: '查看角色與權限' },
        { code: 'roles:write', label: '管理角色與權限' },
      ],
    },
    { key: 'students', label: '班級與學生', permissions: [{ code: 'students:read', label: '查看學生' }] },
    {
      key: 'pickup',
      label: '接送',
      permissions: [
        { code: 'pickup:operate', label: '接送回覆、確認、完成' },
        { code: 'pickup:override', label: '代理接送強制完成' },
      ],
    },
  ],
}
const ALL_CODES = CATALOG.groups.flatMap((g) => g.permissions.map((p) => p.code)).sort()

function role(code: string, name: string, effective: string[]): Role {
  return {
    id: `r-${code}`,
    code,
    name,
    description: null,
    is_system: true,
    permissions: effective,
    effective_permissions: [...effective].sort(),
    staff_count: 1,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  }
}

// API 回傳順序與畫面排序不同：角色下拉依 admin → director → clerk → tutor
const ROLES: Role[] = [
  role('tutor', '課輔老師', ['students:read']),
  role('admin', '管理員', ALL_CODES),
  role('clerk', '行政', ['students:read', 'pickup:operate']),
  role('director', '主任', ['staff:read', 'roles:read', 'students:read']),
]

function user(overrides: Partial<StaffUser> = {}): StaffUser {
  return {
    id: 'u2',
    username: 'tutor01',
    display_name: '陳老師',
    phone: null,
    email: null,
    role: { id: 'r-tutor', code: 'tutor', name: '課輔老師' },
    extra_permissions: [],
    revoked_permissions: [],
    effective_permissions: ['students:read'],
    is_active: true,
    must_change_password: false,
    last_login_at: '2026-10-05T00:12:00Z',
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

const SELF = user({
  id: 'u1',
  username: 'admin01',
  display_name: '系統管理員',
  role: { id: 'r-admin', code: 'admin', name: '管理員' },
  effective_permissions: ALL_CODES,
})

const ROUTES: RouteRecordRaw[] = [{ path: '/settings/accounts', component: { render: () => null } }]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

/** el-dropdown / el-tooltip 以 setTimeout 開關 */
async function advance(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

function replyUsers(items: StaffUser[], total = items.length): void {
  mock.onGet(LIST_URL).reply(200, { items, total })
}

async function mountView(permissions: string[] = ALL_CODES, initialRoute = '/settings/accounts') {
  const mounted = await mountWithApp(StaffAccountsView, {
    routes: ROUTES,
    initialRoute,
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'admin01',
          display_name: '系統管理員',
          role: { id: 'r-admin', code: 'admin', name: '管理員' },
          permissions,
          must_change_password: false,
        },
      },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  return mounted
}

function listParams(): Record<string, unknown>[] {
  return mock.history.get.filter((c) => c.url === LIST_URL).map((c) => c.params as Record<string, unknown>)
}

function rows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.el-table__body-wrapper tr.el-table__row')
}

function rowOf(wrapper: VueWrapper, displayName: string): DOMWrapper<Element> {
  const row = rows(wrapper).find((r) => r.findAll('td')[1]?.text() === displayName)
  if (!row) throw new Error(`找不到員工列 ${displayName}`)
  return row
}

/** 操作欄 fixed right：el-table 另外畫一份固定欄，以主表格那一列的最後一格為準 */
function opsCell(wrapper: VueWrapper, displayName: string): DOMWrapper<Element> {
  const cell = rowOf(wrapper, displayName).findAll('td').at(-1)
  if (!cell) throw new Error(`找不到 ${displayName} 的操作欄`)
  return cell
}

function button(root: VueWrapper | DOMWrapper<Element>, text: string): DOMWrapper<Element> | undefined {
  return root.findAll('button').find((b) => b.text() === text)
}

async function click(root: VueWrapper | DOMWrapper<Element>, text: string): Promise<void> {
  const btn = button(root, text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  await btn.trigger('click')
  await settle()
}

/** el-dropdown 的選單預先渲染在 body（每列一份，以 v-show 隱藏），只看目前顯示中的那一份 */
function visibleMenuItems(): HTMLElement[] {
  const poppers = Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown__popper')).filter(
    (p) => p.style.display !== 'none',
  )
  return poppers.flatMap((p) => Array.from(p.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')))
}

/** 打開某列的「更多」下拉，回傳可見選單的項目文字 */
async function openMore(wrapper: VueWrapper, displayName: string): Promise<string[]> {
  await click(opsCell(wrapper, displayName), '更多')
  await advance()
  return visibleMenuItems().map((i) => i.textContent?.trim() ?? '')
}

async function chooseMore(wrapper: VueWrapper, displayName: string, text: string): Promise<void> {
  await openMore(wrapper, displayName)
  const item = visibleMenuItems().find((i) => i.textContent?.trim() === text)
  if (!item) throw new Error(`${displayName} 的「更多」沒有「${text}」`)
  item.click()
  await advance()
}

function lastMessageBox(): HTMLElement {
  const box = Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
  if (!box) throw new Error('確認框沒有出現')
  return box
}

async function answerMessageBox(text: string): Promise<void> {
  await settle()
  const btn = Array.from(lastMessageBox().querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`確認框找不到「${text}」`)
  btn.click()
  await settle()
  await settle()
}

function tempPassword(): string {
  return Array.from(document.body.querySelectorAll('[data-test=temp-password]')).at(-1)?.textContent?.trim() ?? ''
}

async function chooseFilter(wrapper: VueWrapper, label: string, option: string): Promise<void> {
  const filter = wrapper
    .findAll('.list-toolbar__filter')
    .find((f) => f.find('.list-toolbar__filter-label').text() === label)
  if (!filter) throw new Error(`找不到篩選 ${label}`)
  await filter.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = filter.find('input').attributes('aria-controls')
  const options = Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [])
  const found = options.find((o) => o.textContent?.trim() === option)
  if (!found) throw new Error(`篩選 ${label} 找不到「${option}」，現有：${options.map((o) => o.textContent?.trim()).join('、')}`)
  found.click()
  await settle()
}

// 每列都有 el-dropdown / el-tooltip，且新增 / 編輯用真實 StaffUserFormDialog：happy-dom 下單一測試可能超過預設 5 秒
describe('StaffAccountsView', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/roles').reply(200, ROLES)
    mock.onGet('/admin/permissions').reply(200, CATALOG)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('StaffAccountsView lists accounts with status tags', async () => {
    replyUsers([
      SELF,
      user({ must_change_password: true, last_login_at: null, extra_permissions: ['pickup:override'] }),
      user({ id: 'u3', username: 'director01', display_name: '林主任', is_active: false, revoked_permissions: ['roles:read', 'staff:read'] }),
    ])
    const { wrapper } = await mountView()

    expect(wrapper.find('h1').text()).toBe('員工帳號')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe(
      '建立員工登入帳號、指定角色；個別員工的權限可以在角色之外額外加減',
    )
    expect(listParams()).toEqual([{ page: 1, page_size: 20 }])
    expect(wrapper.findAll('.el-table__header-wrapper th').map((th) => th.text())).toEqual([
      '帳號',
      '姓名',
      '角色',
      '個別調整',
      '狀態',
      '最後登入',
      '操作',
    ])

    const self = rowOf(wrapper, '系統管理員')
    expect(self.findAll('td')[0]?.text().replace(/\s+/g, '')).toBe('admin01你')
    expect(self.findAll('td')[3]?.text()).toBe('—')
    expect(self.findAll('td')[5]?.text()).toBe('2026/10/05 08:12')

    const tutor = rowOf(wrapper, '陳老師')
    expect(tutor.findAll('td')[0]?.text()).toBe('tutor01')
    expect(tutor.findAll('td')[2]?.text()).toBe('課輔老師')
    expect(tutor.findAll('td')[3]?.text()).toBe('+1')
    expect(tutor.findAll('td')[4]?.text().replace(/\s+/g, '')).toBe('啟用待改密碼')
    expect(tutor.findAll('td')[5]?.text()).toBe('從未登入')

    const inactive = rowOf(wrapper, '林主任')
    expect(inactive.classes()).toContain('acct-row-inactive')
    expect(inactive.findAll('td')[3]?.text()).toBe('−2')
    expect(inactive.findAll('td')[4]?.text()).toBe('停用')
    expect(wrapper.find('[data-test=toolbar-count]').text()).toBe('共 3 筆')
  })

  it('StaffAccountsView shows adjustment labels on hover', async () => {
    replyUsers([SELF, user({ extra_permissions: ['pickup:override'], revoked_permissions: ['students:read'] })])
    const { wrapper } = await mountView()

    const badge = rowOf(wrapper, '陳老師').find('.acct-adjust')
    expect(badge.attributes('aria-label')).toBe('額外授予 1 項、移除 1 項')
    await badge.trigger('mouseenter')
    await advance()
    expect(document.body.textContent).toContain('額外授予：代理接送強制完成')
    expect(document.body.textContent).toContain('移除：查看學生')
  })

  it('StaffAccountsView filters by role and status', async () => {
    replyUsers([SELF, user()])
    const { wrapper, router } = await mountView()

    await chooseFilter(wrapper, '角色', '課輔老師')
    await chooseFilter(wrapper, '狀態', '啟用')

    expect(listParams().at(-1)).toMatchObject({ role_id: 'r-tutor', is_active: true, page: 1 })
    expect(router.currentRoute.value.query).toMatchObject({ role_id: 'r-tutor', is_active: 'true', page: '1' })
  })

  it('StaffAccountsView role filter lists roles in system order', async () => {
    replyUsers([SELF])
    const { wrapper } = await mountView()

    const filter = wrapper
      .findAll('.list-toolbar__filter')
      .find((f) => f.find('.list-toolbar__filter-label').text() === '角色')
    await filter!.find('.el-select__wrapper').trigger('click')
    await settle()
    const listId = filter!.find('input').attributes('aria-controls')
    const options = Array.from(document.getElementById(listId!)?.querySelectorAll('.el-select-dropdown__item') ?? []).map(
      (o) => o.textContent?.trim(),
    )
    expect(options).toEqual(['全部', '管理員', '主任', '行政', '課輔老師'])
  })

  it('StaffAccountsView restores filters from query', async () => {
    replyUsers([SELF])
    await mountView(ALL_CODES, '/settings/accounts?is_active=false&q=陳&page=2')

    expect(listParams()).toEqual([{ q: '陳', is_active: false, page: 2, page_size: 20 }])
  })

  it('StaffAccountsView resets password and shows temp password once', async () => {
    replyUsers([SELF, user()])
    mock.onPost('/admin/staff-users/u2/reset-password').reply(200, { temp_password: 'Tmp-8f3K2q9x' })
    const { wrapper } = await mountView()

    await chooseMore(wrapper, '陳老師', '重設密碼')
    expect(lastMessageBox().textContent).toContain('重設後 陳老師 目前的登入會失效，確定要重設嗎？')
    await answerMessageBox('重設密碼')

    expect(mock.history.post[0]?.url).toBe('/admin/staff-users/u2/reset-password')
    expect(tempPassword()).toBe('Tmp-8f3K2q9x')
    // 重設後列表重新載入（must_change_password 由後端更新）
    expect(listParams()).toHaveLength(2)

    // 關閉後 DOM 不保留密碼
    await click(new DOMWrapper(Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)!), '我已記下')
    await answerMessageBox('確定關閉')
    expect(document.body.textContent).not.toContain('Tmp-8f3K2q9x')
  })

  it('StaffAccountsView hides self dangerous actions', async () => {
    replyUsers([SELF, user()])
    const { wrapper } = await mountView()

    expect(opsCell(wrapper, '系統管理員').findAll('button').map((b) => b.text())).toEqual(['編輯'])
    expect(opsCell(wrapper, '陳老師').findAll('button').map((b) => b.text())).toEqual(['編輯', '更多'])
    expect(await openMore(wrapper, '陳老師')).toEqual(['重設密碼', '停用'])
  })

  it('StaffAccountsView deactivates and reactivates', async () => {
    replyUsers([SELF, user()])
    mock.onPost('/admin/staff-users/u2/deactivate').reply(200, user({ is_active: false }))
    mock
      .onPost('/admin/staff-users/u2/activate')
      .reply(200, { user: user({ is_active: true, must_change_password: true }), temp_password: 'Tmp-b' })
    const { wrapper } = await mountView()

    await chooseMore(wrapper, '陳老師', '停用')
    expect(lastMessageBox().textContent).toContain('停用後 陳老師 將無法登入，確定要停用嗎？')
    await answerMessageBox('停用')

    expect(mock.history.post[0]?.url).toBe('/admin/staff-users/u2/deactivate')
    expect(rowOf(wrapper, '陳老師').findAll('td')[4]?.text()).toBe('停用')
    expect(rowOf(wrapper, '陳老師').classes()).toContain('acct-row-inactive')
    expect(document.body.textContent).toContain('已停用 陳老師')
    expect(await openMore(wrapper, '陳老師')).toEqual(['重新啟用'])

    visibleMenuItems()
      .find((i) => i.textContent?.trim() === '重新啟用')!
      .click()
    await advance()
    expect(lastMessageBox().textContent).toContain(
      '重新啟用後會產生新的臨時密碼，陳老師 登入後必須先修改密碼。確定要重新啟用嗎？',
    )
    await answerMessageBox('重新啟用')

    expect(mock.history.post[1]?.url).toBe('/admin/staff-users/u2/activate')
    expect(tempPassword()).toBe('Tmp-b')
    expect(rowOf(wrapper, '陳老師').findAll('td')[4]?.text().replace(/\s+/g, '')).toBe('啟用待改密碼')
  })

  it('StaffAccountsView shows backend errors for row actions', async () => {
    replyUsers([SELF, user()])
    mock.onPost('/admin/staff-users/u2/deactivate').reply(409, {
      error: { code: 'last_role_manager', message: '停用後系統將沒有任何可管理員工帳號的啟用帳號', details: null },
    })
    const { wrapper } = await mountView()

    await chooseMore(wrapper, '陳老師', '停用')
    await answerMessageBox('停用')

    expect(document.body.textContent).toContain('停用後系統將沒有任何可管理員工帳號的啟用帳號')
    expect(rowOf(wrapper, '陳老師').findAll('td')[4]?.text()).toBe('啟用')
  })

  it('StaffAccountsView creates user and shows temp password', async () => {
    const created = user({ id: 'u9', username: 'tutor02', display_name: '王老師', must_change_password: true, last_login_at: null })
    mock.onGet(LIST_URL).replyOnce(200, { items: [SELF], total: 1 }).onGet(LIST_URL).reply(200, { items: [SELF, created], total: 2 })
    mock.onPost(LIST_URL).reply(201, { user: created, temp_password: 'Tmp-new' })
    const { wrapper } = await mountView()

    await click(wrapper.find('[data-test=page-actions]'), '新增員工')
    const dialog = new DOMWrapper(Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)!)
    expect(dialog.find('.el-dialog__title').text()).toBe('新增員工')
    const field = (label: string) =>
      dialog
        .findAll('.el-form-item')
        .find((i) => i.find('.el-form-item__label').text().trim() === label)!
        .find('input')
    await field('帳號').setValue('tutor02')
    await field('姓名').setValue('王老師')
    const card = dialog.findAll('.role-card').find((c) => c.find('.role-card__name').text() === '課輔老師')
    await card!.trigger('click')
    await settle()
    await click(dialog.find('.el-dialog__footer'), '建立')

    expect(mock.history.post[0]?.url).toBe(LIST_URL)
    expect(tempPassword()).toBe('Tmp-new')
    expect(listParams()).toHaveLength(2)
    expect(rows(wrapper).map((r) => r.findAll('td')[1]?.text())).toEqual(['系統管理員', '王老師'])
  })

  it('StaffAccountsView edits user and updates row', async () => {
    replyUsers([SELF, user()])
    mock.onPatch('/admin/staff-users/u2').reply(200, user({ display_name: '陳大明' }))
    const { wrapper } = await mountView()

    await click(opsCell(wrapper, '陳老師'), '編輯')
    const dialog = new DOMWrapper(Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)!)
    expect(dialog.find('.el-dialog__title').text()).toBe('編輯員工：陳老師')
    const name = dialog
      .findAll('.el-form-item')
      .find((i) => i.find('.el-form-item__label').text().trim() === '姓名')!
      .find('input')
    await name.setValue('陳大明')
    await click(dialog.find('.el-dialog__footer'), '儲存')

    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({ display_name: '陳大明' })
    expect(rowOf(wrapper, '陳大明').findAll('td')[0]?.text()).toBe('tutor01')
  })

  it('StaffAccountsView readonly without staff:write', async () => {
    replyUsers([SELF, user()])
    const { wrapper } = await mountView(['staff:read'])

    expect(button(wrapper, '新增員工')).toBeUndefined()
    expect(wrapper.findAll('.el-table__header-wrapper th').map((th) => th.text())).not.toContain('操作')
    for (const text of ['編輯', '更多', '重設密碼', '停用', '重新啟用']) expect(button(wrapper, text)).toBeUndefined()
  })

  it('StaffAccountsView disables rows the actor cannot manage', async () => {
    replyUsers([
      user({ id: 'u1', username: 'hr01', display_name: '人事主管', effective_permissions: ['staff:read', 'staff:write', 'students:read'] }),
      user(),
      user({
        id: 'u3',
        username: 'director01',
        display_name: '林主任',
        effective_permissions: ['staff:read', 'staff:write', 'students:read', 'roles:write'],
      }),
    ])
    const { wrapper } = await mountView(['staff:read', 'staff:write', 'students:read'])

    const director = opsCell(wrapper, '林主任')
    expect(button(director, '編輯')?.attributes('disabled')).toBeDefined()
    expect(button(director, '更多')?.attributes('disabled')).toBeDefined()
    // 「重設密碼」「停用」在「更多」下拉裡：下拉停用，點了也打不開
    await button(director, '更多')!.trigger('click')
    await advance()
    expect(visibleMenuItems()).toEqual([])

    await director.find('.acct-ops').trigger('mouseenter')
    await advance()
    expect(document.body.textContent).toContain('無法管理權限比你大的帳號')

    expect(button(opsCell(wrapper, '陳老師'), '編輯')?.attributes('disabled')).toBeUndefined()
    expect(button(opsCell(wrapper, '陳老師'), '更多')?.attributes('disabled')).toBeUndefined()
  })

  it('StaffAccountsView empty state and pagination', async () => {
    mock.onGet(LIST_URL).reply((config) => {
      const params = config.params as { q?: string; page: number }
      return [200, params.q ? { items: [], total: 0 } : { items: [SELF], total: 45 }]
    })
    const { wrapper, router } = await mountView()

    await wrapper.find('.el-pagination .btn-next').trigger('click')
    await settle()
    expect(listParams().at(-1)).toMatchObject({ page: 2, page_size: 20 })
    expect(router.currentRoute.value.query.page).toBe('2')

    const search = wrapper.find('.list-toolbar__search input')
    await search.setValue('不存在')
    await search.trigger('keyup', { key: 'Enter' })
    await settle()
    expect(listParams().at(-1)).toMatchObject({ q: '不存在', page: 1 })
    const empty = wrapper.find('.el-table__empty-block')
    expect(empty.text()).toContain('沒有符合條件的員工帳號')
    expect(empty.text()).toContain('試著清除搜尋文字或調整角色、狀態篩選')
    expect(wrapper.find('.el-pagination').exists()).toBe(false)
  })

  it('StaffAccountsView shows retry on load failure', async () => {
    mock
      .onGet(LIST_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
      .onGet(LIST_URL)
      .reply(200, { items: [SELF], total: 1 })
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入員工帳號')
    expect(wrapper.find('.el-table').exists()).toBe(false)
    expect(button(wrapper, '新增員工')?.attributes('disabled')).toBeDefined()

    await click(wrapper, '重試')
    expect(rows(wrapper)).toHaveLength(1)
    expect(button(wrapper, '新增員工')?.attributes('disabled')).toBeUndefined()
  })

  it('StaffAccountsView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.StaffAccountsView()) as { default?: unknown }

    expect(loaded.default).toBe(StaffAccountsView)
  })
})
