import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { PermissionCatalog, Role } from '@/api/roles'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { createApiMock, mountWithApp } from '@/test/helpers'
import RolesView from './RolesView.vue'

const ROLES_URL = '/admin/roles'
const CATALOG_URL = '/admin/permissions'

const CATALOG: PermissionCatalog = {
  groups: [
    {
      key: 'accounts',
      label: '帳號與權限',
      permissions: [
        { code: 'staff:read', label: '查看員工帳號' },
        { code: 'roles:read', label: '查看角色與權限' },
        { code: 'roles:write', label: '管理角色與權限' },
      ],
    },
    {
      key: 'students',
      label: '班級與學生',
      permissions: [
        { code: 'students:read', label: '查看學生' },
        { code: 'students:write', label: '管理學生' },
      ],
    },
    {
      key: 'pickup',
      label: '接送',
      permissions: [
        { code: 'pickup:read', label: '查看接送佇列' },
        { code: 'pickup:operate', label: '接送回覆、確認、完成' },
      ],
    },
  ],
}
const ALL_CODES = CATALOG.groups.flatMap((g) => g.permissions.map((p) => p.code)).sort()

function makeRole(overrides: Partial<Role> & { code: string; name: string }): Role {
  const effective = overrides.effective_permissions ?? []
  return {
    id: `r-${overrides.code}`,
    description: null,
    is_system: true,
    permissions: effective,
    effective_permissions: effective,
    staff_count: 1,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  }
}

/** API 回傳順序與畫面排序不同：畫面依 admin → director → clerk → tutor → 自訂（依名稱） */
function rolesFixture(): Role[] {
  return [
    makeRole({ code: 'tutor', name: '課輔老師', effective_permissions: ['pickup:read', 'students:read'] }),
    makeRole({
      code: 'weekend_helper',
      name: '週六支援老師',
      is_system: false,
      staff_count: 0,
      effective_permissions: ['pickup:read'],
    }),
    makeRole({
      code: 'clerk',
      name: '行政',
      effective_permissions: ['pickup:read', 'students:read', 'students:write'],
    }),
    makeRole({ code: 'admin', name: '管理員', permissions: ['*'], effective_permissions: ALL_CODES }),
    makeRole({
      code: 'director',
      name: '主任',
      effective_permissions: ['pickup:read', 'roles:read', 'staff:read', 'students:read', 'students:write'],
    }),
  ]
}

