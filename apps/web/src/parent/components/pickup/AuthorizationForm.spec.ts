import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthorizationCreateInput } from '../../api/pickupAuthorizations'
import type { PickupPerson } from '../../api/pickupPersons'
import AuthorizationForm from './AuthorizationForm.vue'
import source from './AuthorizationForm.vue?raw'

const TODAY = '2026-10-02'

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

const PP1 = person('pp1', '李阿姨')
const PP2 = person('pp2', '王大哥', { relation: '叔叔', phone: '0912-000-456', photo_url: 'https://files.example.test/pp2.jpg' })

interface FormProps {
  persons: PickupPerson[]
  submitting?: boolean
  today: string
  maxDaysAhead: number
}

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountForm(overrides: Partial<FormProps> = {}): VueWrapper {
  const props: FormProps = { persons: [PP1, PP2], today: TODAY, maxDaysAhead: 14, ...overrides }
  // 送出鈕觸發 submit 需要 form 掛在 document 上
  wrapper = mount(AuthorizationForm, { props, attachTo: document.body })
  return wrapper
}

function field(w: VueWrapper, label: string): Omit<DOMWrapper<HTMLInputElement>, 'exists'> {
  const lab = w.findAll('label').find((l) => l.text() === label)
  if (!lab) throw new Error(`找不到欄位 ${label}`)
  return w.get<HTMLInputElement>(`#${lab.attributes('for')}`)
}

function hasField(w: VueWrapper, label: string): boolean {
  return w.findAll('label').some((l) => l.text() === label)
}

function segment(w: VueWrapper, label: string) {
  const found = w.findAll('.m3-segment').find((b) => b.text().includes(label))
  if (!found) throw new Error(`找不到分段 ${label}`)
  return found
}

function personRadio(w: VueWrapper, name: string) {
  const found = w.findAll('.af-person').find((b) => b.text().includes(name))
  if (!found) throw new Error(`找不到接送人 ${name}`)
  return found
}

function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').find((b) => b.text().includes(label))
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

async function submit(w: VueWrapper): Promise<void> {
  await button(w, '建立代理接送').trigger('click')
}

function submitted(w: VueWrapper): AuthorizationCreateInput[] {
  return (w.emitted('submit') ?? []).map((args) => args[0] as AuthorizationCreateInput)
}

