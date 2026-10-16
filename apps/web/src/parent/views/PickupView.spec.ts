import { DOMWrapper, flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PICKUP_REQUEST_STATUS_META } from '@/shared/constants/statusLabels'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ChildDetail, ChildSummary } from '../api/children'
import type { HomeworkToday } from '../api/homework'
import { parentHttp } from '../api/http'
import type { ParentPickupRequest } from '../api/pickupRequests'
import { useParentWsStore } from '../stores/parentWs'
import { useSnackbarStore } from '../stores/snackbar'
import PickupView from './PickupView.vue'

// 最小假 WebSocket：只做 parentWs store 需要的 open / message
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  close(): void {
    this.readyState = 3
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverMessage(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, sent_at: '2026-10-07T09:23:00Z' }) } as MessageEvent)
  }
}

// 系統時間固定台北 2026-10-07（三）17:22
const NOW = new Date('2026-10-07T09:22:00Z')
const TODAY = '2026-10-07'
const SELECTED_KEY = 'parent_selected_child_v1'
const SKIP_KEY = 'parent_pickup_arrive_skip_confirm'
const CHILDREN_URL = '/parent/children'
const TODAY_URL = '/parent/pickup/requests/today'
const CREATE_URL = '/parent/pickup/requests'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }

const childUrl = (id: string) => `/parent/children/${id}`
const homeworkUrl = (id: string) => `/parent/children/${id}/homework`
const arrivedUrl = (id: string) => `/parent/pickup/requests/${id}/arrived`
const cancelUrl = (id: string) => `/parent/pickup/requests/${id}/cancel`
const apiError = (code: string, message = '錯誤', details: unknown = null) => ({ error: { code, message, details } })

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級 A 班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

function detail(id: string, canPickup = true): ChildDetail {
  const base = KIDS.find((k) => k.id === id) ?? child(id, '王小美')
  return {
    ...base,
    school_class: null,
    enrolled_on: null,
    my_guardian: { relation: 'mother', is_primary: true, can_pickup: canPickup, receives_notifications: true },
  }
}

function homework(id: string, overrides: Partial<HomeworkToday> = {}): HomeworkToday {
  return {
    student_id: id,
    date: TODAY,
    items: [
      { title: '國語習作', subject_name: '國語', status: 'done' },
      { title: '數學習作', subject_name: '數學', status: 'done' },
      { title: '英文單字', subject_name: '英文', status: 'in_progress' },
    ],
    overall_status: 'in_progress',
    ready_eta: '17:30',
    note: null,
    updated_at: '2026-10-07T09:00:00Z',
    ...overrides,
  } as HomeworkToday
}

function request(id: string, overrides: Partial<ParentPickupRequest> = {}): ParentPickupRequest {
  return {
    id,
    student_id: 's1',
    student_name: '王小明',
    service_date: TODAY,
    status: 'pending',
    expected_arrival_at: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    arrived_at: null,
    completed_at: null,
    picked_up_by_name: null,
    cancelled_at: null,
    created_at: '2026-10-07T09:05:00Z',
    can_cancel: true,
    can_mark_arrived: true,
    ...overrides,
  }
}

/** 可手動決定何時回應的 reply */
function deferredReply() {
  let resolve!: (value: [number, unknown]) => void
  const promise = new Promise<[number, unknown]>((r) => {
    resolve = r
  })
  return { reply: () => promise, resolve }
}

type Reply = [number, unknown] | (() => Promise<[number, unknown]>)

interface Setup {
  kids?: ChildSummary[]
  selected?: string
  /** 依序回應，用完重複最後一個 */
  today?: Reply[]
  detail?: Record<string, Reply[]>
  homework?: Record<string, Reply[]>
  pinia?: Record<string, unknown>
}

let mock: MockAdapter
let mounted: MountedApp | null = null

function serve(url: string, replies: Reply[]): void {
  let i = 0
  mock.onGet(url).reply(() => {
    const r = replies[Math.min(i, replies.length - 1)]!
    i += 1
    return typeof r === 'function' ? r() : r
  })
}

async function mountPickup(setup: Setup = {}): Promise<MountedApp> {
  const kids = setup.kids ?? KIDS
  mock.onGet(CHILDREN_URL).reply(200, kids)
  serve(TODAY_URL, setup.today ?? [[200, []]])
  for (const k of kids) {
    serve(childUrl(k.id), setup.detail?.[k.id] ?? [[200, detail(k.id)]])
    serve(homeworkUrl(k.id), setup.homework?.[k.id] ?? [[200, homework(k.id)]])
  }
  if (setup.selected) localStorage.setItem(SELECTED_KEY, setup.selected)
  mounted = await mountWithApp(PickupView, { piniaInitialState: setup.pinia })
  return mounted
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  localStorage.removeItem(SELECTED_KEY)
  localStorage.removeItem(SKIP_KEY)
  mock = createApiMock(parentHttp)
})

