import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { PickupQueue, PickupRequest, PickupRoster, RosterStudent } from '@/api/pickupRequests'
import PickupCreateDialog from '@/components/pickup/PickupCreateDialog.vue'
import StudentSelect from '@/components/student/StudentSelect.vue'
import { useAdminWsStore } from '@/stores/adminWs'
import { useNotificationsStore } from '@/stores/notifications'
import { createApiMock, mountWithApp } from '@/test/helpers'
import viewSource from './PickupPosView.vue?raw'
import PickupPosView from './PickupPosView.vue'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'

// DismissalPosBoard（FRONTEND-190）以 stub 取代：只檢查本頁傳入的資料與對 expose 的 focusRequest 呼叫
const boardStub = vi.hoisted(() => ({ focusRequest: vi.fn<(id: string) => Promise<boolean>>() }))
vi.mock('@/components/pickup/pos/DismissalPosBoard.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'DismissalPosBoard',
      props: { board: { type: Object, required: true }, canOperate: Boolean, canOverride: Boolean },
      setup(_, { expose }) {
        expose({ focusRequest: (id: string) => boardStub.focusRequest(id) })
        return () => h('div', { class: 'board-stub' })
      },
    }),
  }
})

/** 後端事件封包（type + data + sent_at） */
function serverMessage(socket: FakeWebSocket, type: string, data: unknown): void {
  socket.message({ type, data, sent_at: '2026-10-02T09:00:00Z' })
}

/** 記錄畫了幾個音：新請求單音 1 個 oscillator、到達雙音 2 個 */
class FakeAudioContext {
  static oscillators = 0

  state: AudioContextState = 'suspended'
  currentTime = 0
  destination = {}

  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }

  createOscillator(): unknown {
    FakeAudioContext.oscillators += 1
    return { type: '', frequency: { value: 0 }, connect: (n: unknown) => n, start: () => undefined, stop: () => undefined }
  }

  createGain(): unknown {
    const gain = {
      gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: (n: unknown) => n,
    }
    return gain
  }
}

class FakeUtterance {
  text: string
  lang = ''
  rate = 1
  pitch = 1
  volume = 1
  voice: unknown = null

  constructor(text: string) {
    this.text = text
  }
}

const speech = { speak: vi.fn<(u: FakeUtterance) => void>(), getVoices: () => [] }

const QUEUE_URL = '/admin/pickup/queue'
const ROSTER_URL = '/admin/pickup/roster'
const AUTH_URL = '/admin/pickup/authorizations'
const CREATE_URL = '/admin/pickup/requests'
const TODAY = '2026-10-02'
/** 台北 2026-10-02（五）17:00 */
const NOW = Date.parse('2026-10-02T09:00:00Z')
const OPERATOR = ['pickup:read', 'pickup:operate', 'pickup:override']
const SPOKEN = '低年級A班 王小明 家長到了'

function makeRequest(overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id: 'r1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 1, class_id: 'c1', class_name: '低年級A班' },
    service_date: TODAY,
    source: 'parent',
    requested_by_type: 'parent',
    requested_by_name: '王媽媽',
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
    needs_reply: false,
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

function makeStudent(id: string, no: string, name: string): RosterStudent {
  return {
    student_id: id,
    student_no: no,
    name,
    grade_level: 1,
    attendance_status: 'present',
    check_in_at: '2026-10-02T06:20:00Z',
    check_out_at: null,
    leave_type: null,
    homework_status: null,
    ready_eta: null,
    open_request: null,
    active_authorization_count: 0,
  }
}

const ROSTER: PickupRoster = {
  date: TODAY,
  classes: [
    { class_id: 'c1', class_name: '低年級A班', students: [makeStudent('s1', 'S11301', '王小明')] },
    { class_id: 'c2', class_name: '中年級B班', students: [makeStudent('s2', 'S11302', '陳小美')] },
    { class_id: null, class_name: '未分班', students: [] },
  ],
}

function makeQueue(open: PickupRequest[] = []): PickupQueue {
  const counts = { pending: 0, acknowledged: 0, arrived: 0, needs_reply: 0 }
  for (const r of open) {
    if (r.status === 'pending' || r.status === 'acknowledged' || r.status === 'arrived') counts[r.status] += 1
    if (r.needs_reply) counts.needs_reply += 1
  }
  return { date: TODAY, open, closed: [], counts }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

function socket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1)
  if (!s) throw new Error('沒有建立 WebSocket')
  return s
}

