import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Guardian } from '@/api/guardians'
import { adminHttp } from '@/api/http'
import type { StaffAuthorization } from '@/api/pickupAuthorizations'
import { completePickupRequest, type PickupCompleteBody, type PickupRequest } from '@/api/pickupRequests'
import type { PickupBoard } from '@/composables/usePickupBoard'
import { createApiMock, mountWithApp } from '@/test/helpers'
import dialogSource from './PickupCompleteDialog.vue?raw'
import PickupCompleteDialog from './PickupCompleteDialog.vue'

const STUDENT = { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 1, class_id: 'c1', class_name: '低年級A班' }

function makeRequest(overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id: 'r1',
    student: STUDENT,
    service_date: '2026-10-02',
    source: 'parent',
    requested_by_type: 'parent',
    requested_by_name: '王媽媽',
    expected_arrival_at: '17:30',
    status: 'arrived',
    homework_status_at_request: 'in_progress',
    current_homework_status: 'done',
    current_ready_eta: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    replied_by_name: null,
    needs_reply: false,
    arrived_at: '2026-10-02T09:01:00Z',
    completed_at: null,
    completed_by_name: null,
    completion_method: null,
    picked_up_by_name: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-10-02T08:40:00Z',
    ...overrides,
  }
}

function guardian(id: string, name: string, relation: Guardian['relation'], canPickup: boolean, phone: string): Guardian {
  return {
    id,
    student_id: 's1',
    name,
    relation,
    phone,
    is_primary: id === 'g1',
    can_pickup: canPickup,
    receives_notifications: true,
    binding: { status: 'bound', parent_display_name: name, code_expires_at: null },
  }
}

const FATHER = guardian('g1', '王大明', 'father', true, '0912-000-111')
const MOTHER = guardian('g2', '林美麗', 'mother', false, '0912-000-222')
const GRANDMA = guardian('g3', '王阿嬤', 'grandparent', true, '0912-000-333')

function authorization(id: string, overrides: Partial<StaffAuthorization> = {}): StaffAuthorization {
  return {
    id,
    student: STUDENT,
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
    created_at: '2026-10-02T01:00:00Z',
    photo_url: null,
    code_attempts: 0,
    locked: false,
    verified_by_name: null,
    ...overrides,
  }
}

type CompleteBoard = Pick<PickupBoard, 'complete'>

/** 直接打 api（axios-mock-adapter 攔截）；其他錯誤 reject，與 board 的約定相同 */
const httpBoard: CompleteBoard = {
  complete: (id: string, body: PickupCompleteBody) => completePickupRequest(id, body),
}

