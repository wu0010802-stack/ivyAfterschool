import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type { AxiosRequestConfig } from 'axios'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { StaffAuthorization, VerifyResult } from '@/api/pickupAuthorizations'
import type { PickupRequest } from '@/api/pickupRequests'
import { useAdminWsStore } from '@/stores/adminWs'
import { createApiMock, mountWithApp } from '@/test/helpers'
import PickupAuthorizationsView from './PickupAuthorizationsView.vue'

/** 只模擬 adminWs store 需要的部分：開線、送訊息給頁面 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  sent: string[] = []
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverMessage(type: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type, data, sent_at: '2026-10-06T08:30:00Z' }) } as MessageEvent)
  }
}

const AUTH_URL = '/admin/pickup/authorizations'
const QUEUE_URL = '/admin/pickup/queue'
const TODAY = '2026-10-06'
const OPERATOR = ['pickup:read', 'pickup:operate', 'pickup:override']

function makeAuthorization(overrides: Partial<StaffAuthorization> = {}): StaffAuthorization {
  return {
    id: 'pa1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 2, class_id: 'c1', class_name: '低年級A班' },
    student_id: 's1',
    service_date: TODAY,
    pickup_person_id: null,
    proxy_name: '陳阿姨',
    proxy_phone: '0912-000-123',
    code_last4: '4821',
    status: 'active',
    effective_status: 'active',
    verified_at: null,
    verification_method: null,
    created_at: '2026-10-06T06:00:00Z',
    photo_url: null,
    code_attempts: 0,
    locked: false,
    verified_by_name: null,
    ...overrides,
  }
}

/** 有效、王小明的代理人 */
const CHEN = makeAuthorization()
/** 已接送、林小華（最晚有動作，但不是 active，要排在 active 之後） */
const LIN = makeAuthorization({
  id: 'pa2',
  student: { id: 's2', student_no: 'S11302', name: '林小華', grade_level: 3, class_id: 'c2', class_name: '中年級班' },
  student_id: 's2',
  proxy_name: '林叔叔',
  proxy_phone: '0912-000-456',
  code_last4: '1357',
  status: 'completed',
  effective_status: 'completed',
  verified_at: '2026-10-06T08:00:00Z',
  verification_method: 'code',
  verified_by_name: '張主任',
  created_at: '2026-10-06T05:00:00Z',
})
/** 有效但已鎖定、王小明的另一位代理人（比陳阿姨晚建立） */
const HUANG = makeAuthorization({
  id: 'pa3',
  proxy_name: '黃阿姨',
  proxy_phone: '0912-000-789',
  code_last4: '2468',
  code_attempts: 5,
  locked: true,
  created_at: '2026-10-06T07:00:00Z',
})

