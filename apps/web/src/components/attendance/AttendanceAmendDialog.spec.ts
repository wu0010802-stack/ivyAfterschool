import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { AttendanceRow } from '@/api/attendance'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import dialogSource from './AttendanceAmendDialog.vue?raw'
import AttendanceAmendDialog from './AttendanceAmendDialog.vue'

const PATCH_URL = '/admin/attendance/a1'

function makeRow(overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    id: 'a1',
    student_id: 's1',
    student_no: 'S11301',
    student_name: '王小明',
    grade_level: 3,
    class_id: 'c1',
    class_name: '中年級班',
    service_date: '2026-10-02',
    status: 'present',
    check_in_at: '2026-10-02T06:05:00Z',
    check_in_source: 'manual',
    check_out_at: null,
    check_out_source: null,
    leave: null,
    note: null,
    updated_at: '2026-10-02T06:05:00Z',
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

async function mountDialog(row: AttendanceRow = makeRow()): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(AttendanceAmendDialog, { props: { modelValue: true, row } })
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

function hasFormItem(label: string): boolean {
  return dialog()
    .findAll('.el-form-item__label')
    .some((l) => l.text().trim() === label)
}

async function chooseStatus(label: string): Promise<void> {
  const option = formItem('狀態')
    .findAll('.el-radio-button')
    .find((o) => o.text().trim() === label)
  if (!option) throw new Error(`找不到狀態 ${label}`)
  await option.find('input').setValue(true)
  await settle()
}

async function setTime(label: string, hhmm: string): Promise<void> {
  const input = formItem(label).find('input')
  await input.setValue(hhmm)
  await input.trigger('change')
  await settle()
}

async function setReason(text: string): Promise<void> {
  await formItem('改判原因').find('textarea').setValue(text)
  await settle()
}

function saveButton(): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === '儲存')
  if (!btn) throw new Error('找不到「儲存」')
  return btn
}

async function save(): Promise<void> {
  await saveButton().trigger('click')
  await settle()
}

describe('AttendanceAmendDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('AttendanceAmendDialog requires reason', async () => {
    const wrapper = await mountDialog(makeRow({ status: 'present' }))

    await chooseStatus('預計到班')
    expect(saveButton().attributes('disabled')).toBeUndefined()
    await save()
    await settleErrors()

    expect(formItem('改判原因').text()).toContain('請填寫改判原因，將記錄於稽核紀錄')
    expect(mock.history.patch).toHaveLength(0)
    expect(wrapper.emitted('amended')).toBeUndefined()
  })

  it('AttendanceAmendDialog converts times to utc and sends changed fields', async () => {
    const amended = makeRow({
      status: 'left',
      check_out_at: '2026-10-02T09:30:00Z',
      check_out_source: 'manual',
    })
    mock.onPatch(PATCH_URL).reply(200, amended)
    const wrapper = await mountDialog(
      makeRow({ id: 'a1', service_date: '2026-10-02', status: 'present', check_in_at: '2026-10-02T06:05:00Z' }),
    )

    expect(dialog().find('.el-dialog__title').text()).toBe('改判出勤：王小明')
    expect(formItem('到班時間').find('input').element.value).toBe('14:05')
    expect(hasFormItem('離班時間')).toBe(false)

    await chooseStatus('已離班')
    await setTime('離班時間', '17:30')
    await setReason('家長提早接走未登記')
    await save()

    expect(mock.history.patch.map((c) => c.url)).toEqual([PATCH_URL])
    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({
      status: 'left',
      check_out_at: '2026-10-02T09:30:00.000Z',
      reason: '家長提早接走未登記',
    })
    expect(wrapper.emitted('amended')?.[0]).toEqual([amended])
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
    expect(document.body.textContent).toContain('已改判')
  })

  it('AttendanceAmendDialog validates time order client side', async () => {
    await mountDialog(makeRow({ status: 'present', check_in_at: '2026-10-02T06:05:00Z' }))

    await chooseStatus('已離班')
    await setTime('到班時間', '16:00')
    await setTime('離班時間', '15:00')
    await setReason('補登離班')
    await save()
    await settleErrors()

    expect(formItem('離班時間').text()).toContain('離班時間不可早於到班時間')
    expect(mock.history.patch).toHaveLength(0)
  })

  it('AttendanceAmendDialog maps backend time error', async () => {
    mock.onPatch(PATCH_URL).reply(422, { error: { code: 'time_not_on_service_date', message: '時間必須在出勤當日' } })
    const wrapper = await mountDialog(makeRow({ status: 'present', check_in_at: '2026-10-02T06:05:00Z' }))

    await setTime('到班時間', '14:30')
    await setReason('刷卡時間有誤')
    await save()
    await settleErrors()

    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({
      check_in_at: '2026-10-02T06:30:00.000Z',
      reason: '刷卡時間有誤',
    })
    expect(formItem('到班時間').find('.el-form-item__error').text()).toBe('時間必須在出勤當日')
    expect(wrapper.emitted('amended')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('AttendanceAmendDialog disables save when unchanged', async () => {
    await mountDialog(makeRow({ status: 'present', note: '下午看牙醫' }))

    expect(saveButton().attributes('disabled')).toBeDefined()
    // 只填原因不算變更
    await setReason('確認無誤')
    expect(saveButton().attributes('disabled')).toBeDefined()

    await chooseStatus('已離班')
    expect(saveButton().attributes('disabled')).toBeUndefined()
    await chooseStatus('已到班')
    expect(saveButton().attributes('disabled')).toBeDefined()
  })

  it('AttendanceAmendDialog maps conflict errors to messages', async () => {
    mock
      .onPatch(PATCH_URL)
      .replyOnce(409, { error: { code: 'attendance_managed_by_leave', message: '請假中的出勤只能由請假的建立或取消改變' } })
      .onPatch(PATCH_URL)
      .replyOnce(422, { error: { code: 'no_changes', message: '內容與原紀錄相同' } })
    const wrapper = await mountDialog(makeRow({ status: 'present' }))

    await chooseStatus('缺席')
    await setReason('家長來電請假')
    await save()
    expect(document.body.textContent).toContain('請假中的出勤請到請假頁取消請假')

    await save()
    expect(document.body.textContent).toContain('沒有任何變更')
    expect(JSON.parse(mock.history.patch[1]?.data as string)).toEqual({ status: 'absent', reason: '家長來電請假' })
    expect(wrapper.emitted('amended')).toBeUndefined()
  })

  it('AttendanceAmendDialog keeps touch targets at least 44px', () => {
    // happy-dom 不計算版面：以原始碼斷言狀態分段按鈕與時間欄位的觸控高度（平板 ≥ 44px）
    expect(dialogSource).toMatch(/\.amend-status[^{]*\.el-radio-button__inner[^{]*\{[^}]*min-height:\s*44px/)
    expect(dialogSource).toMatch(/\.amend-times[^{]*\.el-input__wrapper[^{]*\{[^}]*min-height:\s*44px/)
  })
})