const GUARDIANS_URL = '/admin/students/s1/guardians'
const COMPLETE_URL = '/admin/pickup/requests/r1/complete'

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountDialog(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(PickupCompleteDialog, {
    props: { modelValue: true, request: makeRequest(), authorizations: [], canOverride: false, board: httpBoard, ...props },
  })
  await settle()
  return wrapper as VueWrapper
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function option(text: string): DOMWrapper<Element> {
  const radio = dialog()
    .findAll('.el-radio')
    .find((r) => r.text().includes(text))
  if (!radio) throw new Error(`找不到選項「${text}」`)
  return radio
}

async function choose(text: string): Promise<void> {
  ;(option(text).find('input').element as HTMLInputElement).click()
  await settle()
}

function submitButton(): DOMWrapper<Element> {
  const btn = dialog().findAll('.el-dialog__footer button').at(-1)
  if (!btn) throw new Error('找不到送出鈕')
  return btn
}

async function submit(): Promise<void> {
  await submitButton().trigger('click')
  await settle()
}

const completeBodies = (): unknown[] =>
  mock.history.post.filter((r) => r.url === COMPLETE_URL).map((r) => JSON.parse(r.data as string))
const guardianLoads = (): number => mock.history.get.filter((r) => r.url === GUARDIANS_URL).length

describe('PickupCompleteDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('PickupCompleteDialog completes with guardian', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [FATHER, MOTHER])
    mock.onPost(COMPLETE_URL).reply(200, makeRequest({ status: 'completed', completion_method: 'guardian', picked_up_by_name: '王大明' }))
    const wrapper = await mountDialog()

    expect(dialog().find('.el-dialog__title').text()).toBe('完成交付：王小明')
    expect(option('王大明').text()).toContain('王大明（父親）')
    expect(option('王大明').text()).toContain('0912-000-111')
    expect(option('林美麗').classes()).toContain('is-disabled')
    expect(option('林美麗').text()).toContain('未授權接送')
    // 只有一位可接送監護人時預選
    expect(option('王大明').classes()).toContain('is-checked')
    expect(dialog().find('textarea').exists()).toBe(false)
    expect(submitButton().text()).toBe('完成交付')

    await submit()

    expect(completeBodies()).toEqual([{ method: 'guardian', guardian_id: 'g1' }])
    expect(document.body.textContent).toContain('已完成交付')
    expect((wrapper.emitted('done') as [PickupRequest][])[0]?.[0].status).toBe('completed')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('PickupCompleteDialog does not preselect when several guardians can pick up', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [FATHER, MOTHER, GRANDMA])
    mock.onPost(COMPLETE_URL).reply(200, makeRequest({ status: 'completed' }))
    await mountDialog()

    expect(dialog().findAll('.el-radio.is-checked')).toHaveLength(0)
    expect(submitButton().attributes('disabled')).toBeDefined()

    await choose('王阿嬤')
    expect(submitButton().attributes('disabled')).toBeUndefined()
    await submit()

    expect(completeBodies()).toEqual([{ method: 'guardian', guardian_id: 'g3' }])
  })

  it('PickupCompleteDialog shows a skeleton while guardians load', async () => {
    let release: () => void = () => undefined
    mock.onGet(GUARDIANS_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, [FATHER]])
        }),
    )
    await mountDialog()

    expect(dialog().find('.el-skeleton').exists()).toBe(true)
    expect(dialog().findAll('.el-radio')).toHaveLength(0)
    expect(submitButton().attributes('disabled')).toBeDefined()

    release()
    await settle()
    expect(dialog().find('.el-skeleton').exists()).toBe(false)
    expect(option('王大明').classes()).toContain('is-checked')
  })

  it('PickupCompleteDialog routes proxy to verification', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [FATHER])
    const authorizations = [
      authorization('pa1'),
      authorization('pa2', { student_id: 's2', proxy_name: '別班的代理人' }),
      authorization('pa3', { status: 'completed', effective_status: 'completed', proxy_name: '已接走的代理人' }),
    ]
    const wrapper = await mountDialog({ authorizations })

    const text = dialog().text()
    expect(text).toContain('代理接送（今日授權）')
    expect(option('陳阿姨').text()).toContain('代理：陳阿姨（0912-000-456）')
    expect(option('陳阿姨').text()).toContain('末四碼 4821')
    expect(text).not.toContain('別班的代理人')
    expect(text).not.toContain('已接走的代理人')

    await choose('陳阿姨')
    expect(submitButton().text()).toBe('前往核驗')
    expect(dialog().text()).toContain('按「前往核驗」到代理接送核驗頁，核對接送碼或代理人身分後完成交付。')
    expect(dialog().text()).not.toContain('此授權的接送碼已鎖定')

    await submit()

    expect((wrapper.emitted('verify-authorization') as [StaffAuthorization][])[0]?.[0].id).toBe('pa1')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(completeBodies()).toEqual([])
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  it('PickupCompleteDialog marks locked proxy authorizations', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [FATHER])
    await mountDialog({ authorizations: [authorization('pa1', { locked: true, code_attempts: 5 })] })

    expect(option('陳阿姨').text()).toContain('已鎖定')
    await choose('陳阿姨')

    expect(dialog().text()).toContain('此授權的接送碼已鎖定，需由主任強制完成。')
    expect(submitButton().text()).toBe('前往核驗')
  })

  it('PickupCompleteDialog override requires note and permission', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [MOTHER])
    mock.onPost(COMPLETE_URL).reply(200, makeRequest({ status: 'completed', completion_method: 'override' }))
    const wrapper = await mountDialog({ canOverride: true })

    expect(dialog().text()).toContain('其他')
    await choose('主管確認交付')
    expect(dialog().text()).toContain('會記錄於稽核紀錄')
    const textarea = dialog().find('textarea')
    expect(textarea.attributes('maxlength')).toBe('200')
    expect(textarea.attributes('placeholder')).toBe('例如：阿嬤臨時來接，已電話向媽媽確認')

    await submit()
    await vi.waitFor(() => expect(dialog().text()).toContain('請填寫備註'))
    expect(completeBodies()).toEqual([])

    await textarea.setValue('  阿嬤臨時來接，已電話向媽媽確認  ')
    await settle()
    await submit()

    expect(completeBodies()).toEqual([{ method: 'override', note: '阿嬤臨時來接，已電話向媽媽確認' }])
    expect(wrapper.emitted('done')).toHaveLength(1)

    document.body.innerHTML = ''
    await mountDialog({ canOverride: false })
    expect(dialog().text()).not.toContain('主管確認交付')
  })

  it('PickupCompleteDialog maps guardian errors', async () => {
    mock.onGet(GUARDIANS_URL).replyOnce(200, [FATHER, GRANDMA])
    mock.onGet(GUARDIANS_URL).replyOnce(200, [{ ...FATHER, can_pickup: false }, GRANDMA])
    mock.onPost(COMPLETE_URL).replyOnce(409, {
      error: { code: 'guardian_cannot_pickup', message: 'guardian cannot pick up', details: null },
    })
    const wrapper = await mountDialog()

    await choose('王大明')
    await submit()

    expect(dialog().text()).toContain('此監護人未被授權接送')
    expect(guardianLoads()).toBe(2)
    expect(option('王大明').classes()).toContain('is-disabled')
    // 重新載入後只剩一位可接送：預選該位
    expect(option('王阿嬤').classes()).toContain('is-checked')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('PickupCompleteDialog maps invalid guardian and reloads', async () => {
    mock.onGet(GUARDIANS_URL).replyOnce(200, [FATHER])
    mock.onGet(GUARDIANS_URL).replyOnce(200, [GRANDMA])
    mock.onPost(COMPLETE_URL).replyOnce(422, {
      error: { code: 'invalid_guardian', message: 'invalid guardian', details: null },
    })
    await mountDialog()

    await submit()

    expect(dialog().text()).toContain('監護人資料已變更，請重新選擇')
    expect(guardianLoads()).toBe(2)
    expect(dialog().text()).not.toContain('王大明')
    expect(option('王阿嬤').classes()).toContain('is-checked')
  })

  it('PickupCompleteDialog no eligible person', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [MOTHER, { ...FATHER, can_pickup: false }])
    await mountDialog()

    expect(dialog().text()).toContain('沒有可接送的監護人，請聯絡主任處理')
    expect(submitButton().attributes('disabled')).toBeDefined()

    // 有今日授權或可主管確認時就不是「沒有可接送的人」
    document.body.innerHTML = ''
    await mountDialog({ authorizations: [authorization('pa1')] })
    expect(dialog().text()).not.toContain('沒有可接送的監護人')
    document.body.innerHTML = ''
    await mountDialog({ canOverride: true })
    expect(dialog().text()).not.toContain('沒有可接送的監護人')
  })

  it('PickupCompleteDialog shows when the student has no guardian data', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [])
    await mountDialog({ canOverride: true })

    expect(dialog().text()).toContain('沒有監護人資料')
  })

  it('PickupCompleteDialog keeps other options when guardians fail to load', async () => {
    mock.onGet(GUARDIANS_URL).reply(500, { error: { code: 'internal_error', message: '伺服器暫時沒有回應', details: null } })
    await mountDialog({ authorizations: [authorization('pa1')] })

    expect(dialog().find('.el-alert--error').text()).toContain('伺服器暫時沒有回應')
    await choose('陳阿姨')
    expect(submitButton().attributes('disabled')).toBeUndefined()
  })

  it('PickupCompleteDialog closes without done when the board handled a conflict', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [FATHER])
    const board: CompleteBoard = { complete: vi.fn(() => Promise.resolve(null)) }
    const wrapper = await mountDialog({ board })

    await submit()

    expect(board.complete).toHaveBeenCalledWith('r1', { method: 'guardian', guardian_id: 'g1' })
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(wrapper.emitted('done')).toBeUndefined()
    expect(document.body.textContent).not.toContain('已完成交付')
  })

  it('PickupCompleteDialog shows other errors above the options and stays open', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [FATHER])
    mock.onPost(COMPLETE_URL).reply(500, { error: { code: 'internal_error', message: '伺服器暫時沒有回應', details: null } })
    const wrapper = await mountDialog()

    await submit()

    expect(dialog().find('.el-alert--error').text()).toContain('伺服器暫時沒有回應')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(guardianLoads()).toBe(1)
  })

  it('PickupCompleteDialog resets and reloads guardians when reopened', async () => {
    mock.onGet(GUARDIANS_URL).reply(200, [FATHER, GRANDMA])
    const wrapper = await mountDialog({ canOverride: true })
    await choose('主管確認交付')
    await dialog().find('textarea').setValue('先寫一半')

    await wrapper.setProps({ modelValue: false })
    await settle()
    await wrapper.setProps({ modelValue: true })
    await settle()

    expect(guardianLoads()).toBe(2)
    expect(dialog().findAll('.el-radio.is-checked')).toHaveLength(0)
    expect(dialog().find('textarea').exists()).toBe(false)
  })

  it('PickupCompleteDialog touch targets follow the approved mockup', () => {
    // happy-dom 不算版面：以原始碼斷言稿的 decisions（選項卡 ≥ 56px 的框線 radio）
    expect(dialogSource).toMatch(/\.complete-dialog__list[^{]*\.el-radio\.is-bordered[^{]*\{[^}]*min-height:\s*56px/)
  })
})
