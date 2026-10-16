import { config, DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { StudentDetail } from '@/api/students'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentFormDialog from './StudentFormDialog.vue'

const WRITER = ['students:read', 'students:write']
const SENSITIVE = [...WRITER, 'students:sensitive']

const SCHOOLS = [
  { id: 'sc1', name: '臺北市某某國民小學', short_name: '某某國小', sort_order: 1, is_active: true },
  { id: 'sc2', name: '臺北市另一國民小學', short_name: null, sort_order: 2, is_active: true },
]
const CLASSES = [
  {
    id: 'c1',
    name: '低年級A班',
    grade_levels: [1, 2],
    academic_year: 115,
    sort_order: 1,
    archived_at: null,
    student_count: 10,
    staff: [],
  },
  {
    id: 'c3',
    name: '中年級班',
    grade_levels: [3, 4],
    academic_year: 115,
    sort_order: 2,
    archived_at: null,
    student_count: 12,
    staff: [],
  },
  {
    id: 'k1',
    name: '去年的班',
    grade_levels: [3],
    academic_year: 114,
    sort_order: 1,
    archived_at: null,
    student_count: 0,
    staff: [],
  },
]

function student(overrides: Partial<StudentDetail> = {}): StudentDetail {
  return {
    id: 's1',
    student_no: 'S11301',
    name: '王小明',
    gender: 'male',
    grade_level: 3,
    school: { id: 'sc1', name: '臺北市某某國民小學', short_name: '某某國小' },
    school_class: '三年二班',
    class: { id: 'c3', name: '中年級班' },
    status: 'active',
    archived_at: null,
    birthday: '2018-05-02',
    enrolled_on: '2025-08-26',
    withdrawn_on: null,
    note: '週三由校車送到班。',
    photo_url: null,
    has_id_number: true,
    has_health_note: true,
    sensitive: { id_number: 'A123456789', health_note: '花生過敏' },
    guardians: [],
    ...overrides,
  }
}

let mock: MockAdapter
const originalStubs = { ...config.global.stubs }

/**
 * happy-dom 掛一個 el-date-picker 約 0.6 秒且隨數量超線性變慢（表單有 2~3 個），
 * 除了驗證真實日期元件接線的兩個案例，其餘以輕量 stub 取代：顯示 YYYY/MM/DD、change 時回傳 YYYY-MM-DD。
 */
const DatePickerStub = defineComponent({
  name: 'DatePickerStub',
  // 父層的 type="date" 等屬性不可落到原生 input，否則 input 變成原生日期欄
  inheritAttrs: false,
  props: { modelValue: { type: String, default: null } },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    return () =>
      h('input', {
        class: 'date-stub',
        value: props.modelValue ? props.modelValue.replaceAll('-', '/') : '',
        onChange: (e: Event) => {
          const raw = (e.target as HTMLInputElement).value
          const value = raw ? raw.replaceAll('/', '-') : null
          emit('update:modelValue', value)
          emit('change', value)
        },
      })
  },
})

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
  props: { student?: StudentDetail } = {},
  permissions: string[] = WRITER,
  { realDatePicker = false } = {},
): Promise<VueWrapper> {
  config.global.stubs = realDatePicker ? { ...originalStubs } : { ...originalStubs, ElDatePicker: DatePickerStub }
  const { wrapper } = await mountWithApp(StudentFormDialog, {
    props: { modelValue: true, ...props },
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'director01',
          display_name: '張主任',
          role: { id: 'r-director', code: 'director', name: '主任' },
          permissions,
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

function findItem(label: string): DOMWrapper<Element> | undefined {
  return dialog()
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text().trim() === label)
}

function formItem(label: string): DOMWrapper<Element> {
  const item = findItem(label)
  if (!item) throw new Error(`找不到欄位 ${label}`)
  return item
}

async function fill(label: string, value: string): Promise<void> {
  await formItem(label).find('input, textarea').setValue(value)
  await settle()
}

async function choose(label: string, option: string): Promise<void> {
  const item = formItem(label)
  await item.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = item.find('input').attributes('aria-controls')
  const options = Array.from(
    document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [],
  )
  const target = options.find((o) => o.textContent?.trim() === option)
  if (!target) throw new Error(`找不到選項 ${option}（欄位 ${label}）`)
  target.click()
  await settle()
}

/** 在日期欄輸入顯示格式（YYYY/MM/DD）後觸發 change，由 el-date-picker 解析成 value-format */
async function typeDate(label: string, value: string): Promise<void> {
  const input = formItem(label).find('input')
  await input.trigger('focus')
  await input.setValue(value)
  await input.trigger('change')
  await settle()
}

function selectedText(label: string): string {
  return formItem(label).find('.el-select__placeholder').text()
}

async function save(): Promise<void> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === '儲存')
  if (!btn) throw new Error('找不到「儲存」')
  await btn.trigger('click')
  await settle()
}

