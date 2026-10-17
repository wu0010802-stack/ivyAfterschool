import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { adminHttp } from '@/api/http'
import {
  createPickupRequest,
  type PickupQueue,
  type PickupRequest,
  type PickupRequestCreate,
} from '@/api/pickupRequests'
import StudentSelect from '@/components/student/StudentSelect.vue'
import { createApiMock, mountWithApp } from '@/test/helpers'
import PickupCreateDialog from './PickupCreateDialog.vue'

const CREATE_URL = '/admin/pickup/requests'
const PRESET = { id: 's1', name: '王小明', student_no: 'S11301', class_name: '中年級班' }

function makeQueue(latest: string): PickupQueue {
  return {
    date: '2026-10-02',
    open: [],
    closed: [],
    counts: { pending: 0, acknowledged: 0, arrived: 0, needs_reply: 0 },
    latest_expected_arrival: latest,
  }
}

/** 測試用的 board：create 直接打 API（與 usePickupBoard 的 create 同一支 client）；queue 帶 pickup.window 的最晚時間 */
function makeBoard(latest = '20:00') {
  return {
    create: (body: PickupRequestCreate) => createPickupRequest(body),
    queue: shallowRef<PickupQueue | null>(makeQueue(latest)),
  }
}

function createdRequest(overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id: 'r1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 3, class_id: 'c3', class_name: '中年級班' },
    service_date: '2026-10-02',
    source: 'staff',
    requested_by_type: 'staff',
    requested_by_name: '張主任',
    expected_arrival_at: '17:30',
    status: 'pending',
    homework_status_at_request: 'in_progress',
    current_homework_status: 'in_progress',
    current_ready_eta: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    replied_by_name: null,
    needs_reply: true,
    arrived_at: null,
    completed_at: null,
    completed_by_name: null,
    completion_method: null,
    picked_up_by_name: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-10-02T08:00:00Z',
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

async function mountDialog(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(PickupCreateDialog, { props: { modelValue: true, board: makeBoard(), ...props } })
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
    .find((i) => i.find('.el-form-item__label').text().trim().startsWith(label))
  if (!item) throw new Error(`找不到欄位 ${label}`)
  return item
}

async function openTimeOptions(): Promise<HTMLElement[]> {
  const item = formItem('家長預計抵達時間')
  await item.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = item.find('input').attributes('aria-controls')
  return Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [])
}

async function chooseTime(hhmm: string): Promise<void> {
  const option = (await openTimeOptions()).find((o) => o.textContent?.trim() === hhmm)
  if (!option) throw new Error(`找不到時間 ${hhmm}`)
  option.click()
  await settle()
}

async function submit(): Promise<void> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === '建立請求')
  if (!btn) throw new Error('找不到「建立請求」')
  await btn.trigger('click')
  await settle()
}

function postBody(index = 0): unknown {
  return JSON.parse(mock.history.post[index]?.data as string)
}