function makeRequest(overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id: 'r1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 2, class_id: 'c1', class_name: '低年級A班' },
    service_date: TODAY,
    source: 'staff',
    requested_by_type: 'staff',
    requested_by_name: '張主任',
    expected_arrival_at: null,
    status: 'completed',
    homework_status_at_request: 'done',
    current_homework_status: 'done',
    current_ready_eta: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    replied_by_name: null,
    needs_reply: false,
    arrived_at: null,
    completed_at: '2026-10-06T08:30:00Z',
    completed_by_name: '林行政',
    completion_method: 'code',
    picked_up_by_name: '陳阿姨',
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-10-06T08:30:00Z',
    ...overrides,
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

/** 依 params.date 回應授權清單；沒有列出的日期回 [] */
function mockAuthorizations(byDate: Record<string, StaffAuthorization[]>): void {
  mock.onGet(AUTH_URL).reply((config: AxiosRequestConfig) => {
    const date = (config.params as { date?: string } | undefined)?.date ?? TODAY
    return [200, byDate[date] ?? []]
  })
}

async function mountView(
  { permissions = OPERATOR, route = '/pickup/authorizations' } = {},
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const { wrapper, router } = await mountWithApp(PickupAuthorizationsView, {
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
  await settle()
  return { wrapper: wrapper as VueWrapper, router }
}

function authGets(): AxiosRequestConfig[] {
  return mock.history.get.filter((r) => r.url === AUTH_URL)
}

function cardNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.acard2 .acard2__name').map((n) => n.text())
}

function verifyButtons(wrapper: VueWrapper): DOMWrapper<HTMLButtonElement>[] {
  return wrapper.findAll<HTMLButtonElement>('button').filter((b) => b.text().trim() === '核驗')
}

function button(wrapper: VueWrapper, text: string): DOMWrapper<HTMLButtonElement> {
  const btn = wrapper.findAll<HTMLButtonElement>('button').find((b) => b.text().trim() === text)
  if (!btn) throw new Error(`找不到按鈕 ${text}`)
  return btn
}

function chipTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.pa-chips .el-radio-button').map((c) => c.text().replace(/\s+/g, ' ').trim())
}

async function chooseChip(wrapper: VueWrapper, label: string): Promise<void> {
  const chip = wrapper.findAll('.pa-chips .el-radio-button').find((c) => c.text().trim().startsWith(label))
  if (!chip) throw new Error(`找不到狀態篩選 ${label}`)
  await chip.find('input').setValue(true)
  await settle()
}

async function search(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.find('.pa-search input').setValue(text)
  await settle()
}

async function chooseDate(wrapper: VueWrapper, date: string): Promise<void> {
  const input = wrapper.find('.pa-date input')
  await input.trigger('focus')
  await input.setValue(date.replaceAll('-', '/'))
  await input.trigger('change')
  await settle()
}

function openDialog(): DOMWrapper<Element> | null {
  const el = Array.from(document.body.querySelectorAll<HTMLElement>('.el-dialog')).find(
    (d) => d.closest<HTMLElement>('.el-overlay')?.style.display !== 'none',
  )
  return el ? new DOMWrapper(el) : null
}

function socket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1)
  if (!s) throw new Error('沒有建立 WebSocket')
  return s
}