afterEach(() => {
  if (mounted) useParentWsStore(mounted.pinia).disconnect()
  mounted?.wrapper.unmount()
  mounted = null
  mock.restore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.removeItem(SELECTED_KEY)
  localStorage.removeItem(SKIP_KEY)
  Reflect.deleteProperty(document, 'visibilityState')
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

type Wrapper = MountedApp['wrapper']

const body = () => document.body
const root = (w: Wrapper) => w.element as Element
const gets = (url: string) => mock.history.get.filter((r) => r.url === url).length
const posts = () => mock.history.post.map((r) => r.url)
const postBody = (i: number) => JSON.parse((mock.history.post[i]!.data as string | undefined) ?? '{}') as unknown
const alertDialog = () => body().querySelector<HTMLElement>('[role="alertdialog"]')
const skeletons = (w: Wrapper) => w.findAll('.skeleton[aria-busy="true"]')

/** 按鈕文字去掉圖示 ligature（M3Icon 的文字就是圖示名稱）與轉圈 */
function buttonLabel(b: Element): string {
  const clone = b.cloneNode(true) as Element
  clone.querySelectorAll('.m3-icon, [aria-hidden="true"]').forEach((el) => el.remove())
  return clone.textContent?.trim() ?? ''
}

function findButton(scope: ParentNode, label: string): HTMLButtonElement | null {
  return Array.from(scope.querySelectorAll('button')).find((b) => buttonLabel(b) === label) ?? null
}

function button(scope: Wrapper | ParentNode, label: string): HTMLButtonElement {
  const found = findButton('element' in scope ? root(scope as Wrapper) : scope, label)
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

const hasButton = (w: Wrapper, label: string) => findButton(root(w), label) !== null

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('找不到要點擊的元素')
  await new DOMWrapper(el).trigger('click')
  await flushPromises()
}

async function confirmDialog(label: string): Promise<void> {
  const dialog = alertDialog()
  if (!dialog) throw new Error('確認對話框沒有開啟')
  await click(button(dialog, label))
}

async function switchChild(w: Wrapper, name: string): Promise<void> {
  await click(w.get('button.cch').element)
  const option = Array.from(body().querySelectorAll('.cch-option')).find(
    (o) => o.querySelector('.cch-option__name')?.textContent === name,
  )
  await click(option)
}

function formCard(w: Wrapper) {
  return w.get('.pk-form')
}

/** 表單卡內錯誤（role=alert）的文字，去掉圖示 ligature */
function formError(w: Wrapper): string {
  return buttonLabel(formCard(w).get('[role="alert"]').element)
}

function snackbar(): [string, string][] {
  return useSnackbarStore().items.map((i) => [i.message, i.tone])
}

async function becomeVisible(): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
}

describe('PickupView', () => {
  it('PickupView creates request and shows auto reply', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).reply(201, request('r1', { reply_message: '作業已完成，可以接送', reply_source: 'auto' }))

    expect(formCard(wrapper).text()).toContain('我要來接')
    expect(formCard(wrapper).text()).toContain('通知老師您正在路上，系統會立即回覆預計可接送時間')
    await click(button(wrapper, '通知安親班'))

    expect(posts()).toEqual([CREATE_URL])
    expect(postBody(0)).toEqual({ student_id: 's1' })
    expect(wrapper.text()).toContain('作業已完成，可以接送')
    expect(hasButton(wrapper, '我到了')).toBe(true)
    expect(hasButton(wrapper, '取消接送')).toBe(true)
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
    expect(wrapper.get('.pk-req').text()).toContain('今天的接送')
    expect(wrapper.get('.pk-req .status-pill').text()).toBe(PICKUP_REQUEST_STATUS_META.pending.label)
    expect(snackbar()).toEqual([['已通知安親班', 'info']])
  })

  it('PickupView sends the chosen arrival time and resets it after success', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).replyOnce(201, request('r1', { expected_arrival_at: '17:32' }))
    mock.onPost(cancelUrl('r1')).replyOnce(200, request('r1', { status: 'cancelled', cancelled_at: '2026-10-07T09:23:00Z' }))

    const chip = Array.from(root(wrapper).querySelectorAll('button')).find((b) => b.textContent?.includes('約 10 分鐘後'))
    await click(chip)
    await click(button(wrapper, '通知安親班'))

    expect(postBody(0)).toEqual({ student_id: 's1', expected_arrival_at: '17:32' })
    expect(wrapper.get('.pk-req').text()).toContain('您預計 17:32 抵達')

    await click(button(wrapper, '取消接送'))
    await confirmDialog('確定取消')
    await vi.waitFor(() => expect(alertDialog()).toBeNull())

    // 回到表單時抵達時間是「不指定」
    const selected = Array.from(formCard(wrapper).element.querySelectorAll('.m3-chip[aria-pressed="true"]'))
    expect(selected.map(buttonLabel)).toEqual(['不指定'])
    expect(formCard(wrapper).find('input[type="time"]').exists()).toBe(false)
  })

  it('PickupView request uses selected child', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).reply(201, request('r2', { student_id: 's2', student_name: '王小華' }))

    await switchChild(wrapper, '王小華')

    expect(gets(childUrl('s2'))).toBe(1)
    expect(gets(homeworkUrl('s2'))).toBe(1)
    // 今日請求是全部小孩共用，不重抓
    expect(gets(TODAY_URL)).toBe(1)

    await click(button(wrapper, '通知安親班'))

    expect((postBody(0) as { student_id: string }).student_id).toBe('s2')
    expect(wrapper.get('.cch__name').text()).toBe('王小華')
  })

  it('PickupView no permission hides form', async () => {
    const { wrapper } = await mountPickup({ detail: { s1: [[200, detail('s1', false)]] } })

    const empty = wrapper.get('.empty-state')
    expect(empty.text()).toContain('您沒有這位小孩的接送權限')
    expect(empty.text()).toContain('如需接送請聯絡安親班')
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
    expect(hasButton(wrapper, '我已經到了')).toBe(false)
  })

  it('PickupView shows an open request even without pickup permission', async () => {
    const { wrapper } = await mountPickup({
      detail: { s1: [[200, detail('s1', false)]] },
      today: [[200, [request('r1', { status: 'acknowledged' })]]],
    })

    expect(wrapper.find('.empty-state').exists()).toBe(false)
    expect(hasButton(wrapper, '我到了')).toBe(true)
  })

  it('PickupView arrived with confirm and skip', async () => {
    const { wrapper } = await mountPickup({
      today: [
        [200, [request('r1', { status: 'acknowledged' })]],
        [200, [request('r1', { status: 'cancelled', can_cancel: false, can_mark_arrived: false }), request('r2', { created_at: '2026-10-07T09:24:00Z' })]],
      ],
    })
    mock.onPost(arrivedUrl('r1')).reply(200, request('r1', { status: 'arrived', can_mark_arrived: false }))
    mock.onPost(arrivedUrl('r2')).reply(200, request('r2', { status: 'arrived', can_mark_arrived: false }))

    await click(button(wrapper, '我到了'))

    const dialog = alertDialog()!
    expect(dialog.textContent).toContain('確認已抵達安親班？')
    expect(dialog.textContent).toContain('老師會收到通知並準備帶孩子出來')
    const skip = dialog.querySelector<HTMLInputElement>('label.check-row input[type="checkbox"]')!
    expect(skip.closest('label')?.textContent?.trim()).toBe('下次不再提醒')
    skip.checked = true
    await new DOMWrapper(skip).trigger('change')
    await confirmDialog('我到了')

    expect(posts()).toEqual([arrivedUrl('r1')])
    expect(localStorage.getItem(SKIP_KEY)).toBe('1')
    expect(wrapper.get('.pk-req .status-pill').text()).toBe(PICKUP_REQUEST_STATUS_META.arrived.label)
    expect(hasButton(wrapper, '我到了')).toBe(false)
    expect(snackbar()).toEqual([['已通知老師您到了', 'info']])
    await vi.waitFor(() => expect(alertDialog()).toBeNull())

    // 新的 pending 請求：直接送出、不出現對話框
    await becomeVisible()
    expect(wrapper.get('.pk-req .status-pill').text()).toBe(PICKUP_REQUEST_STATUS_META.pending.label)
    await click(button(wrapper, '我到了'))

    expect(alertDialog()).toBeNull()
    expect(posts()).toEqual([arrivedUrl('r1'), arrivedUrl('r2')])
  })

  it('PickupView disables cancel while arriving', async () => {
    localStorage.setItem(SKIP_KEY, '1')
    const { wrapper } = await mountPickup({ today: [[200, [request('r1')]]] })
    const pending = deferredReply()
    mock.onPost(arrivedUrl('r1')).reply(pending.reply)

    await click(button(wrapper, '我到了'))

    expect(button(wrapper, '我到了').getAttribute('aria-busy')).toBe('true')
    expect(button(wrapper, '取消接送').disabled).toBe(true)

    pending.resolve([200, request('r1', { status: 'arrived', can_mark_arrived: false })])
    await flushPromises()
    expect(button(wrapper, '取消接送').disabled).toBe(false)
  })

  it('PickupView cancel requires confirm', async () => {
    const { wrapper } = await mountPickup({ today: [[200, [request('r1')]]] })
    mock.onPost(cancelUrl('r1')).reply(200, request('r1', { status: 'cancelled', cancelled_at: '2026-10-07T09:23:00Z', can_cancel: false, can_mark_arrived: false }))

    await click(button(wrapper, '取消接送'))
    let dialog = alertDialog()!
    expect(dialog.textContent).toContain('取消這次接送？')
    await click(button(dialog, '先不要'))
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
    expect(mock.history.post).toHaveLength(0)

    await click(button(wrapper, '取消接送'))
    dialog = alertDialog()!
    await click(button(dialog, '確定取消'))

    expect(posts()).toEqual([cancelUrl('r1')])
    expect(snackbar()).toEqual([['已取消接送', 'info']])
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    expect(hasButton(wrapper, '取消接送')).toBe(false)
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
    // 今日紀錄多一列
    expect(wrapper.get('.pk-history').text()).toContain('17:23 取消')
  })

  it('PickupView cancel shows loading while sending', async () => {
    const { wrapper } = await mountPickup({ today: [[200, [request('r1')]]] })
    const pending = deferredReply()
    mock.onPost(cancelUrl('r1')).reply(pending.reply)

    await click(button(wrapper, '取消接送'))
    await confirmDialog('確定取消')

    const dialog = alertDialog()!
    expect(button(dialog, '確定取消').getAttribute('aria-busy')).toBe('true')
    expect(button(dialog, '先不要').disabled).toBe(true)
    await click(button(dialog, '確定取消'))
    expect(mock.history.post).toHaveLength(1)

    pending.resolve([200, request('r1', { status: 'cancelled', cancelled_at: '2026-10-07T09:23:00Z', can_cancel: false, can_mark_arrived: false })])
    await flushPromises()
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
  })

  it('PickupView shows window closed error in form', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).replyOnce(409, apiError('pickup_window_closed', '目前不在可發起接送的時段（15:00~19:00）'))
    const second = deferredReply()
    mock.onPost(CREATE_URL).replyOnce(second.reply)

    await click(button(wrapper, '通知安親班'))

    expect(formError(wrapper)).toBe('目前不在可發起接送的時段（15:00~19:00）')
    // 錯誤在選擇器與送出鈕之間
    const order = Array.from(formCard(wrapper).element.querySelectorAll('.arrival, [role="alert"], .pk-form__submit'))
    expect(order.map((el) => (el.matches('.arrival') ? 'picker' : el.matches('[role="alert"]') ? 'error' : 'submit'))).toEqual([
      'picker',
      'error',
      'submit',
    ])
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    expect(snackbar()).toEqual([])
    expect(gets(TODAY_URL)).toBe(1)

    // 下次送出時（回應前）就清除
    await click(button(wrapper, '通知安親班'))
    expect(wrapper.text()).not.toContain('目前不在可發起接送的時段')
    second.resolve([201, request('r1')])
    await flushPromises()
  })

  it('PickupView existing request conflict syncs', async () => {
    const { wrapper } = await mountPickup({
      today: [
        [200, []],
        [200, [request('r9', { status: 'acknowledged', reply_ready_eta: '17:45', reply_message: '預計 17:45 可接送', reply_source: 'staff', replied_at: '2026-10-07T09:18:00Z' })]],
      ],
    })
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_request_exists', '今天已有接送請求', { request_id: 'r9' }))

    await click(button(wrapper, '通知安親班'))

    expect(snackbar()).toEqual([['今天已有接送請求，已更新狀態', 'error']])
    expect(wrapper.get('.pk-req').text()).toContain('預計 17:45 可接送')
    expect(formCardExists(wrapper)).toBe(false)
  })

  it('PickupView other create errors show a generic snackbar', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).replyOnce(500, SERVER_ERROR)
    mock.onPost(CREATE_URL).replyOnce(409, apiError('invalid_pickup_status', '狀態不允許'))

    await click(button(wrapper, '通知安親班'))
    await click(button(wrapper, '通知安親班'))

    expect(snackbar()).toEqual([
      ['送出失敗，請稍後再試', 'error'],
      ['狀態已更新，請確認後再操作', 'error'],
    ])
    expect(formCard(wrapper).find('[role="alert"]').exists()).toBe(false)
  })

  it('PickupView completed card', async () => {
    const { wrapper } = await mountPickup({
      today: [[200, [request('r1', { status: 'completed', completed_at: '2026-10-07T09:40:00Z', picked_up_by_name: '王媽媽', can_cancel: false, can_mark_arrived: false })]]],
    })

    const done = wrapper.get('.pk-done')
    expect(done.attributes('role')).toBe('status')
    expect(done.text()).toContain('17:40 已由 王媽媽 接走')
    expect(done.text()).toContain('今天的接送已完成')
    const again = button(wrapper, '需要再次接送？')
    expect(again.getAttribute('aria-expanded')).toBe('false')
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
    expect(hasButton(wrapper, '我已經到了')).toBe(false)

    await click(again)

    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    expect(hasButton(wrapper, '我已經到了')).toBe(true)
    expect(hasButton(wrapper, '需要再次接送？')).toBe(false)
    expect(wrapper.find('.pk-done').exists()).toBe(true)
  })

  it('PickupView completed card without picker name', async () => {
    const { wrapper } = await mountPickup({
      today: [[200, [request('r1', { status: 'completed', completed_at: '2026-10-07T09:40:00Z', picked_up_by_name: null, can_cancel: false, can_mark_arrived: false })]]],
    })

    expect(wrapper.get('.pk-done__title').text()).toBe('今天已接走')
  })

  it('PickupView arrive now shortcut without request', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).reply(
      201,
      request('r8', { status: 'arrived', reply_message: '作業已完成，可以接送', reply_source: 'auto', replied_at: '2026-10-07T09:22:00Z', can_cancel: true, can_mark_arrived: false }),
    )

    expect(wrapper.text()).toContain('人已在安親班門口時使用，不必先通知')
    await click(button(wrapper, '我已經到了'))

    expect(alertDialog()?.textContent).toContain('確認已抵達安親班？')
    await confirmDialog('我到了')

    expect(posts()).toEqual([CREATE_URL])
    expect(postBody(0)).toEqual({ student_id: 's1', arrived: true })
    expect(wrapper.text()).toContain('作業已完成，可以接送')
    expect(wrapper.text()).toContain('系統自動回覆')
    expect(formCardExists(wrapper)).toBe(false)
    expect(hasButton(wrapper, '我到了')).toBe(false)
    expect(hasButton(wrapper, '我已經到了')).toBe(false)
    expect(snackbar()).toEqual([['已通知老師您到了', 'info']])
  })

  it('PickupView arrive now shows loading and blocks the form while sending', async () => {
    localStorage.setItem(SKIP_KEY, '1')
    const { wrapper } = await mountPickup()
    const pending = deferredReply()
    mock.onPost(CREATE_URL).reply(pending.reply)

    await click(button(wrapper, '我已經到了'))

    expect(button(wrapper, '我已經到了').getAttribute('aria-busy')).toBe('true')
    expect(button(wrapper, '通知安親班').disabled).toBe(true)
    expect(alertDialog()).toBeNull()

    pending.resolve([201, request('r8', { status: 'arrived', can_mark_arrived: false })])
    await flushPromises()
    expect(formCardExists(wrapper)).toBe(false)
  })

  it('PickupView submit shows loading and blocks arrive now while sending', async () => {
    const { wrapper } = await mountPickup()
    const pending = deferredReply()
    mock.onPost(CREATE_URL).reply(pending.reply)

    await click(button(wrapper, '通知安親班'))

    expect(button(wrapper, '通知安親班').getAttribute('aria-busy')).toBe('true')
    expect(button(wrapper, '我已經到了').disabled).toBe(true)
    await click(button(wrapper, '通知安親班'))
    expect(mock.history.post).toHaveLength(1)

    pending.resolve([201, request('r1')])
    await flushPromises()
    expect(hasButton(wrapper, '我到了')).toBe(true)
  })

  it('PickupView arrive now falls back on existing request', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_request_exists', '今天已有接送請求', { request_id: 'r7' }))
    mock.onPost(arrivedUrl('r7')).reply(
      200,
      request('r7', { status: 'arrived', reply_message: '預計 17:30 可接送', reply_ready_eta: '17:30', reply_source: 'auto', can_mark_arrived: false }),
    )

    await click(button(wrapper, '我已經到了'))
    await confirmDialog('我到了')

    expect(posts()).toEqual([CREATE_URL, arrivedUrl('r7')])
    expect(wrapper.get('.pk-req .status-pill').text()).toBe(PICKUP_REQUEST_STATUS_META.arrived.label)
    expect(wrapper.get('.pk-req').text()).toContain('預計 17:30 可接送')
    expect(snackbar()).toEqual([['已通知老師您到了', 'info']])
  })

  it('PickupView request not found refreshes', async () => {
    const { wrapper } = await mountPickup({ today: [[200, [request('r1')]], [200, []]] })
    mock.onPost(cancelUrl('r1')).reply(404, apiError('pickup_request_not_found', '找不到接送請求'))

    await click(button(wrapper, '取消接送'))
    await confirmDialog('確定取消')

    expect(gets(TODAY_URL)).toBe(2)
    expect(snackbar()).toEqual([['找不到這筆接送請求，已重新整理', 'error']])
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
    expect(formCard(wrapper).text()).toContain('我要來接')
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
  })

  it('PickupView cancel invalid status closes and syncs', async () => {
    const { wrapper } = await mountPickup({
      today: [
        [200, [request('r1')]],
        [200, [request('r1', { status: 'completed', completed_at: '2026-10-07T09:20:00Z', picked_up_by_name: '王爸爸', can_cancel: false, can_mark_arrived: false })]],
      ],
    })
    mock.onPost(cancelUrl('r1')).reply(409, apiError('invalid_pickup_status', '狀態不允許'))

    await click(button(wrapper, '取消接送'))
    await confirmDialog('確定取消')

    expect(snackbar()).toEqual([['狀態已更新，請確認後再操作', 'error']])
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
    expect(wrapper.get('.pk-done').text()).toContain('17:20 已由 王爸爸 接走')
  })

  it('PickupView shows suspended error in form', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).reply(409, apiError('student_not_active', '此學生目前暫停，無法進行此操作'))

    await click(button(wrapper, '通知安親班'))

    expect(formError(wrapper)).toBe('此學生目前暫停，無法進行此操作')
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    expect(mock.history.post).toHaveLength(1)
    expect(gets(TODAY_URL)).toBe(1)
    expect(snackbar()).toEqual([])
  })

  it('PickupView shows other form business errors in the form', async () => {
    const { wrapper } = await mountPickup()
    const cases: [string, string][] = [
      ['student_not_available', '學生今天請假、缺席或已離班'],
      ['not_service_day', '今天不是營業日'],
      ['expected_arrival_in_past', '預計抵達時間已經過了'],
      ['expected_arrival_too_late', '預計抵達時間最晚為 19:00'],
    ]
    for (const [code, message] of cases) mock.onPost(CREATE_URL).replyOnce(422, apiError(code, message))

    for (const [, message] of cases) {
      await click(button(wrapper, '通知安親班'))
      expect(formError(wrapper)).toBe(message)
    }
    expect(snackbar()).toEqual([])
  })

  it('PickupView not allowed refetches child', async () => {
    const { wrapper } = await mountPickup({ detail: { s1: [[200, detail('s1', true)], [200, detail('s1', false)]] } })
    mock.onPost(CREATE_URL).reply(403, apiError('pickup_not_allowed', '沒有接送權限'))

    await click(button(wrapper, '通知安親班'))

    expect(snackbar()).toEqual([['您沒有這位小孩的接送權限', 'error']])
    expect(gets(childUrl('s1'))).toBe(2)
    expect(wrapper.get('.empty-state').text()).toContain('您沒有這位小孩的接送權限')
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
  })

  it('PickupView child detail error still shows form', async () => {
    const { wrapper } = await mountPickup({ detail: { s1: [[500, SERVER_ERROR]] } })

    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    expect(hasButton(wrapper, '我已經到了')).toBe(true)
    expect(skeletons(wrapper)).toHaveLength(0)
  })

  it('PickupView skeleton until can_pickup known', async () => {
    const pending = deferredReply()
    const { wrapper } = await mountPickup({
      detail: { s1: [pending.reply] },
      today: [[200, [request('r0', { status: 'cancelled', cancelled_at: '2026-10-07T08:12:00Z', can_cancel: false, can_mark_arrived: false })]]],
    })

    expect(wrapper.text()).not.toContain('今日紀錄')
    const sk = skeletons(wrapper)
    expect(sk).toHaveLength(1)
    expect(sk[0]!.findAll('.skeleton-card')).toHaveLength(2)
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
    expect(hasButton(wrapper, '我已經到了')).toBe(false)

    pending.resolve([200, detail('s1', true)])
    await flushPromises()

    expect(skeletons(wrapper)).toHaveLength(0)
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    expect(wrapper.get('.pk-section').text()).toBe('今日紀錄')
  })

  it('PickupView skeleton until today requests load', async () => {
    const pending = deferredReply()
    const { wrapper } = await mountPickup({ today: [pending.reply] })

    expect(skeletons(wrapper)).toHaveLength(1)
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
    // 代理接送入口任何狀態都顯示
    expect(wrapper.get('.pk-proxy').text()).toContain('代理接送與常用接送人')

    pending.resolve([200, []])
    await flushPromises()
    expect(skeletons(wrapper)).toHaveLength(0)
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
  })

  it('PickupView keeps known permission without skeleton when switching back', async () => {
    const s1Again = deferredReply()
    const { wrapper } = await mountPickup({ detail: { s1: [[200, detail('s1', false)], s1Again.reply] } })

    await switchChild(wrapper, '王小華')
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    await switchChild(wrapper, '王小明')

    // 第二次取得 s1 前沿用上次的結果
    expect(gets(childUrl('s1'))).toBe(2)
    expect(skeletons(wrapper)).toHaveLength(0)
    expect(wrapper.get('.empty-state').text()).toContain('您沒有這位小孩的接送權限')
  })

  it('PickupView form error clears on child switch', async () => {
    const { wrapper } = await mountPickup()
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_window_closed', '接送請求開放時間為 12:00～19:00'))

    await click(button(wrapper, '通知安親班'))
    expect(formCard(wrapper).text()).toContain('接送請求開放時間為 12:00～19:00')

    await switchChild(wrapper, '王小華')

    expect(wrapper.get('.cch__name').text()).toBe('王小華')
    expect(wrapper.text()).not.toContain('接送請求開放時間為 12:00～19:00')
  })

  it('PickupView homework hint', async () => {
    const hint = async (reply: Reply): Promise<[string, string] | null> => {
      const { wrapper } = await mountPickup({ homework: { s1: [reply] } })
      const el = wrapper.find('.hw-hint')
      const result: [string, string] | null = el.exists() ? [el.get('.m3-icon').text(), el.get('.hw-hint__text').text()] : null
      mounted?.wrapper.unmount()
      mounted = null
      mock.reset()
      return result
    }

    expect(await hint([200, homework('s1')])).toEqual(['assignment', '作業進度 2/3 · 預計 17:30 可接送'])
    expect(await hint([200, homework('s1', { ready_eta: null })])).toEqual(['assignment', '作業進度 2/3'])
    expect(await hint([200, homework('s1', { overall_status: 'done', ready_eta: '17:30' })])).toEqual(['check_circle', '作業已完成'])
    expect(await hint([200, homework('s1', { items: [], overall_status: 'not_started', ready_eta: null })])).toEqual([
      'assignment',
      '今天尚無作業項目',
    ])
    expect(await hint([200, homework('s1', { items: [], overall_status: 'not_started', ready_eta: '18:00' })])).toEqual([
      'assignment',
      '今天尚無作業項目 · 預計 18:00 可接送',
    ])

    const failed = await mountPickup({ homework: { s1: [[500, SERVER_ERROR]] } })
    expect(failed.wrapper.find('.hw-hint').exists()).toBe(false)
    expect(failed.wrapper.text()).not.toContain('作業進度')
    expect(failed.wrapper.text()).not.toContain('今天尚無作業項目')
  })

  it('PickupView homework hint waits for the first homework response', async () => {
    const pending = deferredReply()
    const { wrapper } = await mountPickup({ homework: { s1: [pending.reply] } })

    expect(wrapper.find('.hw-hint').exists()).toBe(false)

    pending.resolve([200, homework('s1')])
    await flushPromises()
    expect(wrapper.get('.hw-hint__text').text()).toBe('作業進度 2/3 · 預計 17:30 可接送')
  })

  it('PickupView history rows', async () => {
    const { wrapper } = await mountPickup({
      today: [
        [
          200,
          [
            request('r0', { status: 'cancelled', created_at: '2026-10-07T08:00:00Z', cancelled_at: '2026-10-07T08:12:00Z', can_cancel: false, can_mark_arrived: false }),
            request('r1', { status: 'expired', created_at: '2026-10-07T06:30:00Z', can_cancel: false, can_mark_arrived: false }),
            request('rx', { student_id: 's2', student_name: '王小華', status: 'expired', created_at: '2026-10-07T07:00:00Z', can_cancel: false, can_mark_arrived: false }),
          ],
        ],
      ],
    })

    expect(wrapper.get('.pk-section').text()).toBe('今日紀錄')
    const rows = wrapper.findAll('.pk-history__row')
    expect(rows.map((r) => [r.get('.status-pill').text(), r.get('.pk-history__text').text(), r.get('.pk-history__time').text()])).toEqual([
      [PICKUP_REQUEST_STATUS_META.cancelled.label, '16:12 取消', '16:00 發起'],
      [PICKUP_REQUEST_STATUS_META.expired.label, '逾時自動結束', '14:30 發起'],
    ])
    expect(wrapper.get('ul.pk-history').attributes('aria-label')).toBe('今日接送紀錄')
  })

  it('PickupView history completed rows', async () => {
    const { wrapper } = await mountPickup({
      today: [
        [
          200,
          [
            request('r2', { status: 'pending', created_at: '2026-10-07T09:20:00Z' }),
            request('r1', { status: 'completed', created_at: '2026-10-07T07:00:00Z', completed_at: '2026-10-07T07:50:00Z', picked_up_by_name: '王媽媽', can_cancel: false, can_mark_arrived: false }),
            request('r0', { status: 'completed', created_at: '2026-10-07T06:00:00Z', completed_at: '2026-10-07T06:40:00Z', picked_up_by_name: null, can_cancel: false, can_mark_arrived: false }),
          ],
        ],
      ],
    })

    expect(wrapper.findAll('.pk-history__text').map((t) => t.text())).toEqual(['15:50 由 王媽媽 接走', '14:40 接走'])
    // 有進行中請求時不顯示成功卡
    expect(wrapper.find('.pk-done').exists()).toBe(false)
  })

  it('PickupView hides history when there is none', async () => {
    const { wrapper } = await mountPickup({ today: [[200, []]] })

    expect(hasButton(wrapper, '通知安親班')).toBe(true)
    expect(wrapper.text()).not.toContain('今日紀錄')
    expect(wrapper.find('.pk-history').exists()).toBe(false)
  })

  it('PickupView cancel keeps dialog open on server error', async () => {
    const { wrapper } = await mountPickup({ today: [[200, [request('r1')]]] })
    mock.onPost(cancelUrl('r1')).reply(500, SERVER_ERROR)

    await click(button(wrapper, '取消接送'))
    await confirmDialog('確定取消')

    expect(posts()).toEqual([cancelUrl('r1')])
    expect(alertDialog()?.textContent).toContain('取消這次接送？')
    expect(snackbar()).toEqual([['送出失敗，請稍後再試', 'error']])
    expect(button(alertDialog()!, '確定取消').getAttribute('aria-busy')).toBeNull()
  })

  it('PickupView load error with retry', async () => {
    const { wrapper } = await mountPickup({ today: [[500, SERVER_ERROR], [200, [request('r1')]]] })

    const error = wrapper.get('.empty-state')
    expect(error.attributes('role')).toBe('alert')
    expect(error.text()).toContain('接送狀態載入失敗')
    expect(error.text()).toContain('請檢查網路連線後再試一次')
    expect(hasButton(wrapper, '通知安親班')).toBe(false)

    await click(button(wrapper, '重試'))

    expect(gets(TODAY_URL)).toBe(2)
    expect(hasButton(wrapper, '我到了')).toBe(true)
    expect(wrapper.find('.empty-state').exists()).toBe(false)
  })

  it('PickupView refetches requests when the page becomes visible and keeps data on failure', async () => {
    const { wrapper } = await mountPickup({ today: [[200, [request('r1')]], [500, SERVER_ERROR]] })

    await becomeVisible()

    expect(gets(TODAY_URL)).toBe(2)
    expect(wrapper.find('.empty-state').exists()).toBe(false)
    expect(hasButton(wrapper, '我到了')).toBe(true)

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(gets(TODAY_URL)).toBe(2)
  })

  it('PickupView stops listening to visibility after unmount', async () => {
    const { wrapper } = await mountPickup()
    wrapper.unmount()
    mounted = null

    await becomeVisible()

    expect(gets(TODAY_URL)).toBe(1)
  })

  it('PickupView applies ws updates from the store', async () => {
    const m = await mountPickup({ today: [[200, [request('r1')]]] })
    useParentWsStore(m.pinia).connect()
    const socket = FakeWebSocket.instances.at(-1)!
    socket.serverOpen()

    socket.serverMessage(
      'pickup.request_updated',
      request('r1', { status: 'acknowledged', reply_message: '作業寫完了，正在收書包', reply_source: 'staff', replied_at: '2026-10-07T09:23:00Z' }),
    )
    await flushPromises()

    expect(m.wrapper.get('.pk-req .status-pill').text()).toBe(PICKUP_REQUEST_STATUS_META.acknowledged.label)
    expect(m.wrapper.get('.pk-req').text()).toContain('作業寫完了，正在收書包')
    expect(m.wrapper.get('.pk-req').text()).toContain('老師回覆')
    expect(gets(TODAY_URL)).toBe(1)
  })

  it('PickupView proxy entry navigates', async () => {
    const { wrapper, router } = await mountPickup()

    const entry = wrapper.get('.pk-proxy a')
    expect(entry.text()).toContain('代理接送與常用接送人')
    expect(entry.text()).toContain('由親友代接時，先建立代理接送與接送碼')
    expect(entry.attributes('href')).toBe('/pickup/proxy')
    await click(entry.element)

    expect(router.currentRoute.value.path).toBe('/pickup/proxy')
  })

  it('PickupView ignores a stale stored child that is no longer listed', async () => {
    const { wrapper } = await mountPickup({ kids: [child('s1', '王小明')], selected: 's9' })

    expect(gets(childUrl('s9'))).toBe(0)
    expect(gets(homeworkUrl('s9'))).toBe(0)
    expect(gets(childUrl('s1'))).toBe(1)
    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(hasButton(wrapper, '通知安親班')).toBe(true)
  })

  it('PickupView arrive now resets the chosen arrival time', async () => {
    const { wrapper } = await mountPickup({
      today: [
        [200, []],
        // 老師端取消（回到前景重抓）：畫面回到表單
        [200, [request('r8', { status: 'cancelled', cancelled_at: '2026-10-07T09:23:00Z', can_cancel: false, can_mark_arrived: false })]],
      ],
    })
    mock.onPost(CREATE_URL).reply(201, request('r8', { status: 'arrived', can_mark_arrived: false }))

    const chip = Array.from(root(wrapper).querySelectorAll('button')).find((b) => b.textContent?.includes('約 10 分鐘後'))
    await click(chip)
    await click(button(wrapper, '我已經到了'))
    await confirmDialog('我到了')
    expect(formCardExists(wrapper)).toBe(false)
    await becomeVisible()

    const selected = Array.from(formCard(wrapper).element.querySelectorAll('.m3-chip[aria-pressed="true"]'))
    expect(selected.map(buttonLabel)).toEqual(['不指定'])
  })

  it('PickupView refetches today requests on mount even when the store is already loaded', async () => {
    const { wrapper } = await mountPickup({
      pinia: { parentPickupRequests: { loaded: true, items: [request('r1')] } },
      today: [[200, [request('r1', { status: 'acknowledged', reply_message: '老師已確認', reply_source: 'staff' })]]],
    })

    expect(gets(TODAY_URL)).toBe(1)
    expect(wrapper.get('.pk-req .status-pill').text()).toBe(PICKUP_REQUEST_STATUS_META.acknowledged.label)
  })

  it('PickupView ignores a late child detail response', async () => {
    const first = deferredReply()
    const { wrapper } = await mountPickup({ detail: { s1: [first.reply, [200, detail('s1', false)]] } })

    await switchChild(wrapper, '王小華')
    await switchChild(wrapper, '王小明')
    expect(wrapper.get('.empty-state').text()).toContain('您沒有這位小孩的接送權限')

    first.resolve([200, detail('s1', true)])
    await flushPromises()

    expect(wrapper.get('.empty-state').text()).toContain('您沒有這位小孩的接送權限')
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
  })

  it('PickupView shows the empty state without children', async () => {
    const { wrapper, router } = await mountPickup({ kids: [] })

    expect(wrapper.get('.empty-state').text()).toContain('尚未綁定小孩')
    expect(hasButton(wrapper, '通知安親班')).toBe(false)
    expect(wrapper.find('.pk-proxy').exists()).toBe(true)
    await click(button(wrapper, '輸入綁定碼'))
    expect(router.currentRoute.value.path).toBe('/bind')
  })
})

function formCardExists(w: Wrapper): boolean {
  return w.find('.pk-form').exists()
}
