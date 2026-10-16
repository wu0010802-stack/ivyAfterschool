import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { PermissionCatalog, Role } from '@/api/roles'
import type { StaffUser } from '@/api/staffUsers'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StaffUserFormDialog from './StaffUserFormDialog.vue'

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
    {
      key: 'students',
      label: '班級與學生',
      permissions: [{ code: 'students:read', label: '查看學生' }],
    },
    {
      key: 'leaves',
      label: '請假',
      permissions: [
        { code: 'leaves:read', label: '查請假' },
        { code: 'leaves:write', label: '代登記與取消請假' },
      ],
    },
    {
      key: 'pickup',
      label: '接送',
      permissions: [
        { code: 'pickup:read', label: '查看接送佇列' },
        { code: 'pickup:override', label: '代理接送強制完成' },
      ],
    },
  ],
}
const ALL_CODES = CATALOG.groups.flatMap((g) => g.permissions.map((p) => p.code)).sort()

function makeRole(code: string, name: string, effective: string[]): Role {
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

const ROLES: Role[] = [
  makeRole('director', '主任', ['roles:read', 'roles:write', 'staff:read', 'students:read', 'leaves:read', 'leaves:write']),
  makeRole('clerk', '行政', ['leaves:read', 'leaves:write', 'students:read']),
  makeRole('tutor', '課輔老師', ['students:read']),
]

function makeUser(overrides: Partial<StaffUser> = {}): StaffUser {
  return {
    id: 'u2',
    username: 'tutor01',
    display_name: '陳師',
    phone: '0912-000-123',
    email: null,
    role: { id: 'r-tutor', code: 'tutor', name: '課輔老師' },
    extra_permissions: [],
    revoked_permissions: [],
    effective_permissions: ['students:read'],
    is_active: true,
    must_change_password: false,
    last_login_at: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

/** el-form-item 的錯誤訊息有 100ms debounce，斷言錯誤文字前等過 */
async function settleErrors(): Promise<void> {
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 150))
  await settle()
}

async function mountDialog(
  options: { user?: StaffUser; permissions?: string[]; selfId?: string } = {},
): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(StaffUserFormDialog, {
    props: { modelValue: true, user: options.user, roles: ROLES, catalog: CATALOG },
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: options.selfId ?? 'u1',
          username: 'admin01',
          display_name: '系統管理員',
          role: { id: 'r-admin', code: 'admin', name: '管理員' },
          permissions: options.permissions ?? ALL_CODES,
          must_change_password: false,
        },
      },
    },
  })
  await settle()
  return wrapper as VueWrapper
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function formItem(label: string): DOMWrapper<Element> {
  const item = dialog()
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text().trim() === label)
  if (!item) throw new Error(`找不到欄位 ${label}`)
  return item
}

async function fill(label: string, value: string): Promise<void> {
  await formItem(label).find('input').setValue(value)
  await settle()
}

async function pickRole(name: string): Promise<void> {
  const card = dialog()
    .findAll('.role-card')
    .find((c) => c.find('.role-card__name').text() === name)
  if (!card) throw new Error(`找不到角色卡 ${name}`)
  await card.trigger('click')
  await settle()
}

function adjustHead(): DOMWrapper<Element> {
  return dialog().find('[data-test=adjust-head]')
}

async function openAdjust(): Promise<void> {
  if (adjustHead().attributes('aria-expanded') !== 'true') {
    await adjustHead().trigger('click')
    await settle()
  }
}

function permCheckbox(code: string): DOMWrapper<HTMLInputElement> {
  const item = dialog()
    .findAll('.perm-item')
    .find((i) => i.find('.perm-item__code').text() === code)
  if (!item) throw new Error(`找不到權限 ${code}`)
  return item.find<HTMLInputElement>('input[type=checkbox]')
}

function submitButton(): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .at(-1)
  if (!btn) throw new Error('找不到送出鈕')
  return btn
}

async function submit(): Promise<void> {
  await submitButton().trigger('click')
  await settle()
}

