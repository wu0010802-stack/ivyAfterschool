import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { PickupRequest } from '@/api/pickupRequests'
import type { PosQueueItem } from '@/composables/useDismissalPosQueue'
import { mountWithApp } from '@/test/helpers'
import panelSource from './QueuePanel.vue?raw'
import QueuePanel from './QueuePanel.vue'

/** 台北 2026-10-02 17:10 */
const NOW = Date.parse('2026-10-02T09:10:00Z')
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()

function makeRequest(id: string, overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id,
    student: { id: `s-${id}`, student_no: 'S11301', name: '王小明', grade_level: 1, class_id: 'c1', class_name: '低年級A班' },
    service_date: '2026-10-02',
    source: 'parent',
    requested_by_type: 'parent',
    requested_by_name: '王媽媽',
    expected_arrival_at: '17:30',
    status: 'pending',
    homework_status_at_request: 'in_progress',
    current_homework_status: 'in_progress',
    current_ready_eta: '17:40',
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

function itemOf(request: PickupRequest, phase: 'active' | 'closed'): PosQueueItem {
  return {
    id: request.id,
    phase,
    studentId: request.student.id,
    studentName: request.student.name,
    className: request.student.class_name ?? '',
    countdown: null,
    request,
  }
}

function stagingItem(studentId: string, name: string): PosQueueItem {
  return {
    id: `staging:${studentId}`,
    phase: 'staging',
    studentId,
    studentName: name,
    className: '中年級班',
    countdown: { startedAt: NOW, durationMs: 5000 },
    request: null,
  }
}

const STAGING = stagingItem('s9', '陳小美')
const PENDING = itemOf(makeRequest('r1'), 'active')
const ARRIVED = itemOf(
  makeRequest('r2', { status: 'arrived', needs_reply: false, arrived_at: minutesAgo(2), student: { id: 's2', student_no: 'S11302', name: '林小華', grade_level: 2, class_id: 'c1', class_name: '低年級A班' } }),
  'active',
)
const CLOSED = [
  itemOf(makeRequest('c1', { status: 'completed', needs_reply: false, completed_at: minutesAgo(5), completion_method: 'guardian', picked_up_by_name: '王媽媽', completed_by_name: '林行政' }), 'closed'),
  itemOf(makeRequest('c2', { status: 'cancelled', needs_reply: false, cancelled_at: minutesAgo(20), cancel_reason: '改由爺爺來接' }), 'closed'),
  itemOf(makeRequest('c3', { status: 'expired', needs_reply: false }), 'closed'),
]
const ALL = [STAGING, PENDING, ARRIVED, ...CLOSED]

interface PanelExposed {
  focus: (requestId: string) => Promise<boolean>
}

async function mountPanel(props: { items: PosQueueItem[]; canOperate?: boolean; loading?: boolean }): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(QueuePanel, { props: { canOperate: true, ...props } })
  document.body.appendChild(wrapper.element)
  return wrapper as VueWrapper
}

const card = (wrapper: VueWrapper, id: string): DOMWrapper<Element> => wrapper.find(`[id="qc-${id}"]`)
const cardIds = (wrapper: VueWrapper, selector: string): string[] =>
  wrapper.findAll(`${selector} .qcard`).map((c) => (c.attributes('id') ?? '').replace(/^qc-/, ''))

function closedToggle(wrapper: VueWrapper): DOMWrapper<Element> {
  const toggle = wrapper.findAll('button').find((b) => b.text().includes('今日已結束'))
  if (!toggle) throw new Error('找不到「今日已結束」按鈕')
  return toggle
}

function buttonIn(wrapper: VueWrapper, id: string, text: string): DOMWrapper<Element> {
  const btn = card(wrapper, id)
    .findAll('button')
    .find((b) => b.text() === text && b.attributes('disabled') === undefined)
  if (!btn) throw new Error(`卡片 ${id} 沒有「${text}」按鈕`)
  return btn
}

