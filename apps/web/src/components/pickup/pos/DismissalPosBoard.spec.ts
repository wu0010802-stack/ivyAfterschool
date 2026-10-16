import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Router } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { StaffAuthorization } from '@/api/pickupAuthorizations'
import {
  acknowledgePickupRequest,
  completePickupRequest,
  createPickupRequest,
  replyPickupRequest,
  type PickupQueue,
  type PickupRequest,
  type PickupRoster,
  type RosterStudent,
} from '@/api/pickupRequests'
import { createApiMock, mountWithApp } from '@/test/helpers'
import boardSource from './DismissalPosBoard.vue?raw'
import DismissalPosBoard, { type PosBoardSource } from './DismissalPosBoard.vue'

const NOW = Date.parse('2026-10-02T09:10:00Z')

function student(id: string, no: string, name: string, overrides: Partial<RosterStudent> = {}): RosterStudent {
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
    ...overrides,
  }
}

const CLASS_A = { id: 'c1', name: '低年級A班' }
const CLASS_B = { id: 'c2', name: '中年級B班' }

function makeRequest(id: string, who: RosterStudent, cls: { id: string; name: string }, overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id,
    student: { id: who.student_id, student_no: who.student_no, name: who.name, grade_level: 1, class_id: cls.id, class_name: cls.name },
    service_date: '2026-10-02',
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

const WANG = student('s1', 'S1001', '王小明')
const CHEN = student('s2', 'S1002', '陳小美')
const LIN = student('s3', 'S1003', '林小華', {
  open_request: { id: 'r1', status: 'pending', expected_arrival_at: '17:30', needs_reply: false },
})
const CHANG = student('s4', 'S1004', '張語晴', {
  open_request: { id: 'r2', status: 'arrived', expected_arrival_at: null, needs_reply: false },
})

const R1 = makeRequest('r1', LIN, CLASS_A)
const R2 = makeRequest('r2', CHANG, CLASS_B, { status: 'arrived', arrived_at: '2026-10-02T09:05:00Z', expected_arrival_at: null })

const ROSTER: PickupRoster = {
  date: '2026-10-02',
  classes: [
    { class_id: 'c1', class_name: '低年級A班', students: [WANG, LIN] },
    { class_id: 'c2', class_name: '中年級B班', students: [CHEN, CHANG] },
  ],
}

function makeQueue(open: PickupRequest[], closed: PickupRequest[] = []): PickupQueue {
  return {
    date: '2026-10-02',
    open,
    closed,
    counts: {
      pending: open.filter((r) => r.status === 'pending').length,
      acknowledged: open.filter((r) => r.status === 'acknowledged').length,
      arrived: open.filter((r) => r.status === 'arrived').length,
      needs_reply: open.filter((r) => r.needs_reply).length,
    },
  }
}

type FakeBoard = PosBoardSource & { reload: ReturnType<typeof vi.fn> }

/** 資料以 ref 提供；操作直接打 api（axios-mock-adapter 攔截），與 usePickupBoard 的約定相同 */
function makeBoard(
  opts: { queue?: PickupQueue | null; roster?: PickupRoster | null; authorizations?: StaffAuthorization[] } = {},
): FakeBoard {
  const queue = ref<PickupQueue | null>(opts.queue === undefined ? makeQueue([R1, R2]) : opts.queue)
  return {
    queue,
    roster: ref<PickupRoster | null>(opts.roster === undefined ? ROSTER : opts.roster),
    authorizations: ref<StaffAuthorization[]>(opts.authorizations ?? []),
    reload: vi.fn(() => Promise.resolve()),
    reply: (id, body) => replyPickupRequest(id, body),
    acknowledge: (id) => acknowledgePickupRequest(id),
    complete: (id, body) => completePickupRequest(id, body),
    create: (body) => createPickupRequest(body),
  }
}

const REQUESTS_URL = '/admin/pickup/requests'
const ackUrl = (id: string): string => `${REQUESTS_URL}/${id}/acknowledge`
const cancelUrl = (id: string): string => `${REQUESTS_URL}/${id}/cancel`

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

interface Mounted {
  wrapper: VueWrapper
  router: Router
  board: FakeBoard
}

async function mountBoard(
  props: { canOperate?: boolean; canOverride?: boolean; board?: FakeBoard } = {},
  initialRoute = '/pickup',
): Promise<Mounted> {
  const board = props.board ?? makeBoard()
  const { wrapper, router } = await mountWithApp(DismissalPosBoard, {
    props: { board, canOperate: props.canOperate ?? true, canOverride: props.canOverride ?? false },
    initialRoute,
  })
  await settle()
  return { wrapper: wrapper as VueWrapper, router, board }
}

function railButton(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const btn = wrapper.findAll('.rail__item').find((b) => b.find('.rail__name').text() === label)
  if (!btn) throw new Error(`找不到班級「${label}」`)
  return btn
}

const studentNames = (wrapper: VueWrapper): string[] => wrapper.findAll('.scard__name').map((n) => n.text())

function studentCard(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const card = wrapper.findAll('.scard').find((c) => c.find('.scard__name').text() === name)
  if (!card) throw new Error(`找不到學生卡「${name}」`)
  return card
}

/** 右欄（或抽屜）中的佇列卡：倒數卡 id 為 qc-staging:{student}，請求卡為 qc-{request id} */
const queueCards = (root: Element): Element[] => Array.from(root.querySelectorAll('.qcard'))

function queueColumn(wrapper: VueWrapper): Element {
  const el = wrapper.find('.pos-board__queue')
  if (!el.exists()) throw new Error('沒有右欄')
  return el.element
}

function cardButton(cardId: string, text: string): HTMLButtonElement {
  const card = document.getElementById(`qc-${cardId}`)
  const btn = Array.from(card?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === text)
  if (!btn) throw new Error(`卡片 ${cardId} 沒有「${text}」`)
  return btn as HTMLButtonElement
}

async function swipeOpen(cardId: string): Promise<void> {
  const body = document.getElementById(`qc-${cardId}`)?.querySelector('.queue-card')
  if (!body) throw new Error(`找不到卡片 ${cardId}`)
  const pointer = (clientX: number): PointerEventInit => ({ clientX, clientY: 100, pointerId: 1, bubbles: true })
  body.dispatchEvent(new PointerEvent('pointerdown', pointer(300)))
  body.dispatchEvent(new PointerEvent('pointermove', pointer(240)))
  body.dispatchEvent(new PointerEvent('pointerup', pointer(240)))
  await settle()
}

function messageBox(): DOMWrapper<Element> {
  const el = document.body.querySelector('.el-message-box')
  if (!el) throw new Error('沒有 message box')
  return new DOMWrapper(el)
}

async function clickMessageBoxButton(text: string): Promise<void> {
  const btn = messageBox()
    .findAll('button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`message box 沒有「${text}」`)
  await btn.trigger('click')
  await settle()
  await settle()
}

const cancelBodies = (id: string): unknown[] =>
  mock.history.post.filter((r) => r.url === cancelUrl(id)).map((r) => JSON.parse((r.data as string) || '{}'))

describe('DismissalPosBoard', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('DismissalPosBoard class selection only affects middle column', async () => {
    const { wrapper, router } = await mountBoard()

    // 預設全部班級：依班級分組、標題為全部人數
    expect(wrapper.find('.pos-board__title').text()).toBe('全部班級（4 人）')
    expect(railButton(wrapper, '全部班級').classes()).toContain('is-active')
    expect(wrapper.findAll('.student-grid__group').map((g) => g.text())).toEqual(['低年級A班（2）', '中年級B班（2）'])

    await railButton(wrapper, '低年級A班').trigger('click')
    await settle()

    expect(router.currentRoute.value.query.class).toBe('c1')
    expect(railButton(wrapper, '低年級A班').classes()).toContain('is-active')
    expect(wrapper.find('.pos-board__title').text()).toBe('低年級A班（2 人）')
    expect(studentNames(wrapper).sort()).toEqual(['林小華', '王小明'].sort())
    expect(wrapper.findAll('.student-grid__group')).toHaveLength(0)
    // 右欄佇列永遠是全部班級
    expect(queueCards(queueColumn(wrapper)).map((c) => c.id).sort()).toEqual(['qc-r1', 'qc-r2'])

    await railButton(wrapper, '全部班級').trigger('click')
    await settle()
    expect(router.currentRoute.value.query.class).toBeUndefined()
    expect(studentNames(wrapper)).toHaveLength(4)
  })

  it('DismissalPosBoard restores class selection from the route', async () => {
    const fromRoute = await mountBoard({}, '/pickup?class=c2')
    expect(railButton(fromRoute.wrapper, '中年級B班').classes()).toContain('is-active')
    expect(studentNames(fromRoute.wrapper).sort()).toEqual(['張語晴', '陳小美'].sort())
    fromRoute.wrapper.unmount()

    // 名單裡沒有這個班（換日、班級停用）：回到全部班級
    const unknown = await mountBoard({}, '/pickup?class=zz')
    expect(railButton(unknown.wrapper, '全部班級').classes()).toContain('is-active')
    expect(studentNames(unknown.wrapper)).toHaveLength(4)
  })

  it('DismissalPosBoard quick dispatch stages request', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    mock.onPost(REQUESTS_URL).reply(201, makeRequest('r9', WANG, CLASS_A, { source: 'staff', requested_by_type: 'staff' }))
    const { wrapper } = await mountBoard()

    vi.advanceTimersByTime(1)
    await studentCard(wrapper, '王小明').trigger('click')
    await settle()

    const first = queueCards(queueColumn(wrapper))[0]
    expect(first?.id).toBe('qc-staging:s1')
    expect(first?.textContent).toContain('王小明')
    expect(first?.textContent).toContain('低年級A班')
    expect(mock.history.post).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(5000)
    await settle()

    const posts = mock.history.post.filter((r) => r.url === REQUESTS_URL)
    expect(posts).toHaveLength(1)
    expect(JSON.parse(posts[0]?.data as string).student_id).toBe('s1')
  })

  it('DismissalPosBoard search filters students', async () => {
    const { wrapper } = await mountBoard()
    const search = wrapper.find('.pos-board__search input')
    expect(search.attributes('placeholder')).toBe('搜尋姓名或學號')

    await search.setValue('S1002')
    await settle()

    expect(studentNames(wrapper)).toEqual(['陳小美'])
    // 只過濾中欄
    expect(railButton(wrapper, '全部班級').text()).toContain('4 人')
    expect(queueCards(queueColumn(wrapper))).toHaveLength(2)

    await search.setValue('不存在')
    await settle()
    expect(wrapper.text()).toContain('找不到符合的學生')
  })

  it('DismissalPosBoard cancel prompts for reason', async () => {
    mock.onPost(cancelUrl('r1')).reply(200, { ...R1, status: 'cancelled', cancel_reason: '家長改明天' })
    const { board } = await mountBoard()

    await swipeOpen('r1')
    cardButton('r1', '取消').click()
    await settle()

    expect(messageBox().find('.el-message-box__title').text()).toBe('取消接送請求')
    expect(messageBox().text()).toContain('取消原因（選填，家長發起的請求會通知家長）')
    expect(messageBox().find('input').attributes('placeholder')).toBe('例如：家長改明天接')
    await messageBox().find('input').setValue('  家長改明天  ')
    await clickMessageBoxButton('取消請求')

    expect(cancelBodies('r1')).toEqual([{ reason: '家長改明天' }])
    expect(document.body.textContent).toContain('已取消 林小華 的接送請求')
    // queue.cancel 只回 boolean：成功後重新整理，卡片立即移到已結束
    expect(board.reload).toHaveBeenCalledTimes(1)
  })

  it('DismissalPosBoard cancel can be dismissed or sent without a reason', async () => {
    mock.onPost(cancelUrl('r1')).reply(200, { ...R1, status: 'cancelled' })
    const { board } = await mountBoard()

    await swipeOpen('r1')
    cardButton('r1', '取消').click()
    await settle()
    await clickMessageBoxButton('返回')
    expect(cancelBodies('r1')).toEqual([])
    expect(board.reload).not.toHaveBeenCalled()

    await swipeOpen('r1')
    cardButton('r1', '取消').click()
    await settle()
    await messageBox().find('input').setValue('   ')
    await clickMessageBoxButton('取消請求')
    expect(cancelBodies('r1')).toEqual([{}])
  })

  it('DismissalPosBoard cancel failure keeps the card and does not reload', async () => {
    mock.onPost(cancelUrl('r1')).reply(500, { error: { code: 'internal_error', message: '伺服器暫時沒有回應', details: null } })
    const { wrapper, board } = await mountBoard()

    await swipeOpen('r1')
    cardButton('r1', '取消').click()
    await settle()
    await clickMessageBoxButton('取消請求')

    expect(cancelBodies('r1')).toHaveLength(1)
    expect(board.reload).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('已取消 林小華 的接送請求')
    expect(queueCards(queueColumn(wrapper)).map((c) => c.id)).toContain('qc-r1')
  })

  it('DismissalPosBoard staging cancel does not prompt', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    const { wrapper } = await mountBoard()
    vi.advanceTimersByTime(1)
    await studentCard(wrapper, '王小明').trigger('click')
    await settle()

    vi.advanceTimersByTime(1)
    cardButton('staging:s1', '取消').click()
    await settle()

    expect(document.body.querySelector('.el-message-box')).toBeNull()
    expect(queueCards(queueColumn(wrapper)).map((c) => c.id)).not.toContain('qc-staging:s1')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mock.history.post).toHaveLength(0)
  })

  it('DismissalPosBoard readonly ignores taps', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    const { wrapper } = await mountBoard({ canOperate: false })

    vi.advanceTimersByTime(1)
    await studentCard(wrapper, '王小明').trigger('click')
    await settle()
    await vi.advanceTimersByTimeAsync(5000)

    expect(queueCards(queueColumn(wrapper)).map((c) => c.id)).not.toContain('qc-staging:s1')
    expect(mock.history.post).toHaveLength(0)
    // 唯讀：佇列卡沒有操作鈕
    expect(document.getElementById('qc-r1')?.querySelectorAll('[data-test=queue-actions] button')).toHaveLength(0)
  })

  it('DismissalPosBoard narrow width uses bottom drawer', async () => {
    vi.stubGlobal('innerWidth', 800)
    const { wrapper } = await mountBoard()

    expect(wrapper.find('.pos-board__queue').exists()).toBe(false)
    const fab = wrapper.find('.pos-board__fab button')
    expect(fab.text()).toBe('佇列（2）')
    // 有家長已到：紅色數字徽章
    expect(wrapper.find('.pos-board__fab .el-badge__content').text()).toBe('1')
    expect(document.body.querySelectorAll('.el-drawer .qcard')).toHaveLength(0)

    await fab.trigger('click')
    await settle()

    const drawer = document.body.querySelector('.el-drawer')
    expect(drawer?.textContent).toContain('接送佇列')
    expect(queueCards(drawer as Element).map((c) => c.id).sort()).toEqual(['qc-r1', 'qc-r2'])

    const collapse = Array.from(drawer?.querySelectorAll('button') ?? []).find((b) => b.textContent?.trim() === '收合')
    collapse?.click()
    await settle()
    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(false)

    // 寬度回到 900 以上：恢復右欄、不再有浮動按鈕
    vi.stubGlobal('innerWidth', 1024)
    window.dispatchEvent(new Event('resize'))
    await settle()
    expect(wrapper.find('.pos-board__fab').exists()).toBe(false)
    expect(queueCards(queueColumn(wrapper))).toHaveLength(2)
  })

  it('DismissalPosBoard narrow fab hides the badge when nobody has arrived', async () => {
    vi.stubGlobal('innerWidth', 800)
    const { wrapper } = await mountBoard({ board: makeBoard({ queue: makeQueue([R1]) }) })

    expect(wrapper.find('.pos-board__fab button').text()).toBe('佇列（1）')
    const badge = wrapper.find('.pos-board__fab .el-badge__content')
    expect(badge.exists() && (badge.element as HTMLElement).style.display !== 'none').toBe(false)
  })

  it('DismissalPosBoard marks card busy while acknowledging', async () => {
    let release: () => void = () => undefined
    mock.onPost(ackUrl('r1')).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, { ...R1, status: 'acknowledged' }])
        }),
    )
    await mountBoard()

    cardButton('r1', '確認').click()
    await settle()

    expect(cardButton('r1', '確認').classList.contains('is-loading')).toBe(true)
    expect(cardButton('r1', '回覆時間').disabled).toBe(true)

    // 送出中再點一次（繞過按鈕停用）：不再送
    cardButton('r1', '確認').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    expect(mock.history.post.filter((r) => r.url === ackUrl('r1'))).toHaveLength(1)

    release()
    await settle()
    expect(cardButton('r1', '確認').classList.contains('is-loading')).toBe(false)
    expect(cardButton('r1', '回覆時間').disabled).toBe(false)
  })

  it('DismissalPosBoard clears busy and reports acknowledge failures', async () => {
    mock.onPost(ackUrl('r1')).reply(500, { error: { code: 'internal_error', message: '伺服器暫時沒有回應', details: null } })
    await mountBoard()

    cardButton('r1', '確認').click()
    await settle()

    expect(document.body.textContent).toContain('伺服器暫時沒有回應')
    expect(cardButton('r1', '確認').classList.contains('is-loading')).toBe(false)
  })

  it('DismissalPosBoard marks card busy while cancelling', async () => {
    let release: () => void = () => undefined
    mock.onPost(cancelUrl('r1')).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, { ...R1, status: 'cancelled' }])
        }),
    )
    const { board } = await mountBoard()

    await swipeOpen('r1')
    cardButton('r1', '取消').click()
    await settle()
    await clickMessageBoxButton('取消請求')

    expect(cardButton('r1', '確認').classList.contains('is-loading')).toBe(true)
    expect(board.reload).not.toHaveBeenCalled()

    release()
    await settle()
    expect(board.reload).toHaveBeenCalledTimes(1)
    expect(cardButton('r1', '確認').classList.contains('is-loading')).toBe(false)
  })

  it('DismissalPosBoard focus request scrolls and flashes the queue card', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { wrapper } = await mountBoard()

    await studentCard(wrapper, '林小華').trigger('click')
    await settle()

    expect(scroll.mock.contexts.map((el) => (el as Element).id)).toEqual(['qc-r1'])
    expect(document.getElementById('qc-r1')?.classList.contains('is-flash')).toBe(true)
  })

  it('DismissalPosBoard narrow focus opens the drawer first', async () => {
    vi.stubGlobal('innerWidth', 800)
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    const { wrapper } = await mountBoard()

    await studentCard(wrapper, '張語晴').trigger('click')
    await settle()

    expect(wrapper.findComponent({ name: 'ElDrawer' }).props('modelValue')).toBe(true)
    const card = document.body.querySelector('.el-drawer #qc-r2')
    expect(card?.classList.contains('is-flash')).toBe(true)
    expect(scroll.mock.contexts.map((el) => (el as Element).id)).toEqual(['qc-r2'])

    // 頁面（家長到達時）也可呼叫
    const exposed = wrapper.vm as unknown as { focusRequest(id: string): Promise<boolean> }
    expect(await exposed.focusRequest('r1')).toBe(true)
    expect(await exposed.focusRequest('nope')).toBe(false)
  })

  it('DismissalPosBoard opens reply and complete dialogs from queue cards', async () => {
    mock.onGet('/admin/students/s4/guardians').reply(200, [])
    const authorization: StaffAuthorization = {
      id: 'pa1',
      student: R2.student,
      student_id: 's4',
      service_date: '2026-10-02',
      pickup_person_id: null,
      proxy_name: '陳阿姨',
      proxy_phone: '0912-000-456',
      code_last4: '4821',
      status: 'active',
      effective_status: 'active',
      verified_at: null,
      verification_method: null,
      created_at: '2026-10-02T01:00:00Z',
      photo_url: null,
      code_attempts: 0,
      locked: false,
      verified_by_name: null,
    }
    const { router } = await mountBoard({ board: makeBoard({ authorizations: [authorization] }) })

    cardButton('r1', '回覆時間').click()
    await settle()
    const titles = (): string[] => Array.from(document.body.querySelectorAll('.el-dialog__title')).map((t) => t.textContent ?? '')
    expect(titles()).toContain('回覆預計可接送時間：林小華')

    cardButton('r2', '完成交付').click()
    await settle()
    expect(titles()).toContain('完成交付：張語晴')

    // 代理授權：導到核驗頁
    const dialog = Array.from(document.body.querySelectorAll('.el-dialog')).find((d) => d.textContent?.includes('完成交付：張語晴'))
    const proxy = Array.from(dialog?.querySelectorAll('.el-radio') ?? []).find((r) => r.textContent?.includes('陳阿姨'))
    ;(proxy?.querySelector('input') as HTMLInputElement).click()
    await settle()
    const submit = Array.from(dialog?.querySelectorAll('.el-dialog__footer button') ?? []).at(-1) as HTMLButtonElement
    expect(submit.textContent?.trim()).toBe('前往核驗')
    submit.click()
    await settle()

    expect(router.currentRoute.value.path).toBe('/pickup/authorizations')
    expect(router.currentRoute.value.query.verify).toBe('pa1')
  })

  it('DismissalPosBoard create request preselects the student', async () => {
    const { wrapper } = await mountBoard()

    await studentCard(wrapper, '王小明').find('.scard__more').trigger('click')
    await settle()
    const item = Array.from(document.body.querySelectorAll('.el-dropdown-menu__item')).find((i) =>
      i.textContent?.includes('代建接送請求'),
    ) as HTMLElement | undefined
    item?.click()
    await settle()

    const dialog = Array.from(document.body.querySelectorAll('.el-dialog')).find((d) => d.textContent?.includes('代建接送請求'))
    expect(dialog?.textContent).toContain('王小明')
    expect(dialog?.textContent).toContain('S1001')
    expect(dialog?.querySelector('.el-select')).toBeNull()
  })

  it('DismissalPosBoard shows skeletons until the first load', async () => {
    const { wrapper, board } = await mountBoard({ board: makeBoard({ queue: null, roster: null }) })

    expect(wrapper.findAll('.pos-board__rail .el-skeleton')).toHaveLength(5)
    expect(wrapper.findAll('.pos-board__cards .el-skeleton')).toHaveLength(9)
    expect(queueColumn(wrapper).textContent).toContain('進行中（—）')
    expect(wrapper.findAll('.scard')).toHaveLength(0)

    board.roster.value = ROSTER
    board.queue.value = makeQueue([R1])
    await settle()
    expect(wrapper.findAll('.el-skeleton')).toHaveLength(0)
    expect(studentNames(wrapper)).toHaveLength(4)
    expect(queueColumn(wrapper).textContent).toContain('進行中（1）')
  })

  it('DismissalPosBoard layout follows the approved mockup', () => {
    // happy-dom 不算版面：以原始碼斷言稿的欄寬、搜尋框與浮動按鈕高度
    const css = boardSource.replace(/\s+/g, ' ')
    expect(css).toMatch(/\.pos-board \{[^}]*grid-template-columns: 148px minmax\(0, 1fr\) 320px/)
    expect(css).toMatch(/@media \(min-width: 1025px\) \{ \.pos-board \{[^}]*grid-template-columns: 160px minmax\(0, 1fr\) 340px/)
    expect(css).toMatch(/\.pos-board\.is-narrow \{[^}]*grid-template-columns: 148px minmax\(0, 1fr\)[;\s}]/)
    expect(css).toMatch(/\.pos-board__search :deep\(\.el-input__wrapper\) \{[^}]*min-height: 44px/)
    expect(css).toMatch(/\.pos-board__fab \.el-button \{[^}]*min-height: 48px/)
  })
})