// 頁面含日期元件、狀態分段與多張卡片，happy-dom 下單一案例數秒，多 agent 並行時易超過預設 5 秒
describe('PickupAuthorizationsView', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 台北 2026-10-06（二）16:30
    vi.setSystemTime(new Date('2026-10-06T08:30:00Z'))
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    mock = createApiMock(adminHttp)
    mock.onGet(QUEUE_URL).reply(200, { date: TODAY, open: [], closed: [], counts: {} })
  })

  afterEach(() => {
    useAdminWsStore().stop()
    mock.restore()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('PickupAuthorizationsView lists today with status counts', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper } = await mountView()

    expect(authGets().map((r) => r.params)).toEqual([{ date: TODAY }])
    expect(chipTexts(wrapper)).toEqual(['全部 3', '有效 2', '已接送 1', '已取消 0', '已過期 0'])
    // active 在前（較晚建立的在前），其餘依核驗 / 建立時間新到舊
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨', '林叔叔'])
    // 已鎖定的有效授權仍可開核驗（由 dialog 處理強制完成），已接送的沒有
    expect(verifyButtons(wrapper)).toHaveLength(2)
    expect(wrapper.text()).not.toContain('僅檢視')
    expect(wrapper.text()).not.toContain('僅供查詢')
  })

  it('PickupAuthorizationsView lists today with status counts: chip filters locally', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper } = await mountView()
    const gets = authGets().length

    await chooseChip(wrapper, '已接送')
    expect(cardNames(wrapper)).toEqual(['林叔叔'])

    await chooseChip(wrapper, '已取消')
    expect(cardNames(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('沒有符合條件的授權')
    await button(wrapper, '清除篩選').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨', '林叔叔'])
    expect(authGets()).toHaveLength(gets)
  })

  it('PickupAuthorizationsView searches by proxy and last4', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper } = await mountView()

    await search(wrapper, '4821')
    expect(cardNames(wrapper)).toEqual(['陳阿姨'])

    await search(wrapper, '陳阿姨')
    expect(cardNames(wrapper)).toEqual(['陳阿姨'])
    // 計數不受搜尋影響
    expect(chipTexts(wrapper)).toContain('有效 2')
  })

  it('PickupAuthorizationsView searches by proxy and last4: phone without dashes, student name, no match', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper } = await mountView()

    await search(wrapper, '0912 000-456')
    expect(cardNames(wrapper)).toEqual(['林叔叔'])

    await search(wrapper, '王小明')
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨'])

    await search(wrapper, '張')
    expect(cardNames(wrapper)).toEqual([])
    expect(wrapper.text()).toContain('沒有符合條件的授權')
    expect(wrapper.text()).toContain('試著調整搜尋文字或狀態篩選')
    await button(wrapper, '清除篩選').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨', '林叔叔'])
    expect((wrapper.find('.pa-search input').element as HTMLInputElement).value).toBe('')
  })

  it('PickupAuthorizationsView filters by student from query', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper, router } = await mountView({ route: '/pickup/authorizations?student_id=s1' })

    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨'])
    expect(wrapper.text()).toContain('只顯示：王小明')
    // 有「只顯示」時計數為該生的授權
    expect(chipTexts(wrapper)).toEqual(['全部 2', '有效 2', '已接送 0', '已取消 0', '已過期 0'])

    await button(wrapper, '清除').trigger('click')
    await settle()

    expect(router.currentRoute.value.query).not.toHaveProperty('student_id')
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨', '林叔叔'])
    expect(wrapper.text()).not.toContain('只顯示')
  })

  it('PickupAuthorizationsView filters by student from query: clear keeps other query', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper, router } = await mountView({ route: '/pickup/authorizations?student_id=s1&from=pos' })

    await button(wrapper, '清除').trigger('click')
    await settle()

    expect(router.currentRoute.value.query).toEqual({ from: 'pos' })
  })

  it('PickupAuthorizationsView auto opens verify from query', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { router } = await mountView({ route: '/pickup/authorizations?verify=pa1' })

    const dialog = openDialog()
    expect(dialog?.find('.el-dialog__title').text()).toContain('陳阿姨')
    // 參數只用一次：關掉後重新整理不會再自動開
    expect(router.currentRoute.value.query).not.toHaveProperty('verify')
  })

  it('PickupAuthorizationsView auto opens verify from query: keeps other query', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper, router } = await mountView({ route: '/pickup/authorizations?verify=pa1&student_id=s1' })

    expect(openDialog()?.find('.el-dialog__title').text()).toContain('陳阿姨')
    expect(router.currentRoute.value.query).toEqual({ student_id: 's1' })
    expect(wrapper.text()).toContain('只顯示：王小明')
  })

  it('PickupAuthorizationsView auto opens verify from query: skips inactive or readers', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    await mountView({ route: '/pickup/authorizations?verify=pa2' })
    expect(openDialog()).toBeNull()

    document.body.innerHTML = ''
    await mountView({ route: '/pickup/authorizations?verify=pa1', permissions: ['pickup:read'] })
    expect(openDialog()).toBeNull()
  })

  it('PickupAuthorizationsView past date is readonly', async () => {
    // 即使後端回了 active，過去日期也不可核驗
    const past = [
      makeAuthorization({ id: 'pb1', service_date: '2026-10-01', proxy_name: '周阿姨', code_last4: '1111' }),
      makeAuthorization({
        id: 'pb2',
        service_date: '2026-10-01',
        proxy_name: '吳叔叔',
        code_last4: '2222',
        status: 'active',
        effective_status: 'expired',
      }),
    ]
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG], '2026-10-01': past })
    const { wrapper } = await mountView()
    expect(verifyButtons(wrapper)).toHaveLength(2)

    await chooseDate(wrapper, '2026-10-01')

    expect(authGets().at(-1)?.params).toEqual({ date: '2026-10-01' })
    expect(cardNames(wrapper)).toEqual(['周阿姨', '吳叔叔'])
    expect(chipTexts(wrapper)).toEqual(['全部 2', '有效 1', '已接送 0', '已取消 0', '已過期 1'])
    expect(verifyButtons(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('檢視 10/01（四）的紀錄：僅供查詢，不能核驗')

    // 回到今天恢復可核驗，不需重抓
    const gets = authGets().length
    await chooseDate(wrapper, TODAY)
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨', '林叔叔'])
    expect(verifyButtons(wrapper)).toHaveLength(2)
    expect(authGets()).toHaveLength(gets)
  })

  it('PickupAuthorizationsView past date is readonly: late response of an earlier date is ignored', async () => {
    const older = makeAuthorization({ id: 'pb1', service_date: '2026-10-01', proxy_name: '周阿姨', effective_status: 'expired' })
    const newer = makeAuthorization({ id: 'pb2', service_date: '2026-10-02', proxy_name: '吳叔叔', effective_status: 'expired' })
    let releaseOlder: (() => void) | null = null
    mock.onGet(AUTH_URL).reply((config: AxiosRequestConfig) => {
      const date = (config.params as { date?: string } | undefined)?.date
      if (date === '2026-10-01') {
        return new Promise((resolve) => {
          releaseOlder = () => resolve([200, [older]])
        })
      }
      if (date === '2026-10-02') return [200, [newer]]
      return [200, [CHEN]]
    })
    const { wrapper } = await mountView()

    await chooseDate(wrapper, '2026-10-01')
    await chooseDate(wrapper, '2026-10-02')
    expect(cardNames(wrapper)).toEqual(['吳叔叔'])

    // 先選的日期較晚才回來：不可蓋掉目前選的日期
    expect(releaseOlder).not.toBeNull()
    releaseOlder!()
    await settle()
    expect(cardNames(wrapper)).toEqual(['吳叔叔'])
    expect(wrapper.text()).toContain('檢視 10/02（五）的紀錄')
  })

  it('PickupAuthorizationsView past date is readonly: future and older than 30 days are not selectable', async () => {
    mockAuthorizations({ [TODAY]: [CHEN] })
    const { wrapper } = await mountView()

    await chooseDate(wrapper, '2026-10-07')
    await chooseDate(wrapper, '2026-09-05')
    expect(authGets().map((r) => (r.params as { date: string }).date)).toEqual([TODAY])
    expect(wrapper.text()).not.toContain('僅供查詢')

    // 今天 − 30 天仍可選
    await chooseDate(wrapper, '2026-09-06')
    expect(authGets().at(-1)?.params).toEqual({ date: '2026-09-06' })
  })

  it('PickupAuthorizationsView shows loading skeleton with placeholder counts', async () => {
    let release: (() => void) | null = null
    mock.onGet(AUTH_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, [CHEN]])
        }),
    )
    const { wrapper } = await mountView()

    expect(chipTexts(wrapper)).toEqual(['全部 —', '有效 —', '已接送 —', '已取消 —', '已過期 —'])
    expect(wrapper.findAll('.pa-skel')).toHaveLength(4)
    expect(wrapper.text()).not.toContain('今天沒有代理接送授權')

    release!()
    await settle()
    expect(wrapper.findAll('.pa-skel')).toHaveLength(0)
    expect(chipTexts(wrapper)).toEqual(['全部 1', '有效 1', '已接送 0', '已取消 0', '已過期 0'])
  })

  it('PickupAuthorizationsView empty state', async () => {
    mockAuthorizations({})
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('今天沒有代理接送授權')
    expect(wrapper.text()).toContain('家長在家長端建立代理接送授權後，會即時出現在這裡')
    expect(chipTexts(wrapper)).toEqual(['全部 0', '有效 0', '已接送 0', '已取消 0', '已過期 0'])
  })

  it('PickupAuthorizationsView past date empty copy', async () => {
    mockAuthorizations({ [TODAY]: [CHEN] })
    const { wrapper } = await mountView()

    await chooseDate(wrapper, '2026-10-05')

    expect(authGets().at(-1)?.params).toEqual({ date: '2026-10-05' })
    expect(wrapper.text()).toContain('10/05（一）沒有代理接送授權')
    expect(wrapper.text()).not.toContain('家長在家長端建立代理接送授權後')
  })

  it('PickupAuthorizationsView marks readers', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const { wrapper } = await mountView({ permissions: ['pickup:read'] })

    expect(wrapper.text()).toContain('僅檢視')
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨', '林叔叔'])
    expect(verifyButtons(wrapper)).toHaveLength(0)
  })

  it('PickupAuthorizationsView verifies and updates the list with the result', async () => {
    mockAuthorizations({ [TODAY]: [CHEN, LIN, HUANG] })
    const done = makeAuthorization({
      status: 'completed',
      effective_status: 'completed',
      verified_at: '2026-10-06T08:30:00Z',
      verification_method: 'code',
      verified_by_name: '林行政',
    })
    const result: VerifyResult = { authorization: done, request: makeRequest() }
    mock.onPost(`${AUTH_URL}/pa1/verify`).reply(200, result)
    const { wrapper } = await mountView()

    const chenCard = wrapper.findAll('.acard2').find((c) => c.find('.acard2__name').text() === '陳阿姨')
    await chenCard!.find('button').trigger('click')
    await settle()
    expect(openDialog()?.find('.el-dialog__title').text()).toBe('核驗代理接送：陳阿姨')

    const firstBox = openDialog()!.find<HTMLInputElement>('.code-box')
    await firstBox.setValue('123456')
    await settle()

    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({ code: '123456' })
    expect(openDialog()?.text()).toContain('已完成接送：王小明 由 陳阿姨 接走（接送碼核驗）')
    expect(chipTexts(wrapper)).toEqual(['全部 3', '有效 1', '已接送 2', '已取消 0', '已過期 0'])
    expect(cardNames(wrapper)).toEqual(['黃阿姨', '陳阿姨', '林叔叔'])
    expect(verifyButtons(wrapper)).toHaveLength(1)
  })

  it('PickupAuthorizationsView passes the current authorization to the open dialog', async () => {
    let attempts = 0
    mock.onGet(AUTH_URL).reply(() => [200, [makeAuthorization({ code_attempts: attempts }), LIN]])
    const { wrapper, pinia } = await mountWithApp(PickupAuthorizationsView, {
      initialRoute: '/pickup/authorizations',
      piniaInitialState: {
        auth: {
          status: 'authenticated',
          user: {
            id: 'u1',
            username: 'clerk01',
            display_name: '林行政',
            role: { id: 'r-clerk', code: 'clerk', name: '行政' },
            permissions: OPERATOR,
            must_change_password: false,
          },
        },
      },
    })
    useAdminWsStore(pinia).start()
    socket().serverOpen()
    await settle()

    await verifyButtons(wrapper as VueWrapper)[0]!.trigger('click')
    await settle()
    expect(openDialog()?.text()).toContain('尚無錯誤')

    // 另一台平板輸錯碼：BACKEND-562 錯碼累計 / 鎖定後推播 pickup.authorization_updated（只帶家長端形狀）
    // → 重抓清單，開著的 dialog 要看到最新的錯誤次數
    attempts = 3
    const event: Record<string, unknown> = { ...CHEN }
    for (const key of ['student', 'photo_url', 'code_attempts', 'locked', 'verified_by_name']) delete event[key]
    socket().serverMessage('pickup.authorization_updated', event)
    await settle()

    expect(authGets().length).toBeGreaterThanOrEqual(2)
    expect(openDialog()?.text()).toContain('已錯誤 3 次，還可嘗試 2 次')
  })

  it('PickupAuthorizationsView refetches after the verify dialog closes', async () => {
    // 錯碼與鎖定後端不推播（另一台平板的同步見 BACKEND-562），本頁在 dialog 關閉時重抓清單
    let serverChen = CHEN
    mock.onGet(AUTH_URL).reply(() => [200, [serverChen, LIN]])
    mock
      .onPost(`${AUTH_URL}/pa1/verify`)
      .replyOnce(() => {
        serverChen = { ...CHEN, code_attempts: 1 }
        return [400, { error: { code: 'pickup_code_mismatch', message: '接送碼錯誤', details: { remaining_attempts: 4 } } }]
      })
      .onPost(`${AUTH_URL}/pa1/verify`)
      .replyOnce(() => {
        serverChen = { ...CHEN, code_attempts: 5, locked: true }
        return [409, { error: { code: 'pickup_code_locked', message: '接送碼已鎖定', details: null } }]
      })
    // 沒有 pickup:override：鎖定後只剩「關閉」
    const { wrapper } = await mountView({ permissions: ['pickup:read', 'pickup:operate'] })
    const chenCard = (): DOMWrapper<Element> =>
      wrapper.findAll('.acard2').find((c) => c.find('.acard2__name').text() === '陳阿姨')!

    await chenCard().find('button').trigger('click')
    await settle()
    await openDialog()!.find<HTMLInputElement>('.code-box').setValue('111111')
    await settle()
    expect(openDialog()?.text()).toContain('接送碼錯誤，還可嘗試 4 次')
    const getsBeforeClose = authGets().length

    await openDialog()!.find('.el-dialog__headerbtn').trigger('click')
    await settle()
    expect(authGets()).toHaveLength(getsBeforeClose + 1)
    expect(chenCard().text()).toContain('已錯誤 1 次')

    // 重開 dialog 拿到的是重抓後的錯誤次數
    await chenCard().find('button').trigger('click')
    await settle()
    expect(openDialog()?.text()).toContain('已錯誤 1 次，還可嘗試 4 次')

    await openDialog()!.find<HTMLInputElement>('.code-box').setValue('222222')
    await settle()
    expect(openDialog()?.text()).toContain('已錯誤 5 次，已鎖定')
    const close = Array.from(openDialog()!.element.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === '關閉',
    )
    expect(close).toBeDefined()
    close!.click()
    await settle()

    expect(authGets()).toHaveLength(getsBeforeClose + 2)
    expect(chenCard().text()).toContain('已鎖定')
    await chenCard().find('button').trigger('click')
    await settle()
    expect(openDialog()?.text()).toContain('已錯誤 5 次，已鎖定')
    expect(openDialog()?.text()).not.toContain('尚無錯誤')
  })

  it('PickupAuthorizationsView follows today across midnight', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    // 台北 2026-10-06（二）23:59:30
    vi.setSystemTime(new Date('2026-10-06T15:59:30Z'))
    const next = makeAuthorization({ id: 'pn1', service_date: '2026-10-07', proxy_name: '何阿姨', code_last4: '9999' })
    mockAuthorizations({ [TODAY]: [CHEN], '2026-10-07': [next] })
    const { wrapper } = await mountView()
    expect(cardNames(wrapper)).toEqual(['陳阿姨'])

    vi.advanceTimersByTime(60_000)
    await settle()

    // 日期欄、唯讀提示與清單都換到新的一天
    expect((wrapper.find('.pa-date input').element as HTMLInputElement).value).toBe('2026/10/07')
    expect(authGets().at(-1)?.params).toEqual({ date: '2026-10-07' })
    expect(cardNames(wrapper)).toEqual(['何阿姨'])
    expect(wrapper.text()).not.toContain('僅供查詢')
    expect(verifyButtons(wrapper)).toHaveLength(1)

    // 昨天變成過去日期：直接查、唯讀
    await chooseDate(wrapper, '2026-10-06')
    expect(authGets().at(-1)?.params).toEqual({ date: '2026-10-06' })
    expect(wrapper.text()).toContain('檢視 10/06（二）的紀錄：僅供查詢，不能核驗')
    expect(verifyButtons(wrapper)).toHaveLength(0)

    // 新的今天可選（不被當成未來日期），選回不需重抓
    const gets = authGets().length
    await chooseDate(wrapper, '2026-10-07')
    expect(cardNames(wrapper)).toEqual(['何阿姨'])
    expect(verifyButtons(wrapper)).toHaveLength(1)
    expect(authGets()).toHaveLength(gets)
  })

  it('PickupAuthorizationsView shows load error and retries', async () => {
    mock.onGet(AUTH_URL).replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應' } })
    mockAuthorizations({ [TODAY]: [CHEN] })
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入代理接送授權')
    expect(cardNames(wrapper)).toEqual([])

    await button(wrapper, '重試').trigger('click')
    await settle()

    expect(wrapper.text()).not.toContain('無法載入代理接送授權')
    expect(cardNames(wrapper)).toEqual(['陳阿姨'])
  })
})
