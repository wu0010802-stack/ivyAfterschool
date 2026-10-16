import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { StaffAuthorization, VerifyResult } from '@/api/pickupAuthorizations'
import type { PickupRequest } from '@/api/pickupRequests'
import { createApiMock, mountWithApp } from '@/test/helpers'
import dialogSource from './AuthorizationVerifyDialog.vue?raw'
import AuthorizationVerifyDialog from './AuthorizationVerifyDialog.vue'

const VERIFY_URL = '/admin/pickup/authorizations/pa1/verify'
const VISUAL_URL = '/admin/pickup/authorizations/pa1/confirm-visual-match'
const OVERRIDE_URL = '/admin/pickup/authorizations/pa1/override-complete'
const PHOTO = 'https://storage/p.jpg'

function makeAuthorization(overrides: Partial<StaffAuthorization> = {}): StaffAuthorization {
  return {
    id: 'pa1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 3, class_id: 'c3', class_name: '中年級班' },
    student_id: 's1',
    service_date: '2026-10-02',
    pickup_person_id: null,
    proxy_name: '陳阿姨',
    proxy_phone: '0912-000-456',
    code_last4: '4821',
    status: 'active',
    effective_status: 'active',
    verified_at: null,
    verification_method: null,
    created_at: '2026-10-02T00:00:00Z',
    photo_url: null,
    code_attempts: 0,
    locked: false,
    verified_by_name: null,
    ...overrides,
  }
}

function makeRequest(overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id: 'r1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 3, class_id: 'c3', class_name: '中年級班' },
    service_date: '2026-10-02',
    source: 'proxy',
    requested_by_type: 'staff',
    requested_by_name: '陳老師',
    expected_arrival_at: null,
    status: 'completed',
    homework_status_at_request: 'done',
    current_homework_status: 'done',
    current_ready_eta: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    replied_by_name: null,
    needs_reply: false,
    arrived_at: null,
    completed_at: '2026-10-02T09:12:00Z',
    completed_by_name: '陳老師',
    completion_method: 'code',
    picked_up_by_name: '陳阿姨',
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-10-02T09:12:00Z',
    ...overrides,
  }
}

function verifyResult(method: 'code' | 'visual_match' | 'override'): VerifyResult {
  return {
    authorization: makeAuthorization({
      status: 'completed',
      effective_status: 'completed',
      verification_method: method,
      verified_by_name: '陳老師',
      verified_at: '2026-10-02T09:12:00Z',
    }),
    request: makeRequest({ completion_method: method }),
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

/** el-form-item 的錯誤訊息有 100ms debounce，斷言錯誤文字前等過 */
async function settleErrors(): Promise<void> {
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 150))
  await settle()
}

async function mountDialog(
  authorization: StaffAuthorization = makeAuthorization(),
  canOverride = true,
): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(AuthorizationVerifyDialog, {
    props: { modelValue: true, authorization, canOverride },
  })
  await settle()
  await settle()
  return wrapper as VueWrapper
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function dialogText(): string {
  return dialog().text()
}

function digitInputs(): DOMWrapper<HTMLInputElement>[] {
  return dialog().findAll<HTMLInputElement>('input.code-box')
}

function digitValues(): string[] {
  return digitInputs().map((i) => i.element.value)
}

async function typeDigit(index: number, value: string): Promise<void> {
  await digitInputs()[index]!.setValue(value)
  await settle()
}

async function paste(index: number, text: string): Promise<void> {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
  digitInputs()[index]!.element.dispatchEvent(event)
  await settle()
  await settle()
}

function tabTitles(): string[] {
  return dialog()
    .findAll('.el-tabs__item')
    .map((t) => t.text().trim())
}

function activeTab(): string {
  return dialog().find('.el-tabs__item.is-active').text().trim()
}

async function switchTab(title: string): Promise<void> {
  const tab = dialog()
    .findAll('.el-tabs__item')
    .find((t) => t.text().trim() === title)
  if (!tab) throw new Error(`找不到分頁「${title}」`)
  await tab.trigger('click')
  await settle()
  await settle()
}

/** dialog 內有文字的按鈕（排除標題列的 X） */
function textButtons(): string[] {
  return dialog()
    .findAll('button')
    .map((b) => b.text().trim())
    .filter(Boolean)
}

function footerButton(text: string): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text().trim() === text)
  if (!btn) throw new Error(`footer 找不到「${text}」`)
  return btn
}