describe('AuthorizationForm', () => {
  it('AuthorizationForm submits saved person', async () => {
    const w = mountForm({ persons: [PP1] })
    // persons 有資料：預設常用接送人
    expect(segment(w, '常用接送人').attributes('aria-checked')).toBe('true')
    await segment(w, '常用接送人').trigger('click')

    await personRadio(w, '李阿姨').trigger('click')
    expect(personRadio(w, '李阿姨').attributes('aria-checked')).toBe('true')
    await submit(w)

    expect(submitted(w)).toEqual([{ service_date: '2026-10-02', pickup_person_id: 'pp1' }])
  })

  it('AuthorizationForm submits manual proxy', async () => {
    const w = mountForm()
    await segment(w, '臨時填寫').trigger('click')
    await field(w, '姓名').setValue('陳叔叔')
    await field(w, '電話').setValue('0922 000 456')
    await field(w, '接送日期').setValue('2026-10-05')
    await submit(w)

    expect(submitted(w)).toEqual([{ service_date: '2026-10-05', proxy_name: '陳叔叔', proxy_phone: '0922000456' }])
  })

  it('AuthorizationForm sends only the current source fields', async () => {
    const w = mountForm()
    // 先在常用接送人選了人，再切到臨時填寫送出：不帶 pickup_person_id
    await personRadio(w, '王大哥').trigger('click')
    await segment(w, '臨時填寫').trigger('click')
    await field(w, '姓名').setValue('  陳叔叔  ')
    await field(w, '電話').setValue('02-2345-6789')
    await submit(w)
    expect(submitted(w)).toEqual([{ service_date: TODAY, proxy_name: '陳叔叔', proxy_phone: '0223456789' }])

    // 切回常用接送人：選取還在，送出不帶臨時欄位
    await segment(w, '常用接送人').trigger('click')
    expect(personRadio(w, '王大哥').attributes('aria-checked')).toBe('true')
    await submit(w)
    expect(submitted(w)[1]).toEqual({ service_date: TODAY, pickup_person_id: 'pp2' })
  })

  it('AuthorizationForm date range validation', async () => {
    const w = mountForm({ maxDaysAhead: 14 })
    const date = field(w, '接送日期')

    expect(date.attributes('type')).toBe('date')
    expect(date.attributes('min')).toBe('2026-10-02')
    expect(date.attributes('max')).toBe('2026-10-16')
    expect(date.element.value).toBe('2026-10-02')
    expect(w.text()).toContain('可選 10/02～10/16（今天起 14 天內）')

    await personRadio(w, '李阿姨').trigger('click')
    await date.setValue('2026-10-17')
    await submit(w)

    expect(w.text()).toContain('日期需在今天起 14 天內')
    // 錯誤取代支援文字
    expect(w.text()).not.toContain('可選 10/02～10/16')
    expect(w.emitted('submit')).toBeUndefined()

    // 再改日期即清除
    await date.setValue('2026-10-16')
    expect(w.text()).not.toContain('日期需在今天起 14 天內')
    await submit(w)
    expect(submitted(w)).toEqual([{ service_date: '2026-10-16', pickup_person_id: 'pp1' }])
  })

  it('AuthorizationForm rejects an empty or past date', async () => {
    const w = mountForm()
    await personRadio(w, '李阿姨').trigger('click')

    await field(w, '接送日期').setValue('')
    await submit(w)
    expect(w.text()).toContain('日期需在今天起 14 天內')

    await field(w, '接送日期').setValue('2026-10-01')
    await submit(w)
    expect(w.text()).toContain('日期需在今天起 14 天內')
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('AuthorizationForm no persons forces manual', () => {
    const w = mountForm({ persons: [] })

    expect(segment(w, '常用接送人').attributes('disabled')).toBeDefined()
    expect(segment(w, '臨時填寫').attributes('aria-checked')).toBe('true')
    expect(hasField(w, '姓名')).toBe(true)
    expect(hasField(w, '電話')).toBe(true)
    expect(w.find('.af-persons').exists()).toBe(false)
    expect(w.text()).toContain('還沒有常用接送人；在「常用接送人」新增後，下次可直接從清單選擇。')
  })

  it('AuthorizationForm requires person selection', async () => {
    const w = mountForm()
    await submit(w)

    expect(w.text()).toContain('請選擇接送人')
    expect(w.get('.af-error').attributes('role')).toBe('alert')
    expect(w.get('.af-persons').classes()).toContain('is-error')
    expect(w.emitted('submit')).toBeUndefined()

    await personRadio(w, '王大哥').trigger('click')
    expect(w.text()).not.toContain('請選擇接送人')
    expect(w.get('.af-persons').classes()).not.toContain('is-error')
  })

  it('AuthorizationForm validates manual fields', async () => {
    const w = mountForm()
    await segment(w, '臨時填寫').trigger('click')
    await field(w, '姓名').setValue('  ')
    await field(w, '電話').setValue('0922-000')
    await submit(w)

    expect(w.text()).toContain('請輸入姓名')
    expect(w.text()).toContain('請輸入正確的電話號碼')
    expect(w.emitted('submit')).toBeUndefined()

    await field(w, '姓名').setValue('陳')
    expect(w.text()).not.toContain('請輸入姓名')
    expect(w.text()).toContain('請輸入正確的電話號碼')

    await field(w, '電話').setValue('0922000456')
    expect(w.text()).not.toContain('請輸入正確的電話號碼')
  })

  it('AuthorizationForm switching source clears field errors but keeps values', async () => {
    const w = mountForm()
    await submit(w)
    expect(w.text()).toContain('請選擇接送人')

    await segment(w, '臨時填寫').trigger('click')
    await submit(w)
    expect(w.text()).toContain('請輸入姓名')

    await segment(w, '常用接送人').trigger('click')
    expect(w.text()).not.toContain('請選擇接送人')
    expect(w.text()).not.toContain('請輸入姓名')
  })

  it('AuthorizationForm clears selection when person removed', async () => {
    const w = mountForm({ persons: [PP1, PP2] })
    await personRadio(w, '李阿姨').trigger('click')
    expect(personRadio(w, '李阿姨').attributes('aria-checked')).toBe('true')

    await w.setProps({ persons: [PP2] })

    expect(w.findAll('.af-person[aria-checked="true"]')).toHaveLength(0)
    expect(w.findAll('.af-person')).toHaveLength(1)
    await submit(w)
    expect(w.text()).toContain('請選擇接送人')
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('AuthorizationForm keeps a selection that is still in the new list', async () => {
    const w = mountForm({ persons: [PP1, PP2] })
    await personRadio(w, '王大哥').trigger('click')

    await w.setProps({ persons: [PP2, person('pp3', '林阿姨')] })

    expect(personRadio(w, '王大哥').attributes('aria-checked')).toBe('true')
  })

  it('AuthorizationForm switches to manual when persons emptied', async () => {
    const w = mountForm({ persons: [PP1] })
    expect(w.find('.af-persons').exists()).toBe(true)

    await w.setProps({ persons: [] })

    expect(hasField(w, '姓名')).toBe(true)
    expect(hasField(w, '電話')).toBe(true)
    expect(segment(w, '常用接送人').attributes('disabled')).toBeDefined()
    expect(segment(w, '臨時填寫').attributes('aria-checked')).toBe('true')
  })

  it('AuthorizationForm keeps values across mode switch', async () => {
    const w = mountForm()
    await segment(w, '臨時填寫').trigger('click')
    await field(w, '姓名').setValue('陳叔叔')
    await field(w, '電話').setValue('0922000456')

    await segment(w, '常用接送人').trigger('click')
    expect(hasField(w, '姓名')).toBe(false)
    await segment(w, '臨時填寫').trigger('click')

    expect(field(w, '姓名').element.value).toBe('陳叔叔')
    expect(field(w, '電話').element.value).toBe('0922000456')
  })

  it('AuthorizationForm locks while submitting', async () => {
    const w = mountForm({ submitting: true })
    await personRadio(w, '李阿姨').trigger('click')

    const create = button(w, '建立代理接送')
    expect(create.attributes('aria-busy')).toBe('true')
    expect(create.attributes('type')).toBe('submit')
    expect(button(w, '取消').attributes('disabled')).toBeDefined()
    // 日期欄由 disabled 的 fieldset 鎖定（happy-dom 不會把 fieldset 的 disabled 傳給子欄位的 :disabled，
    // 以「在 disabled fieldset 內」斷言；真實 Chromium 的 :disabled 由 Playwright 驗證）
    const lock = w.get('fieldset.af-lock')
    expect(lock.attributes('disabled')).toBeDefined()
    const date = field(w, '接送日期')
    expect(date.element.closest('fieldset[disabled]')).toBe(lock.element)
    expect(w.get('.af-persons').element.closest('fieldset[disabled]')).toBe(lock.element)

    await create.trigger('click')
    expect(w.emitted('submit')).toBeUndefined()
    // 不經送出鈕的送出（例如 requestSubmit）也不 emit
    await w.trigger('submit')
    expect(w.emitted('submit')).toBeUndefined()

    await w.setProps({ submitting: false })
    expect(button(w, '建立代理接送').attributes('aria-busy')).toBeUndefined()
    expect(w.get('fieldset.af-lock').attributes('disabled')).toBeUndefined()
  })

  it('AuthorizationForm follows configured days ahead', async () => {
    const w = mountForm({ maxDaysAhead: 7 })

    expect(field(w, '接送日期').attributes('max')).toBe('2026-10-09')
    expect(w.text()).toContain('可選 10/02～10/09（今天起 7 天內）')

    await personRadio(w, '李阿姨').trigger('click')
    await field(w, '接送日期').setValue('2026-10-10')
    await submit(w)

    expect(w.text()).toContain('日期需在今天起 7 天內')
    expect(w.emitted('submit')).toBeUndefined()

    // 跨月：today 10/28、7 天 → 11/04
    const crossMonth = mountForm({ today: '2026-10-28', maxDaysAhead: 7 })
    expect(field(crossMonth, '接送日期').attributes('max')).toBe('2026-11-04')
    expect(crossMonth.text()).toContain('可選 10/28～11/04（今天起 7 天內）')
  })

  it('AuthorizationForm cancel emits without validating', async () => {
    const w = mountForm()
    await button(w, '取消').trigger('click')

    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('submit')).toBeUndefined()
    expect(w.text()).not.toContain('請選擇接送人')
    expect(button(w, '取消').attributes('type')).toBe('button')
  })

  it('AuthorizationForm person rows are labelled radios with avatars', async () => {
    const w = mountForm()

    const group = w.get('.af-persons')
    expect(group.attributes('role')).toBe('radiogroup')
    const labelId = group.attributes('aria-labelledby')
    expect(labelId).toBeTruthy()
    expect(w.get(`#${labelId}`).text()).toBe('接送人')
    expect(w.get('.m3-segmented').attributes('aria-label')).toBe('接送人來源')

    const rows = w.findAll('.af-person')
    expect(rows.map((r) => r.attributes('role'))).toEqual(['radio', 'radio'])
    expect(rows.map((r) => r.attributes('type'))).toEqual(['button', 'button'])
    expect(rows.map((r) => r.attributes('aria-checked'))).toEqual(['false', 'false'])
    expect(rows[0]!.get('.af-person__meta').text()).toBe('保母 · 0912000123')
    expect(rows[1]!.get('.af-person__meta').text()).toBe('叔叔 · 0912-000-456')
    // 未選：radio_button_unchecked；李阿姨沒照片用首字、王大哥有照片
    expect(rows[0]!.get('.af-person__radio').text()).toBe('radio_button_unchecked')
    expect(rows[0]!.get('.af-person__avatar').text()).toBe('李')
    expect(rows[1]!.get('.af-person__avatar img').attributes('src')).toBe('https://files.example.test/pp2.jpg')
    expect(rows[0]!.get('.af-person__avatar').attributes('aria-hidden')).toBe('true')

    await rows[1]!.trigger('click')
    expect(rows[1]!.get('.af-person__radio').text()).toBe('radio_button_checked')
    expect(rows[1]!.classes()).toContain('is-checked')

    // 照片載入失敗：退回首字
    await rows[1]!.get('img').trigger('error')
    expect(w.findAll('.af-person')[1]!.find('img').exists()).toBe(false)
    expect(w.findAll('.af-person')[1]!.get('.af-person__avatar').text()).toBe('王')
  })

  it('AuthorizationForm manual fields follow the field rules', async () => {
    const w = mountForm()
    await segment(w, '臨時填寫').trigger('click')

    const name = field(w, '姓名')
    expect(name.attributes('maxlength')).toBe('50')
    expect(name.attributes('autocomplete')).toBe('off')
    const phone = field(w, '電話')
    expect(phone.attributes('type')).toBe('tel')
    expect(phone.attributes('inputmode')).toBe('tel')
    expect(phone.attributes('autocomplete')).toBe('off')
    expect(w.text()).toContain('手機或市話，例如 0912-000-123')
    // 有常用接送人時不顯示「還沒有常用接送人」
    expect(w.text()).not.toContain('還沒有常用接送人')
  })

  it('AuthorizationForm shows the handover note and uses a novalidate form', () => {
    const w = mountForm()

    expect(w.element.tagName).toBe('FORM')
    expect(w.attributes('novalidate')).toBeDefined()
    expect(w.get('.af-note').text()).toContain('代理人到場時出示接送碼，或由老師核對身分後交付。')
    expect(w.get('.af-note .m3-icon').text()).toBe('info')
    // 日期加減不經 toISOString（時區安全）
    const code = source.slice(0, source.indexOf('<template>')).replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('toISOString')
  })
})