describe('PickupCreateDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 台北 16:02
    vi.setSystemTime(new Date('2026-10-02T08:02:00Z'))
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('PickupCreateDialog creates for preset student', async () => {
    const created = createdRequest()
    mock.onPost(CREATE_URL).reply(201, created)
    const wrapper = await mountDialog({ presetStudent: PRESET })

    expect(dialog().find('.el-dialog__title').text()).toBe('代建接送請求')
    expect(formItem('學生').text()).toContain('王小明（S11301・中年級班）')
    expect(wrapper.findComponent(StudentSelect).exists()).toBe(false)
    expect(dialog().text()).toContain('員工代建的請求不會通知家長；系統會依作業進度自動產生回覆供參考。')

    await chooseTime('17:30')
    await submit()

    expect(mock.history.post.map((c) => c.url)).toEqual([CREATE_URL])
    expect(postBody()).toEqual({ student_id: 's1', expected_arrival_at: '17:30' })
    expect(document.body.textContent).toContain('已建立接送請求')
    expect(wrapper.emitted('created')?.[0]).toEqual([created])
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('PickupCreateDialog omits empty arrival time', async () => {
    mock.onPost(CREATE_URL).reply(201, createdRequest({ expected_arrival_at: null }))
    await mountDialog({ presetStudent: PRESET })

    await submit()

    expect(postBody()).toEqual({ student_id: 's1' })
  })

  it('PickupCreateDialog offers arrival times from five minutes ago', async () => {
    await mountDialog({ presetStudent: PRESET })

    // 現在 16:02 → 最早 15:57 進位到 5 分 = 16:00，每 5 分一格到佇列的 latest_expected_arrival（20:00）
    const options = (await openTimeOptions()).map((o) => o.textContent?.trim())
    expect(options[0]).toBe('16:00')
    expect(options[1]).toBe('16:05')
    expect(options.at(-1)).toBe('20:00')
    expect(formItem('家長預計抵達時間').find('.el-select__placeholder').text()).toBe('不指定')
  })

  it('PickupCreateDialog limits arrival options to latest expected arrival', async () => {
    const board = makeBoard('20:00')
    const wrapper = await mountDialog({ presetStudent: PRESET, board })

    let options = (await openTimeOptions()).map((o) => o.textContent?.trim())
    expect(options[0]).toBe('16:00')
    expect(options.at(-1)).toBe('20:00')

    board.queue.value = makeQueue('17:00')
    await wrapper.setProps({ modelValue: false })
    await settle()
    await wrapper.setProps({ modelValue: true })
    await settle()
    options = (await openTimeOptions()).map((o) => o.textContent?.trim())
    expect(options[0]).toBe('16:00')
    expect(options.at(-1)).toBe('17:00')
  })

  it('PickupCreateDialog has no arrival options after latest', async () => {
    vi.setSystemTime(new Date('2026-10-02T11:40:00Z')) // 台北 19:40
    mock.onPost(CREATE_URL).reply(201, createdRequest({ expected_arrival_at: null }))
    await mountDialog({ presetStudent: PRESET, board: makeBoard('19:00') })

    expect(await openTimeOptions()).toEqual([])
    await submit()

    expect(postBody()).toEqual({ student_id: 's1' })
  })

  it('PickupCreateDialog requires student when not preset', async () => {
    const wrapper = await mountDialog()

    await submit()
    await settleErrors()

    expect(formItem('學生').text()).toContain('請選擇學生')
    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('created')).toBeUndefined()
  })

  it('PickupCreateDialog shows existing request conflict', async () => {
    mock.onPost(CREATE_URL).reply(409, { error: { code: 'pickup_request_exists', message: 'request exists' } })
    const wrapper = await mountDialog({ presetStudent: PRESET })

    await submit()

    expect(dialog().text()).toContain('此學生今天已有進行中的接送請求')
    expect(wrapper.emitted('created')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('PickupCreateDialog shows backend message for unavailable student', async () => {
    mock
      .onPost(CREATE_URL)
      .replyOnce(409, { error: { code: 'student_not_available', message: '學生今天請假、缺席或已離班' } })
      .onPost(CREATE_URL)
      .replyOnce(422, { error: { code: 'expected_arrival_in_past', message: '預計抵達時間不可早於現在' } })
    await mountDialog({ presetStudent: PRESET })

    await submit()
    expect(dialog().text()).toContain('學生今天請假、缺席或已離班')

    await submit()
    expect(dialog().text()).toContain('預計抵達時間不可早於現在')
    expect(dialog().text()).not.toContain('學生今天請假、缺席或已離班')
  })

  it('PickupCreateDialog closes quietly when board already handled the error', async () => {
    const wrapper = await mountDialog({ presetStudent: PRESET, board: { ...makeBoard(), create: () => Promise.resolve(null) } })

    await submit()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
    expect(wrapper.emitted('created')).toBeUndefined()
    expect(document.body.textContent).not.toContain('已建立接送請求')
  })

  it('PickupCreateDialog limits student search to class filter', async () => {
    const wrapper = await mountDialog({ classFilter: { id: 'c3', name: '中年級班' } })

    const select = wrapper.findComponent(StudentSelect)
    expect(select.props('classId')).toBe('c3')
    expect(select.props('placeholder')).toBe('輸入學號或姓名（中年級班）')

    document.body.innerHTML = ''
    const all = await mountDialog()
    expect(all.findComponent(StudentSelect).props('classId')).toBeUndefined()
    expect(all.findComponent(StudentSelect).props('placeholder')).toBe('輸入學號或姓名搜尋')
  })
})