async function clickButton(text: string): Promise<void> {
  const btn = dialog()
    .findAll('button')
    .find((b) => b.text().trim() === text)
  if (!btn) throw new Error(`找不到「${text}」`)
  await btn.trigger('click')
  await settle()
  await settle()
}

function postBody(url: string): Record<string, unknown> {
  const call = mock.history.post.find((c) => c.url === url)
  if (!call) throw new Error(`沒有 POST ${url}`)
  return JSON.parse(call.data as string) as Record<string, unknown>
}

async function fillTextarea(placeholder: string, value: string): Promise<void> {
  const area = dialog()
    .findAll<HTMLTextAreaElement>('textarea')
    .find((t) => t.attributes('placeholder') === placeholder)
  if (!area) throw new Error(`找不到 textarea「${placeholder}」`)
  await area.setValue(value)
  await settle()
}

describe('AuthorizationVerifyDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('AuthorizationVerifyDialog auto submits six digit code', async () => {
    mock.onPost(VERIFY_URL).reply(200, verifyResult('code'))
    const wrapper = await mountDialog()

    expect(dialog().find('.el-dialog__title').text()).toBe('核驗代理接送：陳阿姨')
    expect(dialogText()).toContain('王小明（中年級班）')
    expect(dialogText()).toContain('陳阿姨・0912-000-456')
    expect(dialogText()).toContain('4821')
    expect(dialogText()).toContain('尚無錯誤（連續錯誤 5 次會鎖定）')
    expect(activeTab()).toBe('接送碼')
    expect(digitInputs()).toHaveLength(6)
    expect(digitInputs()[0]?.attributes('inputmode')).toBe('numeric')
    expect(document.activeElement).toBe(digitInputs()[0]?.element)
    expect(footerButton('核驗接送碼').attributes('disabled')).toBeDefined()

    await paste(0, '123456')

    expect(mock.history.post).toHaveLength(1)
    expect(postBody(VERIFY_URL)).toEqual({ code: '123456' })
    expect(dialogText()).toContain('已完成接送：王小明 由 陳阿姨 接走（接送碼核驗）')
    expect(dialogText()).toContain('已通知家長，出勤已記錄離班。')
    expect(wrapper.emitted('verified')).toHaveLength(1)
    expect((wrapper.emitted('verified') as [VerifyResult][])[0]?.[0].authorization.effective_status).toBe('completed')
    // 成功畫面取代整個內容：沒有分頁與 footer，只剩「關閉」
    expect(dialog().find('.el-tabs').exists()).toBe(false)
    expect(textButtons()).toEqual(['關閉'])

    await clickButton('關閉')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('AuthorizationVerifyDialog types digits with auto advance and ignores separators', async () => {
    mock.onPost(VERIFY_URL).reply(200, verifyResult('code'))
    await mountDialog()

    await typeDigit(0, '1')
    expect(document.activeElement).toBe(digitInputs()[1]?.element)
    await typeDigit(1, 'a')
    expect(digitValues()).toEqual(['1', '', '', '', '', ''])
    expect(document.activeElement).toBe(digitInputs()[1]?.element)

    // Backspace 在空格：回上一格並清掉
    await digitInputs()[1]!.trigger('keydown', { key: 'Backspace' })
    await settle()
    expect(digitValues()).toEqual(['', '', '', '', '', ''])
    expect(document.activeElement).toBe(digitInputs()[0]?.element)

    // 貼上含空白與「-」的整串
    await paste(0, '12 3-4 56')
    expect(postBody(VERIFY_URL)).toEqual({ code: '123456' })
  })

  it('AuthorizationVerifyDialog shows remaining attempts on mismatch', async () => {
    mock.onPost(VERIFY_URL).reply(400, {
      error: { code: 'pickup_code_mismatch', message: '接送碼錯誤', details: { remaining_attempts: 2 } },
    })
    const wrapper = await mountDialog(makeAuthorization({ code_attempts: 2 }))
    expect(dialogText()).toContain('已錯誤 2 次，還可嘗試 3 次')

    await paste(0, '000000')

    expect(dialogText()).toContain('接送碼錯誤，還可嘗試 2 次')
    expect(digitValues()).toEqual(['', '', '', '', '', ''])
    expect(dialog().find('.code-boxes').classes()).toContain('is-error')
    expect(dialogText()).toContain('已錯誤 3 次，還可嘗試 2 次')
    expect(document.activeElement).toBe(digitInputs()[0]?.element)
    expect(wrapper.emitted('verified')).toBeUndefined()
    expect(dialog().find('.el-tabs').exists()).toBe(true)
  })

  it('AuthorizationVerifyDialog locks after locked error', async () => {
    mock.onPost(VERIFY_URL).reply(409, {
      error: { code: 'pickup_code_locked', message: '接送碼已鎖定', details: null },
    })
    const withOverride = await mountDialog(makeAuthorization({ code_attempts: 4 }), true)
    await paste(0, '000000')

    expect(dialogText()).toContain('接送碼已連續錯誤 5 次而鎖定')
    expect(dialogText()).toContain('已切換到「主管強制完成」。')
    expect(dialogText()).toContain('已錯誤 5 次，已鎖定')
    expect(activeTab()).toBe('主管強制完成')
    expect(footerButton('強制完成').attributes('disabled')).toBeUndefined()
    const disabledTabs = dialog()
      .findAll('.el-tabs__item.is-disabled')
      .map((t) => t.text().trim())
    expect(disabledTabs).toEqual(['接送碼', '目視核對'])
    expect(withOverride.emitted('verified')).toBeUndefined()
    withOverride.unmount()
    document.body.innerHTML = ''

    await mountDialog(makeAuthorization({ code_attempts: 4 }), false)
    await paste(0, '000000')

    expect(dialogText()).toContain('接送碼已連續錯誤 5 次而鎖定')
    expect(dialogText()).toContain('請聯絡主任以強制完成')
    expect(tabTitles()).toEqual(['接送碼', '目視核對'])
    expect(textButtons()).toEqual(['關閉'])
    expect(dialog().find('.el-dialog__footer').exists()).toBe(false)
  })

  it('AuthorizationVerifyDialog opens locked authorization on override tab', async () => {
    const wrapper = await mountDialog(makeAuthorization({ locked: true, code_attempts: 5 }), true)
    expect(activeTab()).toBe('主管強制完成')
    expect(dialogText()).toContain('接送碼已連續錯誤 5 次而鎖定')
    expect(dialogText()).toContain('已錯誤 5 次，已鎖定')
    expect(footerButton('強制完成').exists()).toBe(true)
    wrapper.unmount()
    document.body.innerHTML = ''

    const reader = await mountDialog(makeAuthorization({ locked: true, code_attempts: 5 }), false)
    expect(dialogText()).toContain('請聯絡主任以強制完成')
    expect(textButtons()).toEqual(['關閉'])
    await clickButton('關閉')
    expect(reader.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('AuthorizationVerifyDialog visual match with and without photo', async () => {
    mock.onPost(VISUAL_URL).reply(200, verifyResult('visual_match'))
    const withPhoto = await mountDialog(makeAuthorization({ photo_url: PHOTO }))
    await switchTab('目視核對')
    expect(activeTab()).toBe('目視核對')
    expect(dialog().find('.vd-visual img').attributes('src')).toBe(PHOTO)
    expect(dialogText()).toContain('請比對照片與到場人員')
    expect(dialogText()).not.toContain('此代理人沒有照片')
    expect(dialogText()).toContain('會記錄於稽核紀錄')
    expect(footerButton('已核對，完成交付').attributes('disabled')).toBeUndefined()
    withPhoto.unmount()
    document.body.innerHTML = ''

    const noPhoto = await mountDialog(makeAuthorization({ photo_url: null }))
    await switchTab('目視核對')
    expect(dialog().find('.vd-visual img').exists()).toBe(false)
    expect(dialogText()).toContain('此代理人沒有照片，請核對身分證件上的姓名：陳阿姨')

    await fillTextarea('例如：已核對身分證', '已核對身分證')
    await clickButton('已核對，完成交付')

    expect(mock.history.post.map((c) => c.url)).toEqual([VISUAL_URL])
    expect(postBody(VISUAL_URL)).toEqual({ note: '已核對身分證' })
    expect(dialogText()).toContain('已完成接送：王小明 由 陳阿姨 接走（目視核對）')
    expect(noPhoto.emitted('verified')).toHaveLength(1)
  })

  it('AuthorizationVerifyDialog treats broken photo as no photo', async () => {
    await mountDialog(makeAuthorization({ photo_url: PHOTO }))
    await switchTab('目視核對')
    expect(dialog().find('.vd-visual img').attributes('src')).toBe(PHOTO)

    await dialog().find('.vd-visual img').trigger('error')
    await settle()

    expect(dialog().find('.vd-visual img').exists()).toBe(false)
    expect(dialogText()).toContain('此代理人沒有照片，請核對身分證件上的姓名：陳阿姨')
  })

  it('AuthorizationVerifyDialog override requires note', async () => {
    mock.onPost(OVERRIDE_URL).reply(200, verifyResult('override'))
    const wrapper = await mountDialog(makeAuthorization(), true)
    expect(tabTitles()).toEqual(['接送碼', '目視核對', '主管強制完成'])

    await switchTab('主管強制完成')
    expect(dialogText()).toContain('接送碼與目視核對都無法完成時')
    await clickButton('強制完成')
    await settleErrors()
    expect(dialogText()).toContain('請填寫備註')
    expect(mock.history.post).toHaveLength(0)

    await fillTextarea('例如：已電話向家長確認', '已電話向家長確認')
    await settleErrors()
    expect(dialogText()).not.toContain('請填寫備註')
    await clickButton('強制完成')

    expect(mock.history.post.map((c) => c.url)).toEqual([OVERRIDE_URL])
    expect(postBody(OVERRIDE_URL)).toEqual({ note: '已電話向家長確認' })
    expect(dialogText()).toContain('已完成接送：王小明 由 陳阿姨 接走（強制完成）')
    expect(wrapper.emitted('verified')).toHaveLength(1)
  })

  it('AuthorizationVerifyDialog hides override tab without permission', async () => {
    await mountDialog(makeAuthorization(), false)
    expect(tabTitles()).toEqual(['接送碼', '目視核對'])
    expect(dialogText()).not.toContain('主管強制完成')
    expect(footerButton('核驗接送碼').exists()).toBe(true)
  })

  it('AuthorizationVerifyDialog shows backend message for other errors', async () => {
    mock.onPost(VERIFY_URL).reply(409, {
      error: { code: 'authorization_not_active', message: '此代理接送授權已完成或已取消', details: null },
    })
    const wrapper = await mountDialog()
    await paste(0, '123456')

    expect(dialogText()).toContain('此代理接送授權已完成或已取消')
    expect(dialog().find('.el-alert--error').exists()).toBe(true)
    // 表單保留、沒有鎖定提示、沒有成功畫面
    expect(dialog().find('.el-tabs').exists()).toBe(true)
    expect(dialogText()).not.toContain('而鎖定')
    expect(dialogText()).not.toContain('已完成接送')
    expect(wrapper.emitted('verified')).toBeUndefined()
  })

  it('AuthorizationVerifyDialog resets state when reopened for another authorization', async () => {
    mock.onPost(VERIFY_URL).reply(400, {
      error: { code: 'pickup_code_mismatch', message: '接送碼錯誤', details: { remaining_attempts: 4 } },
    })
    const wrapper = await mountDialog()
    await paste(0, '000000')
    expect(dialogText()).toContain('接送碼錯誤，還可嘗試 4 次')
    await switchTab('目視核對')

    await wrapper.setProps({ modelValue: false })
    await settle()
    await wrapper.setProps({
      modelValue: true,
      authorization: makeAuthorization({ id: 'pa2', proxy_name: '林阿姨', code_last4: '1185' }),
    })
    await settle()
    await settle()

    expect(dialog().find('.el-dialog__title').text()).toBe('核驗代理接送：林阿姨')
    expect(activeTab()).toBe('接送碼')
    expect(dialogText()).not.toContain('接送碼錯誤')
    expect(dialogText()).toContain('尚無錯誤')
    expect(digitValues()).toEqual(['', '', '', '', '', ''])
  })

  it('AuthorizationVerifyDialog keeps touch sizes for code boxes and tabs', async () => {
    // happy-dom 不計算版面：以原始碼斷言接送碼格 52×60、分頁 48px、關閉鈕 44px
    expect(dialogSource).toMatch(/\.code-box\s*{[^}]*width:\s*52px/)
    expect(dialogSource).toMatch(/\.code-box\s*{[^}]*height:\s*60px/)
    expect(dialogSource).toMatch(/\.vd-tabs[^{]*\.el-tabs__item\s*{[^}]*height:\s*48px/)
    expect(dialogSource).toMatch(/\.vd-close[^{]*{[^}]*min-height:\s*44px/)
    await mountDialog()
    expect(dialog().findAll('.code-box.is-gap')).toHaveLength(1)
  })
})