const Stub = { render: () => null }
/** 以 RouterView 承載頁面，onBeforeRouteUpdate / onBeforeRouteLeave 才會生效 */
const Host = defineComponent({ render: () => h(RouterView) })
const ROUTES: RouteRecordRaw[] = [
  { path: '/settings/roles', component: RolesView, meta: { title: '角色權限' } },
  { path: '/students', component: Stub, meta: { title: '學生工作台' } },
]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountView(initialRoute = '/settings/roles', permissions: string[] = ALL_CODES) {
  const mounted = await mountWithApp(Host, {
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

function rolesRequests(): number {
  return mock.history.get.filter((c) => c.url === ROLES_URL).length
}

function cardNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.role-card__name').map((n) => n.text())
}

async function clickCard(wrapper: VueWrapper, name: string): Promise<void> {
  const card = wrapper.findAll('.role-card').find((c) => c.find('.role-card__name').text() === name)
  if (!card) throw new Error(`找不到角色卡「${name}」`)
  await card.trigger('click')
  await settle()
}

function selectedCardName(wrapper: VueWrapper): string {
  return wrapper.find('.role-card.is-selected .role-card__name').text()
}

function detailItem(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const item = wrapper
    .find('.role-detail')
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text().trim() === label)
  if (!item) throw new Error(`詳情找不到欄位 ${label}`)
  return item
}

function detailName(wrapper: VueWrapper): string {
  return detailItem(wrapper, '名稱').find<HTMLInputElement>('input').element.value
}

async function setDetailName(wrapper: VueWrapper, value: string): Promise<void> {
  await detailItem(wrapper, '名稱').find('input').setValue(value)
  await settle()
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

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function dialogItem(label: string): DOMWrapper<Element> {
  const item = dialog()
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text().trim() === label)
  if (!item) throw new Error(`dialog 找不到欄位 ${label}`)
  return item
}

/** ElMessageBox 下一個 tick 才渲染；已關閉的仍可能留在 DOM，取最後一個 */
async function answerMessageBox(text: string): Promise<void> {
  await settle()
  const box = Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
  const btn = Array.from(box?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`message box 找不到「${text}」`)
  btn.click()
  await settle()
  await settle()
}

describe('RolesView', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
    mock.onGet(CATALOG_URL).reply(200, CATALOG)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('RolesView selects role from query', async () => {
    mock.onGet(ROLES_URL).reply(200, rolesFixture())
    const { wrapper } = await mountView('/settings/roles?role=clerk')

    expect(mock.history.get.map((c) => c.url).sort()).toEqual([CATALOG_URL, ROLES_URL])
    expect(selectedCardName(wrapper)).toBe('行政')
    expect(detailName(wrapper)).toBe('行政')
    // 左欄卡片含員工數（showStaffCount）
    expect(wrapper.find('.role-card.is-selected').text()).toContain('1 位員工')
  })

  it('RolesView defaults to first sorted role', async () => {
    mock.onGet(ROLES_URL).reply(200, rolesFixture())
    const { wrapper, router } = await mountView()

    expect(cardNames(wrapper)).toEqual(['管理員', '主任', '行政', '課輔老師', '週六支援老師'])
    expect(selectedCardName(wrapper)).toBe('管理員')
    expect(detailName(wrapper)).toBe('管理員')

    // 不存在的 code 也退回第一個
    await router.push('/settings/roles?role=nope')
    await settle()
    expect(selectedCardName(wrapper)).toBe('管理員')
  })

  it('RolesView updates query when selecting', async () => {
    mock.onGet(ROLES_URL).reply(200, rolesFixture())
    const { wrapper, router } = await mountView('/settings/roles?role=clerk')

    await clickCard(wrapper, '課輔老師')

    expect(router.currentRoute.value.query.role).toBe('tutor')
    expect(selectedCardName(wrapper)).toBe('課輔老師')
    expect(detailName(wrapper)).toBe('課輔老師')
  })

  it('RolesView guards unsaved changes on switch', async () => {
    mock.onGet(ROLES_URL).reply(200, rolesFixture())
    const { wrapper, router } = await mountView('/settings/roles?role=clerk')
    await setDetailName(wrapper, '資深行政')

    await clickCard(wrapper, '課輔老師')
    expect(document.body.textContent).toContain('尚未儲存的變更將會遺失')
    await answerMessageBox('繼續編輯')

    expect(router.currentRoute.value.query.role).toBe('clerk')
    expect(selectedCardName(wrapper)).toBe('行政')
    expect(detailName(wrapper)).toBe('資深行政')

    await clickCard(wrapper, '課輔老師')
    await answerMessageBox('放棄變更')
    expect(router.currentRoute.value.query.role).toBe('tutor')
    expect(detailName(wrapper)).toBe('課輔老師')
  })

  it('RolesView guards unsaved changes on route leave', async () => {
    mock.onGet(ROLES_URL).reply(200, rolesFixture())
    const { wrapper, router } = await mountView('/settings/roles?role=clerk')
    await setDetailName(wrapper, '資深行政')

    const leaving = router.push('/students')
    await settle()
    expect(document.body.textContent).toContain('尚未儲存的變更將會遺失')
    await answerMessageBox('繼續編輯')
    await leaving

    expect(router.currentRoute.value.path).toBe('/settings/roles')
    expect(detailName(wrapper)).toBe('資深行政')
  })

  it('RolesView reloads after create', async () => {
    const created = makeRole({
      id: 'r-new',
      code: 'senior_tutor',
      name: '資深老師',
      is_system: false,
      staff_count: 0,
      effective_permissions: ['pickup:read'],
    })
    mock.onGet(ROLES_URL).replyOnce(200, rolesFixture())
    mock.onGet(ROLES_URL).replyOnce(200, [...rolesFixture(), created])
    mock.onPost(ROLES_URL).reply(201, created)
    const { wrapper, router } = await mountView('/settings/roles?role=clerk')

    await click(wrapper.find('.page-header'), '新增角色')
    await dialogItem('代碼').find('input').setValue('senior_tutor')
    await dialogItem('名稱').find('input').setValue('資深老師')
    await click(dialog().find('.el-dialog__footer'), '建立')
    await settle()

    expect(mock.history.post).toHaveLength(1)
    expect(rolesRequests()).toBe(2)
    expect(router.currentRoute.value.query.role).toBe('senior_tutor')
    expect(selectedCardName(wrapper)).toBe('資深老師')
    expect(detailName(wrapper)).toBe('資深老師')
  })

  it('RolesView reloads after save', async () => {
    const renamed = { ...rolesFixture().find((r) => r.code === 'clerk')!, name: '資深行政', updated_at: '2026-10-16T01:00:00Z' }
    mock.onGet(ROLES_URL).replyOnce(200, rolesFixture())
    mock.onGet(ROLES_URL).replyOnce(200, rolesFixture().map((r) => (r.code === 'clerk' ? renamed : r)))
    mock.onPatch('/admin/roles/r-clerk').reply(200, renamed)
    const { wrapper, router } = await mountView('/settings/roles?role=clerk')

    await setDetailName(wrapper, '資深行政')
    await click(wrapper.find('.role-detail'), '儲存')
    await settle()

    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({ name: '資深行政' })
    expect(rolesRequests()).toBe(2)
    expect(cardNames(wrapper)).toContain('資深行政')
    expect(router.currentRoute.value.query.role).toBe('clerk')
    expect(wrapper.find('.role-detail').text()).not.toContain('未儲存')
  })

  it('RolesView reloads after delete and selects first role', async () => {
    mock.onGet(ROLES_URL).replyOnce(200, rolesFixture())
    mock.onGet(ROLES_URL).replyOnce(
      200,
      rolesFixture().filter((r) => r.code !== 'weekend_helper'),
    )
    mock.onDelete('/admin/roles/r-weekend_helper').reply(204)
    const { wrapper, router } = await mountView('/settings/roles?role=weekend_helper')

    await click(wrapper.find('.role-detail'), '刪除角色')
    await answerMessageBox('刪除')

    expect(mock.history.delete).toHaveLength(1)
    expect(rolesRequests()).toBe(2)
    expect(cardNames(wrapper)).not.toContain('週六支援老師')
    expect(router.currentRoute.value.query.role).toBe('admin')
    expect(selectedCardName(wrapper)).toBe('管理員')
  })

  it('RolesView hides create button without roles write', async () => {
    mock.onGet(ROLES_URL).reply(200, rolesFixture())
    const { wrapper } = await mountView('/settings/roles', ['roles:read', 'staff:read'])

    expect(wrapper.find('h1').text()).toBe('角色權限')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe(
      '設定每個角色可以使用的功能；員工的個別調整在「員工帳號」頁',
    )
    expect(button(wrapper, '新增角色')).toBeUndefined()
    expect(wrapper.find('.role-detail').text()).toContain('你只有檢視權限')
  })

  it('RolesView shows skeleton while loading', async () => {
    let release: (() => void) | undefined
    mock.onGet(ROLES_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, rolesFixture()])
        }),
    )
    const { wrapper } = await mountView()

    expect(wrapper.find('[data-test=roles-count]').text()).toBe('角色（—）')
    expect(wrapper.findAll('.el-skeleton').length).toBe(2)
    expect(wrapper.find('.role-card').exists()).toBe(false)
    expect(button(wrapper, '新增角色')?.attributes('disabled')).toBeDefined()

    release?.()
    await settle()
    expect(wrapper.find('[data-test=roles-count]').text()).toBe('角色（5）')
    expect(wrapper.find('.el-skeleton').exists()).toBe(false)
    expect(button(wrapper, '新增角色')?.attributes('disabled')).toBeUndefined()
  })

  it('RolesView shows retry on load failure', async () => {
    mock.onGet(ROLES_URL).replyOnce(500, { error: { code: 'internal_error', message: '伺服器發生錯誤' } })
    mock.onGet(ROLES_URL).replyOnce(200, rolesFixture())
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入角色')
    expect(wrapper.find('.role-card').exists()).toBe(false)

    await click(wrapper, '重試')

    expect(rolesRequests()).toBe(2)
    expect(wrapper.text()).not.toContain('無法載入角色')
    expect(cardNames(wrapper)).toHaveLength(5)
  })

  it('RolesView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.RolesView()) as { default?: unknown }

    expect(loaded.default).toBe(RolesView)
  })
})
