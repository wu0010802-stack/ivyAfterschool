import { DOMWrapper, flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PICKUP_REQUEST_STATUS_META } from '@/shared/constants/statusLabels'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'
import type { ChildSummary, ChildToday } from '../api/children'
import { parentHttp } from '../api/http'
import type { ParentPickupRequest } from '../api/pickupRequests'
import PullToRefresh from '../components/PullToRefresh.vue'
import { useParentWsStore } from '../stores/parentWs'
import { useSnackbarStore } from '../stores/snackbar'
import ChildHubView from './ChildHubView.vue'

/** ws 事件封包（type + data + sent_at）由伺服器送出 */
function serverMessage(socket: FakeWebSocket, type: string, data: unknown): void {
  socket.message({ type, data, sent_at: '2026-10-07T09:50:01Z' })
}

const SELECTED_KEY = 'parent_selected_child_v1'
const SKIP_KEY = 'parent_pickup_arrive_skip_confirm'
const CHILDREN_URL = '/parent/children'
const CREATE_URL = '/parent/pickup/requests'
const TODAY = '2026-10-07'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }

const todayUrl = (id: string) => `/parent/children/${id}/today`
const arrivedUrl = (id: string) => `/parent/pickup/requests/${id}/arrived`

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級 A 班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

function childToday(studentId: string, overrides: Partial<ChildToday> = {}): ChildToday {
  return {
    student_id: studentId,
    date: TODAY,
    is_service_day: true,
    attendance: { status: 'present', check_in_at: '2026-10-07T07:40:00Z', check_out_at: null },
    on_leave: false,
    leave: null,
    // ready_eta 刻意與接送回覆的 17:30 不同，斷言「預計 17:30 可接送」時才分得出來源
    homework: { item_count: 2, done_count: 1, overall_status: 'in_progress', ready_eta: '18:00', note: null },
    pickup_request: null,
    ...overrides,
  }
}

