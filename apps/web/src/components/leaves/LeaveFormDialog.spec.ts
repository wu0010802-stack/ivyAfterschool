import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { Leave } from '@/api/leaves'
import { createApiMock, mountWithApp } from '@/test/helpers'
import LeaveFormDialog from './LeaveFormDialog.vue'

const LEAVES_URL = '/admin/leaves'
const PRESET = { id: 's1', name: '王小明', student_no: 'S11301', class_name: '中年級班' }

const CREATED: Leave = {
  id: 'l9',
  student: { id: 's1', student_no: 'S11301', name: '王小明', class_name: '中年級班' },
  leave_type: 'personal',
  leave_type_label: '事假',
  start_date: '2026-10-05',
  end_date: '2026-10-06',
  reason: '家庭旅遊',
  status: 'active',
  created_by_type: 'staff',
  created_by_name: '張主任',
  created_at: '2026-10-02T01:00:00Z',
  cancelled_at: null,
  cancelled_by_type: null,
  cancelled_by_name: null,
  attachments: [],
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

async function mountDialog(props: Record<string, unknown> = { presetStudent: PRESET }): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(LeaveFormDialog, { props: { modelValue: true, ...props } })
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

function fieldError(label: string): string {
  const error = formItem(label).find('.el-form-item__error')
  return error.exists() ? error.text() : ''
}

async function chooseType(label: string): Promise<void> {
  const button = formItem('假別')
    .findAll('.el-radio-button')
    .find((b) => b.text() === label)
  if (!button) throw new Error(`找不到假別 ${label}`)
  await button.find('input').setValue(true)
  await settle()
}

function rangePicker(wrapper: VueWrapper) {
  return wrapper.findComponent({ name: 'ElDatePicker' })
}

/** happy-dom 下在 daterange 輸入框打字不會觸發選取，改由元件本身送出選取結果（等同在面板上點選） */
async function pickRange(wrapper: VueWrapper, start: string, end: string): Promise<void> {
  const picker = rangePicker(wrapper)
  picker.vm.$emit('update:modelValue', [start, end])
  picker.vm.$emit('change', [start, end])
  await settle()
}

async function fillReason(text: string): Promise<void> {
  await formItem('原因（選填）').find('textarea').setValue(text)
  await settle()
}

async function submit(): Promise<void> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === '送出')
  if (!btn) throw new Error('找不到「送出」')
  await btn.trigger('click')
  await settle()
}

function posted(): Record<string, unknown>[] {
  return mock.history.post.filter((r) => r.url === LEAVES_URL).map((r) => JSON.parse(r.data as string))
}