async function clickFooter(text: string): Promise<void> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到「${text}」`)
  await btn.trigger('click')
  await settle()
  await settle()
}

function body(method: 'post' | 'patch', index = 0): Record<string, unknown> {
  const call = mock.history[method][index]
  if (!call) throw new Error(`沒有第 ${index + 1} 個 ${method}`)
  return JSON.parse(call.data as string) as Record<string, unknown>
}

describe('StaffUserFormDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('StaffUserFormDialog creates user with role', async () => {
    const created = makeUser({ id: 'u9', username: 'tutor02', display_name: '陳老師', phone: null })
    mock.onPost('/admin/staff-users').reply(201, { user: created, temp_password: 'Tmp-x' })
    const wrapper = await mountDialog()

    expect(dialog().find('.el-dialog__title').text()).toBe('新增員工')
    expect(submitButton().text()).toBe('建立')
    await fill('帳號', 'tutor02')
    await fill('姓名', '陳老師')
    await pickRole('課輔老師')
    await submit()

    expect(mock.history.post[0]?.url).toBe('/admin/staff-users')
    expect(body('post')).toEqual({
      username: 'tutor02',
      display_name: '陳老師',
      phone: null,
      email: null,
      role_id: 'r-tutor',
      extra_permissions: [],
      revoked_permissions: [],
    })
    const emitted = wrapper.emitted('created') as [{ user: StaffUser; temp_password: string }][]
    expect(emitted).toHaveLength(1)
    expect(emitted[0]![0].temp_password).toBe('Tmp-x')
    expect(emitted[0]![0].user.id).toBe('u9')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('StaffUserFormDialog lowercases username and validates fields', async () => {
    const wrapper = await mountDialog()

    await fill('帳號', 'Tutor02')
    expect(formItem('帳號').find<HTMLInputElement>('input').element.value).toBe('tutor02')

    await fill('帳號', 'ab')
    await fill('Email', 'chen@')
    await submit()
    await settleErrors()

    expect(formItem('帳號').find('.el-form-item__error').text()).toBe('3~30 碼，只能使用小寫英文、數字與 . _ -')
    expect(formItem('姓名').find('.el-form-item__error').text()).toBe('請輸入姓名')
    expect(formItem('Email').find('.el-form-item__error').text()).toBe('Email 格式不正確')
    expect(dialog().find('[data-test=role-error]').text()).toBe('請選擇角色')
    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('created')).toBeUndefined()

    await fill('帳號', '')
    await submit()
    await settleErrors()
    expect(formItem('帳號').find('.el-form-item__error').text()).toBe('請輸入帳號')
  })

  it('StaffUserFormDialog derives extra and revoked from picker', async () => {
    mock.onPost('/admin/staff-users').reply(201, { user: makeUser(), temp_password: 'Tmp-y' })
    await mountDialog()
    expect(adjustHead().attributes('disabled')).toBeDefined()
    expect(adjustHead().text()).toContain('請先選擇角色')

    await fill('帳號', 'clerk02')
    await fill('姓名', '林行政')
    await pickRole('行政')
    expect(adjustHead().text()).toContain('與角色預設相同')
    // 預設收合
    expect(dialog().find('.perm-picker').exists()).toBe(false)

    await openAdjust()
    expect(permCheckbox('leaves:write').element.checked).toBe(true)
    await permCheckbox('leaves:write').setValue(false)
    await permCheckbox('pickup:override').setValue(true)
    await settle()

    expect(adjustHead().text()).toContain('額外授予 1 項、移除 1 項')
    const diff = dialog().find('[data-test=adjust-diff]').text()
    expect(diff).toContain('＋ 代理接送強制完成')
    expect(diff).toContain('－ 代登記與取消請假')

    await submit()
    expect(body('post').revoked_permissions).toEqual(['leaves:write'])
    expect(body('post').extra_permissions).toEqual(['pickup:override'])
    expect(body('post').role_id).toBe('r-clerk')
  })

  it('StaffUserFormDialog keeps meaningful adjustments when switching role', async () => {
    await mountDialog()
    await pickRole('行政')
    await openAdjust()
    await permCheckbox('leaves:write').setValue(false)
    await permCheckbox('pickup:override').setValue(true)
    await settle()

    // 主任也有 leaves:write → 移除保留；pickup:override 主任沒有 → 額外授予保留
    await pickRole('主任')
    expect(permCheckbox('leaves:write').element.checked).toBe(false)
    expect(permCheckbox('pickup:override').element.checked).toBe(true)
    expect(permCheckbox('roles:write').element.checked).toBe(true)
    expect(adjustHead().text()).toContain('額外授予 1 項、移除 1 項')

    // 課輔老師沒有 leaves:write → 那筆移除失去意義，回到新角色預設
    await pickRole('課輔老師')
    expect(permCheckbox('leaves:write').element.checked).toBe(false)
    expect(permCheckbox('pickup:override').element.checked).toBe(true)
    expect(permCheckbox('students:read').element.checked).toBe(true)
    expect(adjustHead().text()).toContain('額外授予 1 項、移除 0 項')
  })

  it('StaffUserFormDialog edits only changed fields', async () => {
    const updated = makeUser({ display_name: '陳老師' })
    mock.onPatch('/admin/staff-users/u2').reply(200, updated)
    const wrapper = await mountDialog({ user: makeUser() })

    expect(dialog().find('.el-dialog__title').text()).toBe('編輯員工：陳師')
    expect(submitButton().text()).toBe('儲存')
    expect(formItem('帳號').find('input').exists()).toBe(false)
    expect(formItem('帳號').text()).toContain('tutor01')
    expect(submitButton().attributes('disabled')).toBeDefined()

    await fill('姓名', '陳老師')
    expect(submitButton().attributes('disabled')).toBeUndefined()
    await submit()

    expect(mock.history.patch[0]?.url).toBe('/admin/staff-users/u2')
    expect(body('patch')).toEqual({ display_name: '陳老師' })
    expect((wrapper.emitted('updated') as [StaffUser][])[0]![0].display_name).toBe('陳老師')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('StaffUserFormDialog edits permissions and clears contact fields', async () => {
    const user = makeUser({
      role: { id: 'r-clerk', code: 'clerk', name: '行政' },
      email: 'chen@example.com',
      extra_permissions: ['pickup:override'],
      effective_permissions: ['leaves:read', 'leaves:write', 'pickup:override', 'students:read'],
    })
    mock.onPatch('/admin/staff-users/u2').reply(200, user)
    await mountDialog({ user })

    // 有個別調整的帳號預設展開
    expect(adjustHead().attributes('aria-expanded')).toBe('true')
    expect(adjustHead().text()).toContain('額外授予 1 項、移除 0 項')

    await fill('電話', '')
    await fill('Email', '')
    await permCheckbox('leaves:write').setValue(false)
    await settle()
    await submit()

    expect(body('patch')).toEqual({ phone: null, email: null, revoked_permissions: ['leaves:write'] })
  })

  it('StaffUserFormDialog blocks self permission edit', async () => {
    await mountDialog({ user: makeUser({ id: 'u1' }), selfId: 'u1' })

    expect(dialog().text()).toContain('不可修改自己的權限')
    const cards = dialog().findAll('.role-card')
    expect(cards.length).toBe(3)
    expect(cards.every((c) => c.attributes('aria-disabled') === 'true')).toBe(true)

    await openAdjust()
    const boxes = dialog().findAll<HTMLInputElement>('.perm-picker input[type=checkbox]')
    expect(boxes.length).toBeGreaterThan(0)
    expect(boxes.every((b) => b.element.disabled)).toBe(true)

    // 角色卡點了也不會換
    await pickRole('主任')
    expect(dialog().find('.role-card.is-selected .role-card__name').text()).toBe('課輔老師')
  })

  it('StaffUserFormDialog maps backend errors', async () => {
    mock
      .onPost('/admin/staff-users')
      .replyOnce(409, { error: { code: 'username_taken', message: '帳號已存在', details: null } })
      .onPost('/admin/staff-users')
      .replyOnce(403, {
        error: { code: 'cannot_grant_permissions', message: '無法授出權限', details: { permissions: ['staff:write'] } },
      })
    const wrapper = await mountDialog()
    await fill('帳號', 'tutor02')
    await fill('姓名', '陳老師')
    await pickRole('課輔老師')

    await submit()
    await settleErrors()
    expect(formItem('帳號').find('.el-form-item__error').text()).toBe('帳號已被使用')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    await submit()
    await settleErrors()
    const alert = dialog().find('[data-test=grant-error]')
    expect(alert.text()).toContain('你沒有以下權限，無法授出')
    expect(alert.text()).toContain('管理員工帳號')
    // 自動展開個別權限調整
    expect(adjustHead().attributes('aria-expanded')).toBe('true')
    expect(wrapper.emitted('created')).toBeUndefined()
  })

  it('StaffUserFormDialog maps validation errors to fields', async () => {
    mock.onPost('/admin/staff-users').reply(422, {
      error: {
        code: 'validation_error',
        message: '輸入資料格式錯誤',
        details: [{ loc: ['body', 'phone'], msg: '電話最多 20 字', type: 'string_too_long' }],
      },
    })
    await mountDialog()
    await fill('帳號', 'tutor02')
    await fill('姓名', '陳老師')
    await pickRole('課輔老師')

    await submit()
    await settleErrors()

    expect(formItem('電話').find('.el-form-item__error').text()).toBe('電話最多 20 字')
  })

  it('StaffUserFormDialog confirms discard when closing with changes', async () => {
    const clean = await mountDialog({ user: makeUser() })
    await clickFooter('取消')
    expect(clean.emitted('update:modelValue')).toEqual([[false]])
    clean.unmount()
    document.body.innerHTML = ''

    const wrapper = await mountDialog({ user: makeUser() })
    await fill('姓名', '陳老師')
    await clickFooter('取消')
    expect(document.body.textContent).toContain('尚未儲存的變更將會遺失')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    const box = Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
    const discard = Array.from(box?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (b) => b.textContent?.trim() === '放棄變更',
    )
    if (!discard) throw new Error('找不到「放棄變更」')
    discard.click()
    await settle()
    await settle()
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('StaffUserFormDialog warns about ungrantable permissions', async () => {
    await mountDialog({ permissions: ['staff:read', 'staff:write', 'students:read'] })

    await pickRole('主任')
    const warn = dialog().find('[data-test=ungrantable-warning]')
    expect(warn.text()).toContain('包含你沒有的 4 項權限')
    expect(warn.text()).toContain('管理角色與權限')
    expect(warn.text()).toContain('送出時會被拒絕')

    await pickRole('課輔老師')
    expect(dialog().find('[data-test=ungrantable-warning]').exists()).toBe(false)
    expect(dialog().text()).not.toContain('包含你沒有的')
  })
})