function messageBoxText(): string {
  return Array.from(document.body.querySelectorAll('.el-message-box'))
    .map((el) => el.textContent ?? '')
    .join('')
}

async function clickMessageBox(text: string): Promise<void> {
  await settle()
  const b = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.el-message-box button'))
    .filter((x) => x.textContent?.trim() === text)
    .at(-1)
  if (!b) throw new Error(`確認框找不到按鈕「${text}」`)
  b.click()
  await settle()
}

function body(method: 'post' | 'patch', index = 0): Record<string, unknown> {
  const req = mock.history[method][index]
  if (!req) throw new Error(`沒有第 ${index + 1} 個 ${method}`)
  return JSON.parse(req.data as string) as Record<string, unknown>
}

// 表單有 5 個 el-select，happy-dom 下單一案例約 2~3 秒，多 agent 並行時易超過預設 5 秒
describe('StudentFormDialog', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 台北 2026-10-02 09:00
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'))
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/schools').reply(200, SCHOOLS)
    mock.onGet('/admin/classes').reply(200, CLASSES)
  })

  afterEach(() => {
    config.global.stubs = { ...originalStubs }
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('StudentFormDialog creates student with defaults', async () => {
    const created = student({ id: 's9', student_no: 'S1002', name: '林小華' })
    mock.onPost('/admin/students').reply(201, created)
    const wrapper = await mountDialog({}, WRITER, { realDatePicker: true })

    expect(dialog().find('.el-dialog__title').text()).toBe('新增學生')
    expect(selectedText('狀態')).toBe('在學')
    expect(formItem('入學日').find('input').element.value).toBe('2026/10/02')
    expect(findItem('退班日')).toBeUndefined()
    await fill('學號', 'S1002')
    await fill('姓名', '林小華')
    await choose('年級', '二年級')
    await choose('安親班班級（115 學年度）', '低年級A班')
    await save()

    const sent = body('post')
    expect(sent).toMatchObject({
      student_no: 'S1002',
      name: '林小華',
      grade_level: 2,
      class_id: 'c1',
      status: 'active',
      enrolled_on: '2026-10-02',
    })
    expect(sent).not.toHaveProperty('id_number')
    expect(sent).not.toHaveProperty('health_note')
    expect(wrapper.emitted('saved')).toEqual([[created]])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(document.body.textContent).toContain('已儲存')
  })

  it('StudentFormDialog creates student with defaults: options from lookups', async () => {
    await mountDialog()

    await formItem('安親班班級（115 學年度）').find('.el-select__wrapper').trigger('click')
    await settle()
    const classList = formItem('安親班班級（115 學年度）').find('input').attributes('aria-controls')
    const classLabels = Array.from(
      document.getElementById(classList!)?.querySelectorAll('.el-select-dropdown__item') ?? [],
    ).map((o) => o.textContent?.trim())
    // 只列目前學年度的班級
    expect(classLabels).toEqual(['低年級A班', '中年級班'])

    await formItem('就讀國小').find('.el-select__wrapper').trigger('click')
    await settle()
    const schoolList = formItem('就讀國小').find('input').attributes('aria-controls')
    const schoolLabels = Array.from(
      document.getElementById(schoolList!)?.querySelectorAll('.el-select-dropdown__item') ?? [],
    ).map((o) => o.textContent?.trim())
    expect(schoolLabels).toEqual(['某某國小', '臺北市另一國民小學'])
  })

  it('StudentFormDialog hides sensitive section without permission', async () => {
    await mountDialog({}, ['students:write'])

    expect(findItem('身分證字號')).toBeUndefined()
    expect(findItem('健康備註')).toBeUndefined()
    expect(dialog().text()).not.toContain('敏感資料')
    document.body.innerHTML = ''

    await mountDialog({}, ['students:write', 'students:sensitive'])

    expect(findItem('身分證字號')).toBeDefined()
    expect(findItem('健康備註')).toBeDefined()
    expect(dialog().text()).toContain('敏感資料')
  })

  it('StudentFormDialog hides sensitive section without permission: sends filled sensitive fields on create', async () => {
    mock.onPost('/admin/students').reply(201, student())
    await mountDialog({}, SENSITIVE)

    await fill('學號', 'S1002')
    await fill('姓名', '林小華')
    await choose('年級', '二年級')
    await fill('身分證字號', 'A123456789')
    await fill('健康備註', '氣喘\n需隨身攜帶吸入器')
    await save()

    expect(body('post')).toMatchObject({ id_number: 'A123456789', health_note: '氣喘\n需隨身攜帶吸入器' })
  })

  it('StudentFormDialog edit sends only changed fields and clears sensitive', async () => {
    const updated = student({ name: '王小明明', has_health_note: false })
    mock.onPatch('/admin/students/s1').reply(200, updated)
    const wrapper = await mountDialog({ student: student() }, SENSITIVE)

    expect(dialog().find('.el-dialog__title').text()).toBe('編輯學生')
    const health = formItem('健康備註')
    expect(health.find('textarea').element.value).toBe('')
    expect(health.find('textarea').attributes('placeholder')).toBe('留空表示不變更')
    expect(health.text()).toContain('目前已填寫')
    expect(formItem('身分證字號').find('input').element.value).toBe('')

    await fill('姓名', '王小明明')
    await health.find('.el-checkbox input').setValue(true)
    await settle()
    expect(formItem('健康備註').find('textarea').element.disabled).toBe(true)
    await save()

    expect(mock.history.patch).toHaveLength(1)
    expect(body('patch')).toEqual({ name: '王小明明', health_note: null })
    expect(wrapper.emitted('saved')).toEqual([[updated]])
  })

  it('StudentFormDialog edit sends only changed fields and clears sensitive: unchanged closes without request', async () => {
    const wrapper = await mountDialog({ student: student() }, SENSITIVE)

    await save()

    expect(mock.history.patch).toHaveLength(0)
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(wrapper.emitted('saved')).toBeUndefined()
  })

  it('StudentFormDialog edit sends only changed fields and clears sensitive: no clear option when empty', async () => {
    await mountDialog({ student: student({ has_id_number: false, has_health_note: false }) }, SENSITIVE)

    expect(formItem('身分證字號').find('.el-checkbox').exists()).toBe(false)
    expect(formItem('身分證字號').text()).not.toContain('目前已填寫')
  })

  it('StudentFormDialog requires withdrawn date for withdrawn status', async () => {
    await mountDialog()

    await fill('學號', 'S1002')
    await fill('姓名', '林小華')
    await choose('年級', '二年級')
    await choose('狀態', '退班')
    expect(findItem('退班日')).toBeDefined()
    await save()
    await settleErrors()

    expect(formItem('退班日').find('.el-form-item__error').text()).toBe('請選擇退班日')
    expect(mock.history.post).toHaveLength(0)
    expect(mock.history.patch).toHaveLength(0)
  })

  it('StudentFormDialog requires withdrawn date for withdrawn status: required basics', async () => {
    await mountDialog()

    await save()
    await settleErrors()

    expect(formItem('學號').find('.el-form-item__error').text()).toBe('請輸入學號')
    expect(formItem('姓名').find('.el-form-item__error').text()).toBe('請輸入姓名')
    expect(formItem('年級').find('.el-form-item__error').text()).toBe('請選擇年級')
    expect(mock.history.post).toHaveLength(0)
  })

  it('StudentFormDialog maps duplicate errors', async () => {
    mock
      .onPost('/admin/students')
      .replyOnce(409, { error: { code: 'student_no_taken', message: '學號重複', details: null } })
      .onPost('/admin/students')
      .replyOnce(409, { error: { code: 'id_number_duplicate', message: '身分證重複', details: null } })
    const wrapper = await mountDialog({}, SENSITIVE)

    await fill('學號', 'S11301')
    await fill('姓名', '林小華')
    await choose('年級', '二年級')
    await fill('身分證字號', 'A123456789')
    await save()
    await settleErrors()
    expect(formItem('學號').find('.el-form-item__error').text()).toBe('學號已被使用')

    await save()
    await settleErrors()
    expect(formItem('身分證字號').find('.el-form-item__error').text()).toBe('此身分證字號已有學生使用')
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('StudentFormDialog maps duplicate errors: dates, validation and permission errors', async () => {
    mock
      .onPatch('/admin/students/s1')
      .replyOnce(422, { error: { code: 'invalid_dates', message: '退班日不可早於入班日', details: null } })
      .onPatch('/admin/students/s1')
      .replyOnce(422, {
        error: {
          code: 'validation_error',
          message: '欄位格式不正確',
          details: [{ loc: ['body', 'school_class'], msg: '最多 20 字', type: 'string_too_long' }],
        },
      })
      .onPatch('/admin/students/s1')
      .replyOnce(403, {
        error: { code: 'sensitive_permission_required', message: '需要敏感資料權限', details: null },
      })
    await mountDialog({ student: student({ status: 'withdrawn', withdrawn_on: '2026-09-30' }) })

    await typeDate('退班日', '2025/08/01')
    await save()
    await settleErrors()
    expect(formItem('退班日').find('.el-form-item__error').text()).toBe('退班日不可早於入班日')

    await fill('學校班級', '三年二班三年二班三年二班三年二班三年二班')
    await save()
    await settleErrors()
    expect(formItem('學校班級').find('.el-form-item__error').text()).toBe('最多 20 字')

    await save()
    expect(document.body.textContent).toContain('需要敏感資料權限')
  })

  it('StudentFormDialog validates id number format', async () => {
    mock.onPost('/admin/students').reply(201, student())
    await mountDialog({}, SENSITIVE)

    const idInput = formItem('身分證字號').find<HTMLInputElement>('input')
    await idInput.setValue('a12345')
    await idInput.trigger('blur')
    await settleErrors()
    expect(formItem('身分證字號').find('.el-form-item__error').text()).toBe('身分證字號格式不正確')

    await idInput.setValue('a123456789')
    await settleErrors()
    expect(idInput.element.value).toBe('A123456789')
    expect(formItem('身分證字號').find('.el-form-item__error').exists()).toBe(false)

    await fill('學號', 'S1002')
    await fill('姓名', '林小華')
    await choose('年級', '二年級')
    await save()
    expect(body('post')).toMatchObject({ id_number: 'A123456789' })
  })

  it('StudentFormDialog validates id number format: blocks submit', async () => {
    await mountDialog({}, SENSITIVE)

    await fill('學號', 'S1002')
    await fill('姓名', '林小華')
    await choose('年級', '二年級')
    await fill('身分證字號', 'A1234')
    await save()
    await settleErrors()

    expect(formItem('身分證字號').find('.el-form-item__error').text()).toBe('身分證字號格式不正確')
    expect(mock.history.post).toHaveLength(0)
  })

  it('StudentFormDialog confirms before suspending or withdrawing', async () => {
    mock.onPatch('/admin/students/s1').reply(200, student({ status: 'withdrawn', withdrawn_on: '2026-10-02' }))
    const wrapper = await mountDialog({ student: student() }, WRITER, { realDatePicker: true })

    await choose('狀態', '退班')
    await typeDate('退班日', '2026/10/02')
    await save()
    await settle()

    const text = messageBoxText()
    expect(text).toContain('確認將 王小明 改為退班')
    expect(text).toContain(
      '取消今天進行中的接送請求與有效的代理接送授權、刪除今天起尚未登記的出勤、取消未來的請假',
    )
    await clickMessageBox('取消')

    expect(mock.history.patch).toHaveLength(0)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(selectedText('狀態')).toBe('退班')

    await save()
    await clickMessageBox('確定儲存')

    expect(mock.history.patch).toHaveLength(1)
    expect(body('patch')).toMatchObject({ status: 'withdrawn', withdrawn_on: '2026-10-02' })
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('StudentFormDialog confirms before suspending or withdrawing: active to suspended', async () => {
    mock.onPatch('/admin/students/s1').reply(200, student({ status: 'suspended' }))
    await mountDialog({ student: student() })

    await choose('狀態', '暫停')
    await save()
    await settle()

    expect(messageBoxText()).toContain('確認將 王小明 改為暫停')
    await clickMessageBox('確定儲存')
    expect(body('patch')).toEqual({ status: 'suspended' })
  })

  it('StudentFormDialog skips status confirm when not deactivating', async () => {
    mock.onPatch('/admin/students/s1').reply(200, student({ name: '王大明' }))
    mock.onPost('/admin/students').reply(201, student({ id: 's9', status: 'suspended' }))
    await mountDialog({ student: student() })

    await fill('姓名', '王大明')
    await save()

    expect(messageBoxText()).toBe('')
    expect(body('patch')).toEqual({ name: '王大明' })
    document.body.innerHTML = ''

    await mountDialog()
    await fill('學號', 'S1002')
    await fill('姓名', '林小華')
    await choose('年級', '二年級')
    await choose('狀態', '暫停')
    await save()

    expect(messageBoxText()).toBe('')
    expect(body('post')).toMatchObject({ status: 'suspended' })
  })

  it('StudentFormDialog skips status confirm when not deactivating: suspended back to active', async () => {
    mock.onPatch('/admin/students/s1').reply(200, student())
    await mountDialog({ student: student({ status: 'suspended' }) })

    await choose('狀態', '在學')
    await save()

    expect(messageBoxText()).toBe('')
    expect(body('patch')).toEqual({ status: 'active' })
  })
})