function mockData(queue: PickupQueue = makeQueue([makeRequest()])): void {
  mock.onGet(QUEUE_URL).reply(200, queue)
  mock.onGet(ROSTER_URL).reply(200, ROSTER)
  mock.onGet(AUTH_URL).reply(200, [])
}

async function mountView(
  { permissions = OPERATOR, route = '/pickup' }: { permissions?: string[]; route?: string } = {},
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const { wrapper, router, pinia } = await mountWithApp(PickupPosView, {
    initialRoute: route,
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'clerk01',
          display_name: '林行政',
          role: { id: 'r-clerk', code: 'clerk', name: '行政' },
          permissions,
          must_change_password: false,
        },
      },
    },
  })
  // 外框（AdminLayout）負責啟動 ws 與綁定個人通知
  useAdminWsStore(pinia).start()
  useNotificationsStore(pinia).bindWs()
  socket().open()
  await settle()
  return { wrapper: wrapper as VueWrapper, router }
}

/** 推進假時鐘再派發：Vue 會略過時間戳不晚於 handler 綁定時間的事件 */
function tick(): void {
  vi.setSystemTime(Date.now() + 1000)
}

async function tap(wrapper: VueWrapper): Promise<void> {
  tick()
  wrapper.find('.pos').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await settle()
}

function button(wrapper: VueWrapper, text: string): DOMWrapper<Element> | undefined {
  return wrapper.findAll('button').find((b) => b.text().trim() === text)
}

const spokenArrivals = (): number => speech.speak.mock.calls.filter(([u]) => u.text === SPOKEN).length

function chipText(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.pos-count').map((c) => c.text().replace(/\s+/g, ' ').trim())
}

function arrivedTransient(requestId: string): unknown {
  return {
    event: 'pickup.arrived',
    title: '王小明 家長已抵達',
    body: '家長已到達門口。',
    payload: { student_id: 's1', student_name: '王小明', request_id: requestId },
  }
}