describe('QueuePanel', () => {
  let scroll: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('QueuePanel splits active and closed', async () => {
    const wrapper = await mountPanel({ items: ALL })

    expect(wrapper.text()).toContain('進行中（3）')
    expect(wrapper.text()).toContain('今日已結束（3）')
    // 進行中區依傳入順序：倒數卡 → 進行中
    expect(cardIds(wrapper, '[data-test=queue-active]')).toEqual(['staging:s9', 'r1', 'r2'])
    // 預設收合：已結束卡不渲染
    expect(wrapper.findAll('.qcard.phase-closed')).toHaveLength(0)
    expect(closedToggle(wrapper).attributes('aria-expanded')).toBe('false')

    await closedToggle(wrapper).trigger('click')

    expect(closedToggle(wrapper).attributes('aria-expanded')).toBe('true')
    expect(cardIds(wrapper, '[data-test=queue-closed]')).toEqual(['c1', 'c2', 'c3'])
    expect(wrapper.text()).toContain('改由爺爺來接')
    // 已結束卡唯讀：沒有任何操作按鈕
    expect(wrapper.findAll('[data-test=queue-closed] [data-test=queue-actions]')).toHaveLength(0)
    expect(wrapper.findAll('[data-test=queue-closed] .qcard__reveal')).toHaveLength(0)

    await closedToggle(wrapper).trigger('click')
    expect(wrapper.findAll('.qcard.phase-closed')).toHaveLength(0)
  })

  it('QueuePanel empty active copy', async () => {
    const onlyClosed = await mountPanel({ items: CLOSED })
    expect(onlyClosed.text()).toContain('進行中（0）')
    expect(onlyClosed.text()).toContain('目前沒有接送請求')
    expect(onlyClosed.text()).toContain('點中間的學生卡即可代建')
    expect(onlyClosed.text()).toContain('今日已結束（3）')

    const readOnly = await mountPanel({ items: CLOSED, canOperate: false })
    expect(readOnly.text()).toContain('目前沒有接送請求')
    expect(readOnly.text()).not.toContain('點中間的學生卡即可代建')

    const nothing = await mountPanel({ items: [] })
    expect(nothing.text()).toContain('目前沒有接送請求')
    expect(nothing.text()).not.toContain('今日已結束')

    const busy = await mountPanel({ items: [STAGING] })
    expect(busy.text()).not.toContain('目前沒有接送請求')
  })

  it('QueuePanel focus flashes target card', async () => {
    const wrapper = await mountPanel({ items: ALL })

    const found = await (wrapper.vm as unknown as PanelExposed).focus('r2')
    await nextTick()

    expect(found).toBe(true)
    expect(card(wrapper, 'r2').classes()).toContain('is-flash')
    expect(card(wrapper, 'r1').classes()).not.toContain('is-flash')
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(scroll.mock.contexts[0]).toBe(card(wrapper, 'r2').element)

    vi.advanceTimersByTime(1499)
    await nextTick()
    expect(card(wrapper, 'r2').classes()).toContain('is-flash')

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(card(wrapper, 'r2').classes()).not.toContain('is-flash')
  })

  it('QueuePanel focus again restarts the flash', async () => {
    const wrapper = await mountPanel({ items: ALL })
    const panel = wrapper.vm as unknown as PanelExposed

    await panel.focus('r2')
    vi.advanceTimersByTime(1000)
    await panel.focus('r2')
    await nextTick()
    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(card(wrapper, 'r2').classes()).toContain('is-flash')

    // 換別張卡：前一張立即不閃
    await panel.focus('r1')
    await nextTick()
    expect(card(wrapper, 'r1').classes()).toContain('is-flash')
    expect(card(wrapper, 'r2').classes()).not.toContain('is-flash')

    vi.advanceTimersByTime(1500)
    await nextTick()
    expect(wrapper.findAll('.qcard.is-flash')).toHaveLength(0)
  })

  it('QueuePanel focus expands closed section for a finished request and ignores unknown ids', async () => {
    const wrapper = await mountPanel({ items: ALL })
    const panel = wrapper.vm as unknown as PanelExposed

    expect(await panel.focus('c2')).toBe(true)
    await nextTick()
    expect(closedToggle(wrapper).attributes('aria-expanded')).toBe('true')
    expect(card(wrapper, 'c2').classes()).toContain('is-flash')

    expect(await panel.focus('nope')).toBe(false)
    await nextTick()
    expect(wrapper.findAll('.qcard.is-flash')).toHaveLength(0)
  })

  it('QueuePanel forwards card events', async () => {
    const wrapper = await mountPanel({ items: ALL })

    await buttonIn(wrapper, 'r2', '完成交付').trigger('click')
    await buttonIn(wrapper, 'r1', '確認').trigger('click')
    await buttonIn(wrapper, 'r1', '回覆時間').trigger('click')
    await buttonIn(wrapper, 'staging:s9', '取消').trigger('click')

    expect((wrapper.emitted('complete') as [PickupRequest][])[0]?.[0].id).toBe('r2')
    expect((wrapper.emitted('acknowledge') as [PickupRequest][])[0]?.[0].id).toBe('r1')
    expect((wrapper.emitted('reply') as [PickupRequest][])[0]?.[0].id).toBe('r1')
    expect((wrapper.emitted('cancel') as [PosQueueItem][])[0]?.[0].id).toBe('staging:s9')
  })

  it('QueuePanel shows swipe hint for operators only', async () => {
    const operator = await mountPanel({ items: [PENDING] })
    expect(operator.text()).toContain('左滑卡片可取消')
    expect(operator.text()).not.toContain('今日已結束')

    const readOnly = await mountPanel({ items: [PENDING], canOperate: false })
    expect(readOnly.text()).not.toContain('左滑卡片可取消')
    // 唯讀：卡片沒有操作按鈕
    expect(readOnly.findAll('[data-test=queue-actions]')).toHaveLength(0)

    // 只有倒數卡（不能左滑）時不提示
    const stagingOnly = await mountPanel({ items: [STAGING] })
    expect(stagingOnly.text()).not.toContain('左滑卡片可取消')
  })

  it('QueuePanel passes a live minute clock to cards', async () => {
    const wrapper = await mountPanel({ items: [ARRIVED] })
    expect(card(wrapper, 'r2').text()).toContain('已等 2 分')

    vi.advanceTimersByTime(60_000)
    await nextTick()

    expect(card(wrapper, 'r2').text()).toContain('已等 3 分')
  })

  it('QueuePanel loading shows skeletons and a dash count', async () => {
    const wrapper = await mountPanel({ items: ALL, loading: true })

    expect(wrapper.text()).toContain('進行中（—）')
    expect(wrapper.findAll('.el-skeleton')).toHaveLength(3)
    expect(wrapper.findAll('.qcard')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('目前沒有接送請求')
    expect(wrapper.text()).not.toContain('左滑卡片可取消')
    expect(wrapper.text()).not.toContain('今日已結束')

    await wrapper.setProps({ loading: false })
    await flushPromises()
    expect(wrapper.text()).toContain('進行中（3）')
    expect(wrapper.findAll('.el-skeleton')).toHaveLength(0)
  })

  it('QueuePanel styles follow the approved mockup', () => {
    // happy-dom 不算版面：以原始碼斷言稿的 decisions（整列 44px 收合鈕、列表進出場動畫與 reduced motion）
    expect(panelSource).toMatch(/<TransitionGroup[^>]*name="qlist"/)
    expect(panelSource).toMatch(/\.queue-panel__closed-toggle[^{]*\{[^}]*min-height:\s*44px/)
    expect(panelSource).toMatch(/\.queue-panel__closed-toggle[^{]*\{[^}]*width:\s*100%/)
    expect(panelSource).toMatch(/\.qlist-move\s*\{[^}]*transition/)
    expect(panelSource).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})
