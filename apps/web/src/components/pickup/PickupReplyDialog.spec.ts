import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { adminHttp } from '@/api/http'
import {
  acknowledgePickupRequest,
  replyPickupRequest,
  type PickupQueue,
  type PickupReply,
  type PickupRequest,
} from '@/api/pickupRequests'
import type { PickupBoard } from '@/composables/usePickupBoard'
import { createApiMock, mountWithApp } from '@/test/helpers'
import dialogSource from './PickupReplyDialog.vue?raw'
import PickupReplyDialog from './PickupReplyDialog.vue'

/** 台北 2026-10-02 17:10 */
const NOW = new Date('2026-10-02T09:10:00Z')

function makeRequest(overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id: 'r1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 1, class_id: 'c1', class_name: '低年級A班' },
    service_date: '2026-10-02',
    source: 'parent',
    requested_by_type: 'parent',
    requested_by_name: '王媽媽',
    expected_arrival_at: '17:40',
    status: 'pending',
    homework_status_at_request: 'in_progress',
    current_homework_status: 'in_progress',
    current_ready_eta: '17:30',
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
    created_at: '2026-10-02T08:40:00Z',
    ...overrides,
  }
}

type ReplyBoard = Pick<PickupBoard, 'reply' | 'acknowledge' | 'queue'>

function makeQueue(latest: string): PickupQueue {
  return {
    date: '2026-10-02',
    open: [],
    closed: [],
    counts: { pending: 0, acknowledged: 0, arrived: 0, needs_reply: 0 },
    latest_expected_arrival: latest,
  }
}