describe('PickupPosView', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    FakeAudioContext.oscillators = 0
    installFakeWebSocket()
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('speechSynthesis', speech)
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    speech.speak.mockReset()
    boardStub.focusRequest.mockReset()
    boardStub.focusRequest.mockResolvedValue(true)
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    useAdminWsStore().stop()
    mock.restore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('PickupPosView shows counts from open queue', async () => {
    mockData(
      makeQueue([
        makeRequest({ id: 'r1', needs_reply: true }),
        makeRequest({ id: 'r2', status: 'arrived', arrived_at: '2026-10-02T08:55:00Z', student: { ...makeRequest().student, id: 's2', name: '陳小美' } }),
      ]),
    )
    const { wrapper } = await mountView()

    expect(wrapper.find('.pos-date').text()).toBe('10/02（五）')
    expect(chipText(wrapper)).toEqual(['待回覆 1', '等待確認 1', '已確認 0', '家長已到 1'])
    const chips = wrapper.findAll('.pos-count')
    expect(chips[0]?.classes()).toEqual(expect.arrayContaining(['el-tag--danger', 'el-tag--light']))
    expect(chips[1]?.classes()).toContain('el-tag--warning')
    expect(chips[3]?.classes()).toContain('el-tag--danger')
    // 主體交給 DismissalPosBoard
    const board = wrapper.findComponent({ name: 'DismissalPosBoard' })
    expect(board.props('canOperate')).toBe(true)
    expect(board.props('canOverride')).toBe(true)
    expect((board.props('board') as { queue: { value: PickupQueue } }).queue.value.open.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('PickupPosView plays chime on ws arrival', async () => {
    mockData()
    await mountView().then(({ wrapper }) => tap(wrapper))

    serverMessage(socket(), 'pickup.request_updated', makeRequest({ status: 'arrived', arrived_at: '2026-10-02T09:00:00Z' }))
    await settle()

    expect(spokenArrivals()).toBe(1)
    expect(FakeAudioContext.oscillators).toBe(2)
  })

  it('PickupPosView toggles mute', async () => {
    mockData()
    const { wrapper } = await mountView()

    tick()
    await button(wrapper, '提示音：開')?.trigger('click')
    await settle()

    const muted = button(wrapper, '提示音：關')
    expect(muted?.exists()).toBe(true)
    expect(muted?.classes()).toEqual(expect.arrayContaining(['el-button--warning', 'is-plain']))
    expect(localStorage.getItem('pickup.chimeMuted')).toBe('true')

    // 靜音時到達不響
    await tap(wrapper)
    serverMessage(socket(), 'pickup.request_updated', makeRequest({ status: 'arrived', arrived_at: '2026-10-02T09:00:00Z' }))
    await settle()
    expect(spokenArrivals()).toBe(0)
    expect(FakeAudioContext.oscillators).toBe(0)
  })

  it('PickupPosView unlock hint disappears after first tap', async () => {
    mockData()
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('點一下畫面以啟用提示音')
    await tap(wrapper)
    expect(wrapper.text()).not.toContain('點一下畫面以啟用提示音')
    // 第一次點擊預熱語音（空白、無聲的 utterance）
    expect(speech.speak.mock.calls.map(([u]) => u.text)).toEqual([''])
  })

  it('PickupPosView hides operate actions for readers', async () => {
    mockData()
    const { wrapper, router } = await mountView({ permissions: ['pickup:read'] })

    expect(button(wrapper, '代建接送請求')).toBeUndefined()
    expect(wrapper.find('.pos-toolbar').text()).toContain('僅檢視')
    const board = wrapper.findComponent({ name: 'DismissalPosBoard' })
    expect(board.props('canOperate')).toBe(false)
    expect(board.props('canOverride')).toBe(false)

    tick()
    await button(wrapper, '代理接送核驗')?.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/pickup/authorizations')

    // 主管確認交付只看 pickup:override
    wrapper.unmount()
    const operator = await mountView({ permissions: ['pickup:read', 'pickup:operate'] })
    const operatorBoard = operator.wrapper.findComponent({ name: 'DismissalPosBoard' })
    expect(operatorBoard.props('canOperate')).toBe(true)
    expect(operatorBoard.props('canOverride')).toBe(false)
  })

  it('PickupPosView chimes for request created directly as arrived', async () => {
    mockData(makeQueue([]))
    const { wrapper } = await mountView()
    await tap(wrapper)

    serverMessage(socket(), 
      'pickup.request_updated',
      makeRequest({ id: 'r5', status: 'arrived', expected_arrival_at: null, arrived_at: '2026-10-02T09:00:00Z' }),
    )
    await settle()
    expect(spokenArrivals()).toBe(1)

    serverMessage(socket(), 'notification.transient', arrivedTransient('r5'))
    await settle()
    expect(spokenArrivals()).toBe(1)
  })

  it('PickupPosView chimes from transient arrival when the queue has not caught up', async () => {
    mockData(makeQueue([]))
    const { wrapper } = await mountView()
    await tap(wrapper)

    // pickup 推播還沒到：以名單查班級組語音
    serverMessage(socket(), 'notification.transient', arrivedTransient('r6'))
    await settle()
    expect(spokenArrivals()).toBe(1)
    expect(boardStub.focusRequest).toHaveBeenCalledWith('r6')

    // 同一筆的 pickup 推播晚到：不重播
    serverMessage(socket(), 'pickup.request_updated', makeRequest({ id: 'r6', status: 'arrived', arrived_at: '2026-10-02T09:00:00Z' }))
    await settle()
    expect(spokenArrivals()).toBe(1)
  })

  it('PickupPosView speaks transient arrival from the queued request while roster is loading', async () => {
    mock.onGet(QUEUE_URL).reply(200, makeQueue([makeRequest({ status: 'arrived', arrived_at: '2026-10-02T08:58:00Z' })]))
    mock.onGet(ROSTER_URL).reply(() => new Promise(() => undefined))
    mock.onGet(AUTH_URL).reply(200, [])
    const { wrapper } = await mountView()
    await tap(wrapper)

    serverMessage(socket(), 'notification.transient', arrivedTransient('r1'))
    await settle()
    expect(spokenArrivals()).toBe(1)
  })

  it('PickupPosView shows connection capsule', async () => {
    mockData()
    const { wrapper } = await mountView()

    const capsule = (): DOMWrapper<Element> => wrapper.find('.pos-conn')
    expect(capsule().text()).toBe('即時')
    expect(capsule().classes()).toContain('is-open')

    socket().close(1006)
    await settle()
    expect(capsule().text()).toBe('重新連線中')
    expect(capsule().classes()).toContain('is-reconnecting')
    expect(wrapper.find('.pos-toolbar').text()).not.toContain('每 15 秒更新')
  })

  it('PickupPosView shows count placeholders and neutral zero chips', async () => {
    let release: () => void = () => undefined
    mock.onGet(QUEUE_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, makeQueue([])])
        }),
    )
    mock.onGet(ROSTER_URL).reply(200, ROSTER)
    mock.onGet(AUTH_URL).reply(200, [])
    const { wrapper } = await mountView()

    expect(chipText(wrapper)).toEqual(['待回覆 –', '等待確認 –', '已確認 –', '家長已到 –'])
    expect(button(wrapper, '代建接送請求')?.attributes('disabled')).toBeDefined()
    // 載入中：主體顯示（由 board 自己畫骨架），不是錯誤畫面
    expect(wrapper.findComponent({ name: 'DismissalPosBoard' }).exists()).toBe(true)
    expect(wrapper.text()).not.toContain('無法載入接送資料')

    release()
    await settle()
    expect(chipText(wrapper)).toEqual(['待回覆 0', '等待確認 0', '已確認 0', '家長已到 0'])
    for (const chip of wrapper.findAll('.pos-count')) {
      expect(chip.classes()).toEqual(expect.arrayContaining(['el-tag--info', 'el-tag--plain']))
    }
    expect(button(wrapper, '代建接送請求')?.attributes('disabled')).toBeUndefined()
  })

  it('PickupPosView does not chime for locally created request', async () => {
    mockData(makeQueue([]))
    const r9 = makeRequest({ id: 'r9', source: 'staff', requested_by_type: 'staff', requested_by_name: '林行政' })
    mock.onPost(CREATE_URL).reply(201, r9)
    const { wrapper } = await mountView()
    await tap(wrapper)

    tick()
    await button(wrapper, '代建接送請求')?.trigger('click')
    await settle()
    wrapper.findComponent(StudentSelect).vm.$emit('update:modelValue', 's1')
    await settle()
    const dialog = Array.from(document.body.querySelectorAll('.el-dialog')).find((d) => d.textContent?.includes('代建接送請求'))
    const submit = Array.from(dialog?.querySelectorAll('.el-dialog__footer button') ?? []).find(
      (b) => b.textContent?.trim() === '建立請求',
    ) as HTMLButtonElement | undefined
    tick()
    submit?.click()
    await settle()

    expect(mock.history.post.filter((r) => r.url === CREATE_URL)).toHaveLength(1)
    // 建立後定位到新請求
    expect(boardStub.focusRequest).toHaveBeenCalledWith('r9')
    serverMessage(socket(), 'pickup.request_updated', r9)
    await settle()
    expect(FakeAudioContext.oscillators).toBe(0)

    serverMessage(socket(), 'pickup.request_updated', makeRequest({ id: 'r10', student: { ...r9.student, id: 's2', name: '陳小美' } }))
    await settle()
    expect(FakeAudioContext.oscillators).toBe(1)
  })

  it('PickupPosView focuses queue card on parent arrival', async () => {
    mockData()
    const { wrapper } = await mountView()
    await tap(wrapper)

    serverMessage(socket(), 'pickup.request_updated', makeRequest({ status: 'arrived', arrived_at: '2026-10-02T09:00:00Z' }))
    await settle()
    serverMessage(socket(), 'notification.transient', arrivedTransient('r1'))
    await settle()

    expect(boardStub.focusRequest.mock.calls).toEqual([['r1']])
  })

  it('PickupPosView stops listening to transient notifications after unmount', async () => {
    mockData(makeQueue([]))
    const { wrapper } = await mountView()
    await tap(wrapper)
    wrapper.unmount()

    serverMessage(socket(), 'notification.transient', arrivedTransient('r8'))
    await settle()
    expect(spokenArrivals()).toBe(0)
    expect(boardStub.focusRequest).not.toHaveBeenCalled()
  })

  it('PickupPosView retries focus when the card was not found yet', async () => {
    mockData(makeQueue([]))
    boardStub.focusRequest.mockResolvedValueOnce(false)
    await mountView()

    serverMessage(socket(), 'notification.transient', arrivedTransient('r7'))
    await settle()
    serverMessage(socket(), 'pickup.request_updated', makeRequest({ id: 'r7', status: 'arrived', arrived_at: '2026-10-02T09:00:00Z' }))
    await settle()

    expect(boardStub.focusRequest.mock.calls).toEqual([['r7'], ['r7']])
  })

  it('PickupPosView passes the selected class to the toolbar create dialog', async () => {
    mockData()
    const { wrapper, router } = await mountView({ route: '/pickup?class=c1' })

    tick()
    await button(wrapper, '代建接送請求')?.trigger('click')
    await settle()
    const dialog = () => wrapper.findComponent(PickupCreateDialog)
    expect(dialog().props('classFilter')).toEqual({ id: 'c1', name: '低年級A班' })
    expect(dialog().props('presetStudent')).toBeUndefined()

    for (const query of [{}, { class: 'unassigned' }]) {
      await router.replace({ path: '/pickup', query })
      await settle()
      expect(dialog().props('classFilter')).toBeUndefined()
    }
  })

  it('PickupPosView shows load error with retry', async () => {
    let release: () => void = () => undefined
    mock.onGet(QUEUE_URL).replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時沒有回應', details: null } })
    mock.onGet(QUEUE_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, makeQueue([])])
        }),
    )
    mock.onGet(ROSTER_URL).reply(200, ROSTER)
    mock.onGet(AUTH_URL).reply(200, [])
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入接送資料')
    expect(wrapper.text()).toContain('伺服器暫時沒有回應')
    expect(wrapper.findComponent({ name: 'DismissalPosBoard' }).exists()).toBe(false)
    expect(chipText(wrapper)).toEqual(['待回覆 –', '等待確認 –', '已確認 –', '家長已到 –'])

    tick()
    await button(wrapper, '重試')?.trigger('click')
    await settle()
    // 重試中：回到載入狀態（board 畫骨架），不停在錯誤畫面
    expect(wrapper.text()).not.toContain('無法載入接送資料')
    expect(wrapper.findComponent({ name: 'DismissalPosBoard' }).exists()).toBe(true)

    release()
    await settle()
    expect(wrapper.text()).not.toContain('無法載入接送資料')
    expect(chipText(wrapper)).toEqual(['待回覆 0', '等待確認 0', '已確認 0', '家長已到 0'])
  })

  it('PickupPosView layout follows the approved mockup', () => {
    // happy-dom 不算版面：以原始碼斷言稿的觸控高度、工具列換行條件與抵銷外框 padding
    const css = viewSource.replace(/\s+/g, ' ')
    expect(css).toMatch(/\.touch\.el-button \{[^}]*min-height: 44px/)
    expect(css).toMatch(/\.pos-toolbar \{[^}]*flex-wrap: wrap/)
    expect(css).toMatch(/@media \(min-width: 900px\) \{ \.pos-toolbar \{[^}]*flex-wrap: nowrap/)
    expect(css).toMatch(/\.pos-conn \{[^}]*min-width: 92px/)
    // AdminLayout 內容區 padding：桌機 20、≤1024 為 16、≤767 為 12
    expect(css).toMatch(/\.pos \{[^}]*margin: -20px;[^}]*height: calc\(100% \+ 40px\)/)
    expect(css).toMatch(/@media \(max-width: 1024px\) \{ \.pos \{[^}]*margin: -16px;[^}]*height: calc\(100% \+ 32px\)/)
    expect(css).toMatch(/@media \(max-width: 767px\) \{ \.pos \{[^}]*margin: -12px;[^}]*height: calc\(100% \+ 24px\)/)
  })
})