// 表單含真實的 daterange 與 StudentSelect，happy-dom 下單一案例約 1~3 秒，多 agent 並行時易超過預設 5 秒
describe('LeaveFormDialog', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 台北 2026-10-02 09:00
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'))
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('LeaveFormDialog creates leave', async () => {
    mock.onPost(LEAVES_URL).reply(201, CREATED)
    const wrapper = await mountDialog()

    expect(dialog().find('.el-dialog__title').text()).toBe('代登記請假')
    expect(formItem('學生').find('.el-select__placeholder').text()).toBe('王小明（S11301・中年級班）')
    await chooseType('事假')
    await pickRange(wrapper, '2026-10-05', '2026-10-06')
    await fillReason('家庭旅遊')
    await submit()

    expect(posted()).toEqual([
      { student_id: 's1', leave_type: 'personal', start_date: '2026-10-05', end_date: '2026-10-06', reason: '家庭旅遊' },
    ])
    expect(wrapper.emitted('created')).toEqual([[CREATED]])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(document.body.textContent).toContain('已登記請假')
  })

  it('LeaveFormDialog creates leave: layout, hints and date limits', async () => {
    const wrapper = await mountDialog()

    expect(formItem('假別').findAll('.el-radio-button').map((b) => b.text())).toEqual(['病假', '事假', '其他'])
    expect(formItem('假別').find('.el-radio-button.is-active').exists()).toBe(false)
    expect(formItem('請假期間').text()).toContain('單日請假：開始與結束選同一天。最早可選 2026-09-02（30 天前）')
    expect(formItem('原因（選填）').find('textarea').attributes('placeholder')).toBe('例如：發燒看醫生')
    expect(dialog().find('.el-alert--info').text()).toContain('送出後立即生效，期間內的出勤會改為請假，並通知班級負責老師')

    const picker = rangePicker(wrapper)
    const disabledDate = picker.props('disabledDate') as (d: Date) => boolean
    expect(disabledDate(new Date(2026, 8, 1))).toBe(true)
    expect(disabledDate(new Date(2026, 8, 2))).toBe(false)
    const shortcuts = picker.props('shortcuts') as { text: string; value: () => Date[] }[]
    expect(shortcuts.map((s) => s.text)).toEqual(['今天', '明天'])
    const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(shortcuts[0]!.value().map(fmt)).toEqual(['2026-10-02', '2026-10-02'])
    expect(shortcuts[1]!.value().map(fmt)).toEqual(['2026-10-03', '2026-10-03'])
  })

  it('LeaveFormDialog shows overlap range', async () => {
    mock.onPost(LEAVES_URL).reply(409, {
      error: {
        code: 'leave_overlap',
        message: '期間與既有請假重疊',
        details: { leave_id: 'l2', start_date: '2026-10-06', end_date: '2026-10-07' },
      },
    })
    const wrapper = await mountDialog()

    await chooseType('病假')
    await pickRange(wrapper, '2026-10-05', '2026-10-06')
    await submit()
    await settleErrors()

    expect(fieldError('請假期間')).toBe('與既有請假（2026-10-06~2026-10-07）重疊')
    expect(wrapper.emitted('created')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('LeaveFormDialog shows overlap range: single day', async () => {
    mock.onPost(LEAVES_URL).reply(409, {
      error: {
        code: 'leave_overlap',
        message: '期間與既有請假重疊',
        details: { leave_id: 'l2', start_date: '2026-10-06', end_date: '2026-10-06' },
      },
    })
    const wrapper = await mountDialog()

    await chooseType('病假')
    await pickRange(wrapper, '2026-10-05', '2026-10-06')
    await submit()
    await settleErrors()

    expect(fieldError('請假期間')).toBe('與既有請假（2026-10-06）重疊')
  })

  it('LeaveFormDialog shows no service day error', async () => {
    mock.onPost(LEAVES_URL).reply(422, {
      error: { code: 'no_service_days_in_range', message: '期間內沒有營業日', details: null },
    })
    const wrapper = await mountDialog()

    await chooseType('其他')
    await pickRange(wrapper, '2026-10-04', '2026-10-04')
    await submit()
    await settleErrors()

    expect(fieldError('請假期間')).toBe('所選期間沒有營業日')
  })

  it('LeaveFormDialog requires student and type', async () => {
    const wrapper = await mountDialog({})

    await submit()
    await settleErrors()

    expect(fieldError('學生')).toBe('請選擇學生')
    expect(fieldError('假別')).toBe('請選擇假別')
    expect(fieldError('請假期間')).toBe('請選擇請假期間')
    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('created')).toBeUndefined()
  })

  it('LeaveFormDialog rejects range over 61 days', async () => {
    const wrapper = await mountDialog()

    await chooseType('病假')
    await pickRange(wrapper, '2026-10-05', '2026-12-05')
    await submit()
    await settleErrors()

    expect(fieldError('請假期間')).toBe('單筆請假最長 61 天')
    expect(mock.history.post).toHaveLength(0)
  })

  it('LeaveFormDialog rejects range over 61 days: exactly 61 days is allowed', async () => {
    mock.onPost(LEAVES_URL).reply(201, CREATED)
    const wrapper = await mountDialog()

    await chooseType('病假')
    await pickRange(wrapper, '2026-10-05', '2026-12-04')
    await submit()

    expect(posted()).toEqual([
      { student_id: 's1', leave_type: 'sick', start_date: '2026-10-05', end_date: '2026-12-04' },
    ])
  })

  it('LeaveFormDialog omits blank reason', async () => {
    mock.onPost(LEAVES_URL).reply(201, CREATED)
    const wrapper = await mountDialog()

    await chooseType('事假')
    await pickRange(wrapper, '2026-10-05', '2026-10-05')
    await fillReason('   ')
    await submit()

    expect(posted()).toHaveLength(1)
    expect(posted()[0]).not.toHaveProperty('reason')
  })

  it('LeaveFormDialog shows student not active', async () => {
    mock.onPost(LEAVES_URL).reply(409, {
      error: { code: 'student_not_active', message: '學生不是在學狀態', details: null },
    })
    const wrapper = await mountDialog()

    await chooseType('事假')
    await pickRange(wrapper, '2026-10-05', '2026-10-06')
    await submit()
    await settleErrors()

    expect(fieldError('學生')).toBe('此學生不是在學狀態')
  })

  it('LeaveFormDialog maps validation errors to fields', async () => {
    mock.onPost(LEAVES_URL).reply(422, {
      error: {
        code: 'validation_error',
        message: '欄位格式不正確',
        details: [
          { loc: ['body', 'reason'], msg: '最多 200 字', type: 'string_too_long' },
          { loc: ['body', 'end_date'], msg: '日期格式不正確', type: 'date_parsing' },
        ],
      },
    })
    const wrapper = await mountDialog()

    await chooseType('事假')
    await pickRange(wrapper, '2026-10-05', '2026-10-06')
    await fillReason('發燒')
    await submit()
    await settleErrors()

    expect(fieldError('原因（選填）')).toBe('最多 200 字')
    expect(fieldError('請假期間')).toBe('日期格式不正確')
  })

  it('LeaveFormDialog confirms before closing dirty form', async () => {
    const wrapper = await mountDialog()

    await chooseType('病假')
    const cancel = dialog()
      .findAll('.el-dialog__footer button')
      .find((b) => b.text() === '取消')
    await cancel!.trigger('click')
    await settle()

    expect(Array.from(document.body.querySelectorAll('.el-message-box')).map((b) => b.textContent).join('')).toContain(
      '尚未儲存的變更將會遺失',
    )
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('LeaveFormDialog shows other errors and keeps dialog open', async () => {
    mock
      .onPost(LEAVES_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器忙碌中，請稍後再試', details: null } })
      .onPost(LEAVES_URL)
      .replyOnce(503, { error: { code: 'service_unavailable', message: '', details: null } })
    const wrapper = await mountDialog()

    await chooseType('事假')
    await pickRange(wrapper, '2026-10-05', '2026-10-06')
    await fillReason('家庭旅遊')
    await submit()

    expect(document.body.textContent).toContain('伺服器忙碌中，請稍後再試')
    expect(wrapper.emitted('created')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    // 表單值保留，可直接再送
    expect(formItem('假別').find('.el-radio-button.is-active').text()).toBe('事假')
    expect(rangePicker(wrapper).props('modelValue')).toEqual(['2026-10-05', '2026-10-06'])
    expect(formItem('原因（選填）').find<HTMLTextAreaElement>('textarea').element.value).toBe('家庭旅遊')

    // 沒有後端訊息時用預設文字
    await submit()
    expect(document.body.textContent).toContain('送出失敗，請稍後再試')
    expect(posted()).toHaveLength(2)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('LeaveFormDialog recomputes today on each open', async () => {
    // 台北 2026-10-02 23:59
    vi.setSystemTime(new Date('2026-10-02T15:59:00Z'))
    const wrapper = await mountDialog()
    expect(formItem('請假期間').text()).toContain('最早可選 2026-09-02（30 天前）')

    await wrapper.setProps({ modelValue: false })
    await settle()
    // 跨過台北午夜後重新開啟
    vi.setSystemTime(new Date('2026-10-02T16:01:00Z'))
    await wrapper.setProps({ modelValue: true })
    await settle()

    expect(formItem('請假期間').text()).toContain('最早可選 2026-09-03（30 天前）')
    const picker = rangePicker(wrapper)
    const disabledDate = picker.props('disabledDate') as (d: Date) => boolean
    expect(disabledDate(new Date(2026, 8, 2))).toBe(true)
    expect(disabledDate(new Date(2026, 8, 3))).toBe(false)
    const shortcuts = picker.props('shortcuts') as { text: string; value: () => Date[] }[]
    expect(shortcuts[0]!.value().map((d) => d.getDate())).toEqual([3, 3])
    expect(shortcuts[1]!.value().map((d) => d.getDate())).toEqual([4, 4])
  })
})