/** 直接打 api（axios-mock-adapter 攔截）；其他錯誤 reject，與 board 的約定相同。queue 帶 pickup.window 的最晚時間 */
function httpBoard(latest: string | null = '20:00'): ReplyBoard {
  return {
    reply: (id: string, body: PickupReply) => replyPickupRequest(id, body),
    acknowledge: (id: string) => acknowledgePickupRequest(id),
    queue: shallowRef(latest === null ? null : makeQueue(latest)),
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountDialog(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(PickupReplyDialog, {
    props: { modelValue: true, request: makeRequest(), board: httpBoard(), ...props },
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
    .find((i) => i.find('.el-form-item__label').text().trim().startsWith(label))
  if (!item) throw new Error(`找不到欄位 ${label}`)
  return item
}

function timeValue(): string {
  return formItem('預計可接送時間').find('.el-select__placeholder').text().trim()
}

async function openTimeOptions(): Promise<HTMLElement[]> {
  const item = formItem('預計可接送時間')
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

async function typeMessage(text: string): Promise<void> {
  await formItem('給家長的訊息').find('textarea').setValue(text)
  await settle()
}

function footerButton(text: string): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  return btn
}

function submitButton(): DOMWrapper<Element> {
  const btn = dialog().findAll('.el-dialog__footer button').at(-1)
  if (!btn) throw new Error('找不到送出鈕')
  return btn
}

async function clickButton(text: string): Promise<void> {
  const btn = dialog()
    .findAll('button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  await btn.trigger('click')
  await settle()
}

async function toggleAcknowledge(): Promise<void> {
  await dialog().find('.el-checkbox input').trigger('click')
  await settle()
}

const postUrls = (): string[] => mock.history.post.map((r) => r.url ?? '')
const replyCount = (): number => postUrls().filter((u) => u.endsWith('/reply')).length
const ackCount = (): number => postUrls().filter((u) => u.endsWith('/acknowledge')).length

describe('PickupReplyDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('PickupReplyDialog prefills current ready eta', async () => {
    await mountDialog()

    expect(dialog().find('.el-dialog__title').text()).toBe('回覆預計可接送時間：王小明')
    expect(timeValue()).toBe('17:30')
    const text = dialog().text()
    expect(text).toContain('王小明（低年級A班）')
    expect(text).toContain('預計 17:40 到（約 30 分後）')
    expect(text).toContain('進行中')
    expect(text).toContain('作業預計 17:30 完成')
    expect(text).toContain('尚未回覆')
    expect(text).not.toContain('員工代建的請求')
    // 訊息預設空，placeholder 隨選的時間
    expect(formItem('給家長的訊息').find('textarea').element.value).toBe('')
    expect(formItem('給家長的訊息').find('textarea').attributes('placeholder')).toBe('預計 17:30 可接送')
    expect(formItem('給家長的訊息').find('textarea').attributes('maxlength')).toBe('200')
  })

  it('PickupReplyDialog prefers the previous reply and keeps staff message', async () => {
    await mountDialog({
      request: makeRequest({
        reply_ready_eta: '17:50',
        reply_message: '數學訂正中，17:50 可接',
        reply_source: 'staff',
        replied_by_name: '林行政',
        needs_reply: false,
      }),
    })

    expect(timeValue()).toBe('17:50')
    expect(formItem('給家長的訊息').find('textarea').element.value).toBe('數學訂正中，17:50 可接')
    expect(dialog().text()).toContain('數學訂正中，17:50 可接（林行政 回覆）')

    // 系統自動回覆的訊息不帶入
    document.body.innerHTML = ''
    await mountDialog({
      request: makeRequest({ reply_message: '預計 17:30 可接送', reply_source: 'auto', needs_reply: false }),
    })
    expect(formItem('給家長的訊息').find('textarea').element.value).toBe('')
    expect(dialog().text()).toContain('預計 17:30 可接送（系統自動回覆）')
  })

  it('PickupReplyDialog summarizes arrival and homework states', async () => {
    await mountDialog({
      request: makeRequest({ status: 'arrived', arrived_at: '2026-10-02T09:02:00Z', current_ready_eta: null }),
    })
    expect(dialog().text()).toContain('家長已到・已等 8 分（17:02 到達）')
    expect(dialog().text()).toContain('尚未設定作業預計完成時間')

    document.body.innerHTML = ''
    await mountDialog({
      request: makeRequest({ expected_arrival_at: null, current_homework_status: 'done', current_ready_eta: null }),
    })
    expect(dialog().text()).toContain('家長未指定抵達時間')
    expect(dialog().text()).toContain('已完成')
    expect(dialog().text()).not.toContain('尚未設定作業預計完成時間')
  })

  it('PickupReplyDialog replies and acknowledges', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest({ reply_ready_eta: '17:45', reply_source: 'staff' }))
    mock.onPost('/admin/pickup/requests/r1/acknowledge').reply(200, makeRequest({ status: 'acknowledged' }))
    const wrapper = await mountDialog()

    await chooseTime('17:45')
    await typeMessage('數學訂正中')
    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(postUrls()).toEqual(['/admin/pickup/requests/r1/reply', '/admin/pickup/requests/r1/acknowledge'])
    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({ reply_ready_eta: '17:45', reply_message: '數學訂正中' })
    expect(document.body.textContent).toContain('已回覆家長')
    const done = wrapper.emitted('done') as [PickupRequest][]
    expect(done).toHaveLength(1)
    expect(done[0]?.[0].status).toBe('acknowledged')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('PickupReplyDialog sends only eta when message empty', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest({ reply_ready_eta: '17:45' }))
    const wrapper = await mountDialog()

    await chooseTime('17:45')
    await typeMessage('   ')
    await toggleAcknowledge()
    await footerButton('送出回覆').trigger('click')
    await settle()

    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({ reply_ready_eta: '17:45' })
    expect(ackCount()).toBe(0)
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  it('PickupReplyDialog sends only message when time is cleared', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest())
    await mountDialog({ request: makeRequest({ current_ready_eta: null, status: 'acknowledged' }) })

    await typeMessage('  訂正完就可以接  ')
    await footerButton('送出回覆').trigger('click')
    await settle()

    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({ reply_message: '訂正完就可以接' })
  })

  it('PickupReplyDialog requires eta or message', async () => {
    const wrapper = await mountDialog({ request: makeRequest({ current_ready_eta: null }) })

    await submitButton().trigger('click')
    await vi.waitFor(() => expect(dialog().text()).toContain('請填寫預計時間或訊息'))

    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  it('PickupReplyDialog keeps open when acknowledge fails', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest({ reply_ready_eta: '17:30' }))
    mock.onPost('/admin/pickup/requests/r1/acknowledge').reply(500, {
      error: { code: 'internal_error', message: '伺服器暫時沒有回應', details: null },
    })
    const wrapper = await mountDialog()

    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(dialog().text()).toContain('已回覆，但確認失敗：伺服器暫時沒有回應')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('done')).toBeUndefined()
  })

  it('PickupReplyDialog retries only acknowledge after partial failure', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest({ reply_ready_eta: '17:30' }))
    mock.onPost('/admin/pickup/requests/r1/acknowledge').replyOnce(500, {
      error: { code: 'internal_error', message: '伺服器暫時沒有回應', details: null },
    })
    mock.onPost('/admin/pickup/requests/r1/acknowledge').replyOnce(200, makeRequest({ status: 'acknowledged' }))
    const wrapper = await mountDialog()

    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(submitButton().text()).toBe('重試確認')
    expect(formItem('預計可接送時間').find('input').attributes('disabled')).toBeDefined()
    expect(formItem('給家長的訊息').find('textarea').attributes('disabled')).toBeDefined()

    await footerButton('重試確認').trigger('click')
    await settle()

    expect(replyCount()).toBe(1)
    expect(ackCount()).toBe(2)
    expect(wrapper.emitted('done')).toHaveLength(1)
    expect(document.body.textContent).toContain('已回覆家長')
  })

  it('PickupReplyDialog hides acknowledge option when already acknowledged', async () => {
    await mountDialog({ request: makeRequest({ status: 'acknowledged' }) })

    expect(dialog().text()).not.toContain('同時確認此請求')
    expect(dialog().find('.el-checkbox').exists()).toBe(false)
  })

  it('PickupReplyDialog skips acknowledge when the request is no longer pending', async () => {
    // 送出期間別人已確認：reply 回來的狀態已是 acknowledged，不再送確認（避免 409）
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest({ status: 'acknowledged' }))
    const wrapper = await mountDialog()

    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(ackCount()).toBe(0)
    expect(wrapper.emitted('done')).toHaveLength(1)
  })

  it('PickupReplyDialog shows homework sync notice without extra api call', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest())
    mock.onPost('/admin/pickup/requests/r1/acknowledge').reply(200, makeRequest({ status: 'acknowledged' }))
    await mountDialog()

    expect(dialog().text()).toContain('將同步更新作業看板的預計可接送時間')
    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(mock.history.put.filter((r) => r.url?.startsWith('/admin/homework/progress/'))).toEqual([])
    expect(mock.history.post.filter((r) => r.url?.startsWith('/admin/homework'))).toEqual([])
  })

  it('PickupReplyDialog submit label follows acknowledge option', async () => {
    await mountDialog()
    expect(submitButton().text()).toBe('回覆並確認')

    await toggleAcknowledge()
    expect(submitButton().text()).toBe('送出回覆')

    document.body.innerHTML = ''
    await mountDialog({ request: makeRequest({ status: 'acknowledged' }) })
    expect(submitButton().text()).toBe('送出回覆')
  })

  it('PickupReplyDialog notes staff created requests and says updated', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(200, makeRequest({ requested_by_type: 'staff' }))
    mock.onPost('/admin/pickup/requests/r1/acknowledge').reply(200, makeRequest({ status: 'acknowledged' }))
    await mountDialog({ request: makeRequest({ source: 'staff', requested_by_type: 'staff', requested_by_name: '林行政' }) })

    expect(dialog().text()).toContain('員工代建的請求，回覆不會通知家長。')
    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(document.body.textContent).toContain('已更新回覆')
    expect(document.body.textContent).not.toContain('已回覆家長')
  })

  it('PickupReplyDialog closes without done when the board handled a conflict', async () => {
    // board 已對 404 / 409 提示並重新整理，resolve null
    const board: ReplyBoard = { ...httpBoard(), reply: vi.fn(() => Promise.resolve(null)), acknowledge: vi.fn() }
    const wrapper = await mountDialog({ board })

    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(wrapper.emitted('done')).toBeUndefined()
    expect(board.acknowledge).not.toHaveBeenCalled()
  })

  it('PickupReplyDialog shows other errors above the form and stays open', async () => {
    mock.onPost('/admin/pickup/requests/r1/reply').reply(422, {
      error: { code: 'validation_error', message: '預計時間格式錯誤', details: [] },
    })
    const wrapper = await mountDialog()

    await footerButton('回覆並確認').trigger('click')
    await settle()

    expect(dialog().find('.el-alert--error').text()).toContain('預計時間格式錯誤')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(ackCount()).toBe(0)
  })

  it('PickupReplyDialog quick buttons add minutes from now', async () => {
    vi.setSystemTime(new Date('2026-10-02T09:12:00Z')) // 台北 17:12
    await mountDialog()

    await clickButton('+10 分')
    expect(timeValue()).toBe('17:25')
    await clickButton('+20 分')
    expect(timeValue()).toBe('17:35')
    await clickButton('+30 分')
    expect(timeValue()).toBe('17:45')
    expect(formItem('給家長的訊息').find('textarea').attributes('placeholder')).toBe('預計 17:45 可接送')
  })

  it('PickupReplyDialog limits eta options to latest expected arrival', async () => {
    vi.setSystemTime(new Date('2026-10-02T09:12:00Z')) // 台北 17:12
    await mountDialog({ board: httpBoard('18:30') })

    const options = (await openTimeOptions()).map((o) => o.textContent?.trim())
    expect(options[0]).toBe('17:15')
    expect(options[1]).toBe('17:20')
    expect(options.at(-1)).toBe('18:30')
  })

  it('PickupReplyDialog falls back to default latest when queue missing', async () => {
    await mountDialog({ board: httpBoard(null) })

    const options = (await openTimeOptions()).map((o) => o.textContent?.trim())
    expect(options[0]).toBe('17:10')
    expect(options.at(-1)).toBe('19:00')
  })

  it('PickupReplyDialog quick buttons clamp to latest expected arrival', async () => {
    vi.setSystemTime(new Date('2026-10-02T10:12:00Z')) // 台北 18:12
    await mountDialog({ board: httpBoard('18:30') })

    await clickButton('+10 分')
    expect(timeValue()).toBe('18:25')
    await clickButton('+20 分')
    expect(timeValue()).toBe('18:30')
    await clickButton('+30 分')
    expect(timeValue()).toBe('18:30')

    document.body.innerHTML = ''
    await mountDialog({ board: httpBoard(null) })
    vi.setSystemTime(new Date('2026-10-02T10:52:00Z')) // 台北 18:52，佇列未載入 → 預設 19:00
    await clickButton('+10 分')
    expect(timeValue()).toBe('19:00')
  })

  it('PickupReplyDialog resets the form when reopened', async () => {
    const wrapper = await mountDialog()
    await clickButton('+30 分')
    await typeMessage('先寫一半')

    await wrapper.setProps({ modelValue: false })
    await settle()
    await wrapper.setProps({ modelValue: true })
    await settle()

    expect(timeValue()).toBe('17:30')
    expect(formItem('給家長的訊息').find('textarea').element.value).toBe('')
    expect(submitButton().text()).toBe('回覆並確認')
  })

  it('PickupReplyDialog touch targets follow the approved mockup', () => {
    // happy-dom 不算版面：以原始碼斷言稿的 decisions（快捷鈕與確認勾選 44px）
    expect(dialogSource).toMatch(/\.reply-dialog__quick[^{]*\{[^}]*height:\s*44px/)
    expect(dialogSource).toMatch(/\.reply-dialog__ack[^{]*\{[^}]*height:\s*44px/)
  })
})