function pickupRequest(id: string, overrides: Partial<ParentPickupRequest> = {}): ParentPickupRequest {
  return {
    id,
    student_id: 's2',
    student_name: '王小華',
    service_date: TODAY,
    status: 'arrived',
    expected_arrival_at: null,
    reply_ready_eta: '17:30',
    reply_message: '預計 17:30 可接送',
    reply_source: 'auto',
    replied_at: '2026-10-07T09:00:01Z',
    arrived_at: '2026-10-07T09:00:00Z',
    completed_at: null,
    picked_up_by_name: null,
    cancelled_at: null,
    created_at: '2026-10-07T09:00:00Z',
    can_cancel: true,
    can_mark_arrived: false,
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

let mock: MockAdapter
let mounted: MountedApp | null = null

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  installFakeWebSocket()
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
  localStorage.removeItem(SELECTED_KEY)
  localStorage.removeItem(SKIP_KEY)
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

/** 小孩清單由頁面自己 children.load()；selected 寫進 localStorage 模擬上次的選擇 */
async function mountHub(selected: string | null = null): Promise<MountedApp> {
  if (selected) localStorage.setItem(SELECTED_KEY, selected)
  mounted = await mountWithApp(ChildHubView)
  return mounted
}

/** 兩位小孩、選 s2、s2 的今日狀態 */
async function mountWithToday(today: ChildToday = childToday('s2')): Promise<MountedApp> {
  mock.onGet(CHILDREN_URL).reply(200, KIDS)
  mock.onGet(todayUrl(today.student_id)).reply(200, today)
  return mountHub(today.student_id)
}

type Wrapper = MountedApp['wrapper']

const body = () => document.body
const todayGets = (id: string) => mock.history.get.filter((r) => r.url === todayUrl(id)).length
const allTodayGets = () => mock.history.get.filter((r) => /\/today$/.test(r.url ?? '')).length
const childrenGets = () => mock.history.get.filter((r) => r.url === CHILDREN_URL).length
const busySkeletons = (w: Wrapper) => w.findAll('[aria-busy="true"]')
const errorRow = (w: Wrapper) => w.find('.today-error')
const card = (w: Wrapper) => w.find('[role="region"][aria-label="今日狀態"]')
const alertDialog = () => body().querySelector<HTMLElement>('[role="alertdialog"]')

function button(root: Wrapper | ParentNode, label: string): HTMLButtonElement {
  const scope: ParentNode = 'element' in root ? (root as Wrapper).element : root
  const found = Array.from(scope.querySelectorAll('button')).find((b) => buttonLabel(b) === label)
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

/** 按鈕文字去掉圖示 ligature（M3Icon 的文字就是圖示名稱） */
function buttonLabel(b: Element): string {
  const clone = b.cloneNode(true) as Element
  clone.querySelectorAll('.m3-icon').forEach((icon) => icon.remove())
  return clone.textContent?.trim() ?? ''
}

function hasButton(w: Wrapper, label: string): boolean {
  return Array.from((w.element as Element).querySelectorAll('button')).some((b) => buttonLabel(b) === label)
}

function quickLink(w: Wrapper, label: string) {
  const found = w.findAll('.quick__item').find((a) => a.find('.quick__label').text() === label)
  if (!found) throw new Error(`找不到常用功能 ${label}`)
  return found
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('找不到要點擊的元素')
  await new DOMWrapper(el).trigger('click')
  await flushPromises()
}

async function confirmArrive(): Promise<void> {
  const dialog = alertDialog()
  if (!dialog) throw new Error('確認對話框沒有開啟')
  await click(button(dialog, '我到了'))
}

function connectWs(m: MountedApp): FakeWebSocket {
  useParentWsStore(m.pinia).connect()
  const socket = FakeWebSocket.instances.at(-1)
  if (!socket) throw new Error('尚未建立 socket')
  socket.open()
  return socket
}

function snackbarMessages(): string[] {
  return useSnackbarStore().items.map((i) => i.message)
}

describe('ChildHubView', () => {
  it('ChildHubView renders status for selected child', async () => {
    const { wrapper } = await mountWithToday()

    expect(wrapper.get('.cch__name').text()).toBe('王小華')
    expect(card(wrapper).text()).toContain('作業進度 1/2')
    expect(card(wrapper).text()).toContain('15:40 到班')
    expect(todayGets('s2')).toBe(1)
    expect(allTodayGets()).toBe(1)
    expect(childrenGets()).toBe(1)
    expect(busySkeletons(wrapper)).toHaveLength(0)
    expect(errorRow(wrapper).exists()).toBe(false)
  })

  it('ChildHubView switching child reloads with new id', async () => {
    const s1 = deferredReply()
    mock.onGet(todayUrl('s1')).reply(s1.reply)
    const { wrapper } = await mountWithToday()

    await click(wrapper.get('button.cch').element)
    const option = Array.from(body().querySelectorAll('.cch-option')).find(
      (o) => o.querySelector('.cch-option__name')?.textContent === '王小明',
    )
    await click(option)

    expect(todayGets('s1')).toBe(1)
    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(localStorage.getItem(SELECTED_KEY)).toBe('s1')
    // 切換後舊卡片立即清掉，回應前是骨架
    expect(card(wrapper).exists()).toBe(false)
    expect(busySkeletons(wrapper)).toHaveLength(1)

    s1.resolve([200, childToday('s1', { homework: { item_count: 4, done_count: 3, overall_status: 'in_progress', ready_eta: null, note: null } })])
    await flushPromises()

    expect(card(wrapper).text()).toContain('作業進度 3/4')
    expect(busySkeletons(wrapper)).toHaveLength(0)
    expect(todayGets('s2')).toBe(1)
  })

  it('ChildHubView empty children state', async () => {
    mock.onGet(CHILDREN_URL).reply(200, [])
    const { wrapper, router } = await mountHub()

    const empty = wrapper.get('.empty-state')
    expect(empty.text()).toContain('尚未綁定小孩')
    expect(empty.text()).toContain('請輸入安親班提供的綁定碼')
    expect(empty.attributes('role')).toBeUndefined()
    expect(wrapper.find('.cch').exists()).toBe(false)
    expect(card(wrapper).exists()).toBe(false)
    expect(wrapper.text()).not.toContain('今日狀態')
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)

    await click(button(wrapper, '輸入綁定碼'))

    expect(router.currentRoute.value.path).toBe('/bind')
    expect(allTodayGets()).toBe(0)
  })

  it('ChildHubView children load error', async () => {
    mock.onGet(CHILDREN_URL).replyOnce(500, SERVER_ERROR)
    const retry = deferredReply()
    mock.onGet(CHILDREN_URL).replyOnce(retry.reply)
    const { wrapper } = await mountHub()

    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('小孩清單載入失敗')
    expect(alert.text()).toContain('請檢查網路連線後再試一次')
    expect(wrapper.find('.cch').exists()).toBe(false)
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)

    await click(button(wrapper, '重試'))

    expect(childrenGets()).toBe(2)
    // 重試中回到骨架
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(busySkeletons(wrapper)).toHaveLength(2)

    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    retry.resolve([200, KIDS])
    await flushPromises()

    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(card(wrapper).text()).toContain('作業進度 1/2')
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(false)
  })

  it('ChildHubView today error row', async () => {
    mock.onGet(CHILDREN_URL).reply(200, KIDS)
    mock.onGet(todayUrl('s2')).replyOnce(500, SERVER_ERROR)
    mock.onGet(todayUrl('s2')).replyOnce(200, childToday('s2'))
    const { wrapper } = await mountHub('s2')

    const row = errorRow(wrapper)
    expect(row.attributes('role')).toBe('alert')
    expect(row.text()).toContain('今日狀態載入失敗')
    const retry = row.get('button')
    expect(retry.text()).toBe('重試')
    expect(retry.attributes('type')).toBe('button')
    // 第一次就失敗：下方是卡片的 null 佔位
    expect(card(wrapper).text()).toContain('尚未取得今日狀態')
    expect(wrapper.find('.hub-section__date').exists()).toBe(false)
    // 錯誤列在卡片之前
    const order = Array.from((wrapper.element as Element).querySelectorAll('.today-error, [role="region"]'))
    expect(order.map((el) => el.classList.contains('today-error'))).toEqual([true, false])

    await click(retry.element)

    expect(todayGets('s2')).toBe(2)
    expect(errorRow(wrapper).exists()).toBe(false)
    expect(card(wrapper).text()).toContain('作業進度 1/2')
  })

  it('ChildHubView pickup button navigates', async () => {
    const { wrapper, router } = await mountWithToday()

    await click(button(wrapper, '我要來接'))

    expect(router.currentRoute.value.path).toBe('/pickup')
  })

  it('ChildHubView opens pickup and homework from the card', async () => {
    const open = childToday('s2', {
      pickup_request: {
        id: 'p1',
        status: 'acknowledged',
        expected_arrival_at: '17:30',
        reply_ready_eta: '17:30',
        reply_message: '預計 17:30 可接送',
        reply_source: 'auto',
        completed_at: null,
        picked_up_by_name: null,
        can_cancel: true,
        can_mark_arrived: true,
      },
    })
    const { wrapper, router } = await mountWithToday(open)

    await click(button(wrapper, '查看接送'))
    expect(router.currentRoute.value.path).toBe('/pickup')

    await router.push('/')
    await click(wrapper.get('button.tsc-hw').element)
    expect(router.currentRoute.value.path).toBe('/homework')
  })

  it('ChildHubView shows skeleton while loading', async () => {
    mock.onGet(CHILDREN_URL).reply(200, KIDS)
    const pending = deferredReply()
    mock.onGet(todayUrl('s2')).reply(pending.reply)
    const { wrapper } = await mountHub('s2')

    // 身分卡已顯示，只有卡片位置是骨架
    expect(wrapper.get('.cch__name').text()).toBe('王小華')
    const skeletons = busySkeletons(wrapper)
    expect(skeletons).toHaveLength(1)
    expect(skeletons[0]!.classes()).toContain('skeleton--card')
    expect(skeletons[0]!.find('.skeleton-card').attributes('style')).toContain('height: 300px')
    expect(card(wrapper).exists()).toBe(false)

    pending.resolve([200, childToday('s2')])
    await flushPromises()

    expect(busySkeletons(wrapper)).toHaveLength(0)
    expect(card(wrapper).text()).toContain('作業進度 1/2')
  })

  it('ChildHubView updates attendance from ws', async () => {
    const m = await mountWithToday()
    const socket = connectWs(m)

    serverMessage(socket, 'attendance.updated', {
      student_id: 's2',
      service_date: TODAY,
      status: 'left',
      check_in_at: '2026-10-07T07:40:00Z',
      check_out_at: '2026-10-07T09:50:00Z',
    })
    await flushPromises()

    expect(card(m.wrapper).text()).toContain('17:50 離班')
    expect(allTodayGets()).toBe(1)
    expect(busySkeletons(m.wrapper)).toHaveLength(0)
  })

  it('ChildHubView arrive now from home card', async () => {
    const { wrapper, router } = await mountWithToday()
    mock.onPost(CREATE_URL).reply(201, pickupRequest('p9'))

    await click(button(wrapper, '我已經到了'))

    const dialog = alertDialog()
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('確認已抵達安親班？')
    expect(dialog!.textContent).toContain('老師會收到通知並準備帶孩子出來')
    const skip = dialog!.querySelector<HTMLInputElement>('label.check-row input[type="checkbox"]')
    expect(skip?.closest('label')?.textContent?.trim()).toBe('下次不再提醒')
    expect(skip?.checked).toBe(false)
    expect(mock.history.post).toHaveLength(0)

    await confirmArrive()

    expect(mock.history.post).toHaveLength(1)
    expect(mock.history.post[0]!.url).toBe(CREATE_URL)
    expect(JSON.parse(mock.history.post[0]!.data as string)).toEqual({ student_id: 's2', arrived: true })
    expect(router.currentRoute.value.path).toBe('/')
    const pickupSection = wrapper.get('.tsc-pickup')
    expect(pickupSection.text()).toContain('預計 17:30 可接送')
    expect(pickupSection.text()).toContain(PICKUP_REQUEST_STATUS_META.arrived.label)
    expect(hasButton(wrapper, '我已經到了')).toBe(false)
    expect(snackbarMessages()).toEqual(['已通知老師您到了'])
    expect(localStorage.getItem(SKIP_KEY)).toBeNull()
    expect(allTodayGets()).toBe(1)
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
  })

  it('ChildHubView arrive now marks the open request arrived', async () => {
    const open = childToday('s2', {
      pickup_request: {
        id: 'p1',
        status: 'acknowledged',
        expected_arrival_at: '17:30',
        reply_ready_eta: '17:30',
        reply_message: '預計 17:30 可接送',
        reply_source: 'auto',
        completed_at: null,
        picked_up_by_name: null,
        can_cancel: true,
        can_mark_arrived: true,
      },
    })
    const { wrapper } = await mountWithToday(open)
    mock.onPost(arrivedUrl('p1')).reply(200, pickupRequest('p1', { reply_message: '馬上帶出來', reply_ready_eta: null }))

    await click(button(wrapper, '我到了'))
    await confirmArrive()

    expect(mock.history.post.map((r) => r.url)).toEqual([arrivedUrl('p1')])
    const pickupSection = wrapper.get('.tsc-pickup')
    expect(pickupSection.text()).toContain(PICKUP_REQUEST_STATUS_META.arrived.label)
    expect(pickupSection.text()).toContain('馬上帶出來')
    expect(hasButton(wrapper, '我到了')).toBe(false)
  })

  it('ChildHubView arrive now treats a terminal request as no open request', async () => {
    const done = childToday('s2', {
      pickup_request: {
        id: 'p0',
        status: 'cancelled',
        expected_arrival_at: null,
        reply_ready_eta: null,
        reply_message: null,
        reply_source: null,
        completed_at: null,
        picked_up_by_name: null,
        can_cancel: false,
        can_mark_arrived: false,
      },
    })
    const { wrapper } = await mountWithToday(done)
    mock.onPost(CREATE_URL).reply(201, pickupRequest('p9'))

    await click(button(wrapper, '我已經到了'))
    await confirmArrive()

    expect(mock.history.post.map((r) => r.url)).toEqual([CREATE_URL])
    expect(wrapper.get('.tsc-pickup').text()).toContain('預計 17:30 可接送')
  })

  it('ChildHubView arrive now cancel sends nothing', async () => {
    const { wrapper } = await mountWithToday()

    await click(button(wrapper, '我已經到了'))
    await click(button(alertDialog()!, '取消'))

    await vi.waitFor(() => expect(alertDialog()).toBeNull())
    expect(mock.history.post).toHaveLength(0)
    expect(hasButton(wrapper, '我已經到了')).toBe(true)
  })

  it('ChildHubView arrive now remembers skip and updates the card without a dialog', async () => {
    const { wrapper } = await mountWithToday()
    mock.onPost(CREATE_URL).replyOnce(409, { error: { code: 'pickup_window_closed', message: '接送請求開放時間為 12:00～19:00', details: null } })
    mock.onPost(CREATE_URL).replyOnce(201, pickupRequest('p9'))

    await click(button(wrapper, '我已經到了'))
    const skip = alertDialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    skip.checked = true
    await new DOMWrapper(skip).trigger('change')
    await confirmArrive()

    expect(localStorage.getItem(SKIP_KEY)).toBe('1')
    expect(snackbarMessages()[0]).toBe('接送請求開放時間為 12:00～19:00')
    await vi.waitFor(() => expect(alertDialog()).toBeNull())

    // 第二次直接送出，回應同樣套到卡片
    await click(button(wrapper, '我已經到了'))

    expect(alertDialog()).toBeNull()
    expect(mock.history.post).toHaveLength(2)
    expect(wrapper.get('.tsc-pickup').text()).toContain('預計 17:30 可接送')
    expect(hasButton(wrapper, '我已經到了')).toBe(false)
  })

  it('ChildHubView today error keeps stale card', async () => {
    const { wrapper } = await mountWithToday()
    mock.resetHandlers()
    mock.onGet(todayUrl('s2')).replyOnce(500, SERVER_ERROR)
    const third = deferredReply()
    mock.onGet(todayUrl('s2')).replyOnce(third.reply)

    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(errorRow(wrapper).text()).toContain('今日狀態載入失敗')
    expect(card(wrapper).text()).toContain('作業進度 1/2')
    expect(snackbarMessages()).toEqual([])

    await click(errorRow(wrapper).get('button').element)

    expect(wrapper.text()).not.toContain('今日狀態載入失敗')
    expect(card(wrapper).text()).toContain('作業進度 1/2')
    expect(busySkeletons(wrapper)).toHaveLength(0)
    expect(todayGets('s2')).toBe(3)

    third.resolve([200, childToday('s2', { homework: { item_count: 2, done_count: 2, overall_status: 'done', ready_eta: null, note: null } })])
    await flushPromises()
    expect(card(wrapper).text()).toContain('作業進度 2/2')
  })

  it('ChildHubView quick links', async () => {
    const { wrapper, router } = await mountWithToday()

    const items = wrapper.findAll('ul.quick > li > a.quick__item')
    expect(wrapper.get('ul.quick').attributes('role')).toBe('list')
    expect(wrapper.get('ul.quick').attributes('aria-label')).toBe('常用功能')
    expect(items.map((a) => [a.get('.quick__label').text(), a.attributes('href'), a.get('.quick__icon .m3-icon').text()])).toEqual([
      ['請假', '/leaves', 'event_busy'],
      ['出勤', '/attendance', 'calendar_month'],
      ['代理接送', '/pickup/proxy', 'badge'],
    ])
    expect(items.map((a) => a.attributes('aria-disabled'))).toEqual([undefined, undefined, undefined])

    await click(quickLink(wrapper, '代理接送').element)

    expect(router.currentRoute.value.path).toBe('/pickup/proxy')
  })

  it('ChildHubView quick links are disabled without children', async () => {
    mock.onGet(CHILDREN_URL).reply(200, [])
    const { wrapper, router } = await mountHub()

    for (const label of ['請假', '出勤', '代理接送']) {
      const link = quickLink(wrapper, label)
      expect(link.attributes('aria-disabled')).toBe('true')
      expect(link.attributes('tabindex')).toBe('-1')
    }

    await click(quickLink(wrapper, '請假').element)

    expect(router.currentRoute.value.path).toBe('/')
  })

  it('ChildHubView quick links are disabled when the children list fails', async () => {
    mock.onGet(CHILDREN_URL).reply(500, SERVER_ERROR)
    const { wrapper, router } = await mountHub()

    expect(quickLink(wrapper, '出勤').attributes('aria-disabled')).toBe('true')
    await click(quickLink(wrapper, '出勤').element)
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('ChildHubView quick links stay usable while the children list loads', async () => {
    const pending = deferredReply()
    mock.onGet(CHILDREN_URL).reply(pending.reply)
    const { wrapper, router } = await mountHub()

    expect(quickLink(wrapper, '出勤').attributes('aria-disabled')).toBeUndefined()
    await click(quickLink(wrapper, '出勤').element)
    expect(router.currentRoute.value.path).toBe('/attendance')
  })

  it('ChildHubView children skeleton', async () => {
    const pending = deferredReply()
    mock.onGet(CHILDREN_URL).reply(pending.reply)
    // 上次選過的小孩：清單回來前也不打 today
    const { wrapper } = await mountHub('s2')

    const skeletons = busySkeletons(wrapper)
    expect(skeletons).toHaveLength(2)
    expect(skeletons[0]!.classes()).toEqual(expect.arrayContaining(['skeleton--row', 'hub-cch-skeleton']))
    expect(skeletons[0]!.find('.skeleton-row').attributes('style')).toContain('height: 80px')
    expect(skeletons[1]!.classes()).toContain('skeleton--card')
    expect(allTodayGets()).toBe(0)
    expect(wrapper.find('.cch').exists()).toBe(false)
  })

  it('ChildHubView ignores a stale stored child that is no longer listed', async () => {
    mock.onGet(CHILDREN_URL).reply(200, [child('s1', '王小明')])
    mock.onGet(todayUrl('s1')).reply(200, childToday('s1'))
    const { wrapper } = await mountHub('s9')

    expect(mock.history.get.filter((r) => /\/today$/.test(r.url ?? '')).map((r) => r.url)).toEqual([todayUrl('s1')])
    expect(wrapper.get('.cch__name').text()).toBe('王小明')
  })

  it('ChildHubView date label', async () => {
    const { wrapper } = await mountWithToday()

    const sections = wrapper.findAll('.hub-section')
    expect(sections.map((s) => s.find('span').text())).toEqual(['今日狀態', '常用功能'])
    expect(sections[0]!.get('.hub-section__date').text()).toBe('10/07（三）')
  })

  it('ChildHubView arrive now student not active', async () => {
    const { wrapper } = await mountWithToday()
    mock.onPost(CREATE_URL).reply(409, {
      error: { code: 'student_not_active', message: '此學生目前暫停，無法進行此操作', details: null },
    })

    await click(button(wrapper, '我已經到了'))
    await confirmArrive()

    expect(snackbarMessages()[0]).toBe('此學生目前暫停，無法進行此操作')
    expect(useSnackbarStore().items[0]!.tone).toBe('error')
    expect(mock.history.post).toHaveLength(1)
    expect(hasButton(wrapper, '我已經到了')).toBe(true)
    expect(wrapper.get('.tsc-pickup').text()).not.toContain(PICKUP_REQUEST_STATUS_META.arrived.label)
  })

  it('ChildHubView pull to refresh reloads today without a skeleton', async () => {
    const { wrapper } = await mountWithToday()
    const pending = deferredReply()
    mock.resetHandlers()
    mock.onGet(todayUrl('s2')).reply(pending.reply)

    const refreshing = wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(todayGets('s2')).toBe(2)
    expect(busySkeletons(wrapper)).toHaveLength(0)
    expect(card(wrapper).text()).toContain('作業進度 1/2')
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(false)

    pending.resolve([200, childToday('s2', { attendance: { status: 'left', check_in_at: '2026-10-07T07:40:00Z', check_out_at: '2026-10-07T09:50:00Z' } })])
    await refreshing
    await flushPromises()
    expect(card(wrapper).text()).toContain('17:50 離班')
  })

  it('ChildHubView refreshes today after stale arrive', async () => {
    const pending = childToday('s2', {
      pickup_request: {
        id: 'r1',
        status: 'pending',
        expected_arrival_at: '17:30',
        reply_ready_eta: null,
        reply_message: null,
        reply_source: null,
        completed_at: null,
        picked_up_by_name: null,
        can_cancel: true,
        can_mark_arrived: true,
      },
    })
    const { wrapper } = await mountWithToday(pending)
    expect(todayGets('s2')).toBe(1)
    mock.resetHandlers()
    mock.onGet('/parent/pickup/requests/today').reply(200, [])
    mock.onPost(arrivedUrl('r1')).reply(409, { error: { code: 'invalid_pickup_status', message: '狀態不符', details: null } })
    const refreshed = deferredReply()
    mock.onGet(todayUrl('s2')).reply(refreshed.reply)

    await click(button(wrapper, '我到了'))
    await confirmArrive()

    expect(snackbarMessages()[0]).toBe('狀態已更新，請確認後再操作')
    expect(todayGets('s2')).toBe(2)
    expect(busySkeletons(wrapper)).toHaveLength(0)

    refreshed.resolve([
      200,
      childToday('s2', {
        pickup_request: {
          id: 'r1',
          status: 'arrived',
          expected_arrival_at: '17:30',
          reply_ready_eta: null,
          reply_message: null,
          reply_source: null,
          completed_at: null,
          picked_up_by_name: null,
          can_cancel: true,
          can_mark_arrived: false,
        },
      }),
    ])
    await flushPromises()

    expect(hasButton(wrapper, '我到了')).toBe(false)
    expect(busySkeletons(wrapper)).toHaveLength(0)
  })

  it('ChildHubView refreshes today after missing request', async () => {
    const pending = childToday('s2', {
      pickup_request: {
        id: 'r1',
        status: 'pending',
        expected_arrival_at: '17:30',
        reply_ready_eta: null,
        reply_message: null,
        reply_source: null,
        completed_at: null,
        picked_up_by_name: null,
        can_cancel: true,
        can_mark_arrived: true,
      },
    })
    const { wrapper } = await mountWithToday(pending)
    mock.onGet('/parent/pickup/requests/today').reply(200, [])
    mock.onPost(arrivedUrl('r1')).reply(404, { error: { code: 'pickup_request_not_found', message: '找不到', details: null } })

    await click(button(wrapper, '我到了'))
    await confirmArrive()

    expect(snackbarMessages()[0]).toBe('找不到這筆接送請求，已重新整理')
    expect(todayGets('s2')).toBe(2)
  })
})
