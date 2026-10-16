import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PickupRequest } from '@/api/pickupRequests'
import type { PosQueueItem } from '@/composables/useDismissalPosQueue'
import { mountWithApp } from '@/test/helpers'
import cardSource from './QueueCard.vue?raw'
import QueueCard from './QueueCard.vue'

/** 台北 2026-10-02 17:10 */
const NOW = Date.parse('2026-10-02T09:10:00Z')
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()

function makeRequest(overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id: 'r1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 1, class_id: 'c1', class_name: '低年級A班' },
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

function activeItem(request: PickupRequest): PosQueueItem {
  const phase = ['pending', 'acknowledged', 'arrived'].includes(request.status) ? 'active' : 'closed'
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

function stagingItem(startedAt: number): PosQueueItem {
  return {
    id: 'staging:s1',
    phase: 'staging',
    studentId: 's1',
    studentName: '王小明',
    className: '低年級A班',
    countdown: { startedAt, durationMs: 5000 },
    request: null,
  }
}

async function mountCard(item: PosQueueItem, canOperate = true, now = NOW): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(QueueCard, { props: { item, now, canOperate } })
  return wrapper as VueWrapper
}

function actionButtons(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('[data-test=queue-actions] button')
}

function actionTexts(wrapper: VueWrapper): string[] {
  return actionButtons(wrapper).map((b) => b.text())
}

function mainButton(wrapper: VueWrapper): DOMWrapper<Element> {
  const btn = actionButtons(wrapper).find((b) => b.classes().includes('el-button--primary'))
  if (!btn) throw new Error('沒有主按鈕')
  return btn
}

function revealCancel(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('button').filter((b) => b.text() === '取消' && b.attributes('disabled') === undefined)
}

function pointer(clientX: number, pointerId = 1): Record<string, unknown> {
  return { clientX, clientY: 100, pointerId }
}

async function swipeLeft(wrapper: VueWrapper, distance: number): Promise<void> {
  const body = wrapper.find('.queue-card')
  await body.trigger('pointerdown', pointer(300))
  await body.trigger('pointermove', pointer(300 - distance))
  await body.trigger('pointerup', pointer(300 - distance))
}

describe('QueueCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('QueueCard pending shows reply and acknowledge actions', async () => {
    const wrapper = await mountCard(activeItem(makeRequest()))

    const text = wrapper.text()
    expect(text).toContain('王小明')
    expect(text).toContain('待回覆')
    expect(text).toContain('等待確認')
    expect(text).toContain('低年級A班・家長發起・王媽媽・16:40')
    expect(text).toContain('預計 17:30 到')
    expect(text).toContain('約 20 分後')
    expect(text).toContain('進行中')
    expect(text).toContain('作業預計 17:40 完成')
    expect(actionTexts(wrapper)).toEqual(['回覆時間', '確認'])
    expect(mainButton(wrapper).text()).toBe('回覆時間')
    expect(wrapper.attributes('id')).toBe('qc-r1')

    await actionButtons(wrapper)[0]?.trigger('click')
    expect((wrapper.emitted('reply') as [PickupRequest][])[0]?.[0].id).toBe('r1')
    await actionButtons(wrapper)[1]?.trigger('click')
    expect((wrapper.emitted('acknowledge') as [PickupRequest][])[0]?.[0].id).toBe('r1')

    // 已有回覆（不需回覆）時「確認」是主按鈕
    const replied = await mountCard(activeItem(makeRequest({ needs_reply: false, reply_message: '預計 17:45 可接送', reply_source: 'auto' })))
    expect(mainButton(replied).text()).toBe('確認')

    // acknowledged：「修改回覆」+「完成交付」（主）
    const acknowledged = await mountCard(activeItem(makeRequest({ status: 'acknowledged', needs_reply: false })))
    expect(actionTexts(acknowledged)).toEqual(['修改回覆', '完成交付'])
    expect(mainButton(acknowledged).text()).toBe('完成交付')
    expect(acknowledged.text()).toContain('已確認')
  })

  it('QueueCard arrived highlights urgency and complete', async () => {
    const wrapper = await mountCard(
      activeItem(makeRequest({ status: 'arrived', needs_reply: false, arrived_at: minutesAgo(9) })),
    )

    expect(wrapper.classes()).toContain('urgency-critical')
    expect(wrapper.text()).toContain('家長已到')
    expect(wrapper.text()).toContain('已等 9 分')
    expect(wrapper.text()).toContain('17:01 到達')
    expect(actionTexts(wrapper)).toEqual(['完成交付', '修改回覆'])
    expect(mainButton(wrapper).text()).toBe('完成交付')
    expect(mainButton(wrapper).classes()).toContain('is-main')

    await mainButton(wrapper).trigger('click')
    expect((wrapper.emitted('complete') as [PickupRequest][])[0]?.[0].id).toBe('r1')

    // 未滿 3 分：沒有急迫 class；3~7 分：warning
    const fresh = await mountCard(activeItem(makeRequest({ status: 'arrived', needs_reply: false, arrived_at: minutesAgo(1) })))
    expect(fresh.classes()).not.toContain('urgency-warning')
    expect(fresh.classes()).not.toContain('urgency-critical')
    const warning = await mountCard(activeItem(makeRequest({ status: 'arrived', needs_reply: false, arrived_at: minutesAgo(3) })))
    expect(warning.classes()).toContain('urgency-warning')

    // 唯讀者沒有任何操作按鈕
    const reader = await mountCard(activeItem(makeRequest({ status: 'arrived', needs_reply: false, arrived_at: minutesAgo(9) })), false)
    expect(reader.findAll('button')).toHaveLength(0)
    expect(reader.classes()).toContain('urgency-critical')
  })

  it('QueueCard shows reply source', async () => {
    const auto = await mountCard(
      activeItem(makeRequest({ reply_source: 'auto', reply_message: '預計 17:45 可接送', needs_reply: false })),
    )
    expect(auto.text()).toContain('系統自動回覆')
    expect(auto.text()).toContain('預計 17:45 可接送')
    expect(auto.text()).not.toContain('尚未回覆')

    const staff = await mountCard(
      activeItem(makeRequest({ reply_source: 'staff', replied_by_name: '陳老師', reply_message: '作業快寫完了', needs_reply: false })),
    )
    expect(staff.text()).toContain('陳老師 回覆')
    expect(staff.text()).not.toContain('系統自動回覆')

    const none = await mountCard(activeItem(makeRequest()))
    expect(none.text()).toContain('尚未回覆')
  })

  it('QueueCard swipe reveals cancel button', async () => {
    const wrapper = await mountCard(activeItem(makeRequest()))
    expect(revealCancel(wrapper)).toHaveLength(0)

    await swipeLeft(wrapper, 60)
    expect(revealCancel(wrapper)).toHaveLength(1)
    expect((wrapper.find('.queue-card').element as HTMLElement).style.transform).toBe('translateX(-84px)')

    await revealCancel(wrapper)[0]?.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect((wrapper.emitted('cancel') as [PosQueueItem][])[0]?.[0].id).toBe('r1')
    // 點了取消後收合
    expect(revealCancel(wrapper)).toHaveLength(0)
    expect((wrapper.find('.queue-card').element as HTMLElement).style.transform).toBe('translateX(0px)')

    // 未達門檻回彈
    const short = await mountCard(activeItem(makeRequest()))
    await swipeLeft(short, 20)
    expect(revealCancel(short)).toHaveLength(0)

    const reader = await mountCard(activeItem(makeRequest()), false)
    await swipeLeft(reader, 60)
    expect(reader.text()).not.toContain('取消')
    expect(reader.findAll('button')).toHaveLength(0)

    // pointercancel 維持鬆手前的開合狀態
    const cancelled = await mountCard(activeItem(makeRequest()))
    const body = cancelled.find('.queue-card')
    await body.trigger('pointerdown', pointer(300))
    await body.trigger('pointermove', pointer(240))
    await body.trigger('pointercancel', pointer(240))
    expect(revealCancel(cancelled)).toHaveLength(0)
  })

  it('QueueCard staging shows countdown and direct cancel', async () => {
    const wrapper = await mountCard(stagingItem(NOW - 2000))

    expect(wrapper.text()).toContain('王小明')
    expect(wrapper.text()).toContain('低年級A班・員工代建')
    expect(wrapper.text()).toContain('3 秒後送出')
    expect(wrapper.find('.countdown-bar').exists()).toBe(true)
    expect(wrapper.find('.queue-card').classes()).toContain('is-staging')
    expect(wrapper.classes()).toContain('phase-staging')

    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.text()).toContain('2 秒後送出')

    const cancel = wrapper.findAll('button').find((b) => b.text() === '取消')
    expect(cancel?.attributes('disabled')).toBeUndefined()
    await cancel?.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect((wrapper.emitted('cancel') as [PosQueueItem][])[0]?.[0].id).toBe('staging:s1')

    // 倒數卡不可左滑
    await swipeLeft(wrapper, 60)
    expect((wrapper.find('.queue-card').element as HTMLElement).style.transform).not.toBe('translateX(-84px)')
  })

  it('QueueCard closed completed summary', async () => {
    const wrapper = await mountCard(
      activeItem(
        makeRequest({
          status: 'completed',
          needs_reply: false,
          picked_up_by_name: '王大明',
          completion_method: 'guardian',
          completed_by_name: '陳老師',
          completed_at: '2026-10-02T09:20:00Z',
        }),
      ),
    )

    expect(wrapper.text()).toContain('已接走')
    expect(wrapper.text()).toContain('王大明 接走・監護人接送・陳老師・17:20')
    expect(wrapper.text()).toContain('低年級A班・家長發起')
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.classes()).toContain('phase-closed')

    await swipeLeft(wrapper, 60)
    expect(wrapper.findAll('button')).toHaveLength(0)

    const expired = await mountCard(activeItem(makeRequest({ status: 'expired', needs_reply: false })))
    expect(expired.text()).toContain('逾時未完成')
    expect(expired.text()).toContain('已逾時')
  })

  it('QueueCard renders request created directly as arrived', async () => {
    const wrapper = await mountCard(
      activeItem(
        makeRequest({
          status: 'arrived',
          expected_arrival_at: null,
          arrived_at: minutesAgo(4),
          source: 'parent',
          needs_reply: false,
          reply_source: null,
          current_ready_eta: null,
        }),
      ),
    )

    expect(wrapper.text()).toContain('家長已到')
    expect(wrapper.text()).toContain('已等 4 分')
    expect(wrapper.text()).not.toContain('預計')
    expect(wrapper.find('.queue-card__eta').exists()).toBe(false)

    // 有作業預計完成時間時，仍沒有「預計 … 到」那一行
    const withHomework = await mountCard(
      activeItem(makeRequest({ status: 'arrived', expected_arrival_at: null, arrived_at: minutesAgo(4), needs_reply: false })),
    )
    expect(withHomework.text()).not.toMatch(/預計 \d{2}:\d{2} 到/)
    expect(withHomework.text()).toContain('作業預計 17:40 完成')
    expect(withHomework.find('.queue-card__eta').exists()).toBe(false)
    expect(wrapper.classes()).toContain('urgency-warning')
    expect(mainButton(wrapper).text()).toBe('完成交付')
    expect(actionTexts(wrapper)).not.toContain('確認')
  })

  it('QueueCard uses POS wording for pending', async () => {
    const quiet = await mountCard(activeItem(makeRequest({ needs_reply: false })))
    expect(quiet.text()).toContain('等待確認')
    expect(quiet.text()).not.toContain('待回覆')
    expect(quiet.find('.el-tag--danger').exists()).toBe(false)

    const needs = await mountCard(activeItem(makeRequest({ needs_reply: true })))
    expect(needs.text()).toContain('待回覆')
    expect(needs.text()).toContain('等待確認')
    expect(needs.find('.el-tag--danger.el-tag--dark').text()).toBe('待回覆')
  })

  it('QueueCard closed cancelled summary', async () => {
    const withReason = await mountCard(
      activeItem(makeRequest({ status: 'cancelled', needs_reply: false, cancel_reason: '家長改明天', cancelled_at: '2026-10-02T09:00:00Z' })),
    )
    expect(withReason.text()).toContain('已取消・家長改明天')

    const noReason = await mountCard(
      activeItem(makeRequest({ status: 'cancelled', needs_reply: false, cancel_reason: null, cancelled_at: '2026-10-02T09:00:00Z' })),
    )
    expect(noReason.text()).toContain('已取消')
    expect(noReason.text()).not.toContain('已取消・')
  })

  it('QueueCard keeps touch targets and urgency styles', async () => {
    // happy-dom 不計算版面：以原始碼斷言按鈕 44px、取消鈕 84px 與急迫框線規則
    expect(cardSource).toMatch(/\.queue-card__actions[^{]*\.el-button\s*{[^}]*min-height:\s*44px/)
    expect(cardSource).toMatch(/\.qcard__cancel\s*{[^}]*width:\s*84px/)
    expect(cardSource).toMatch(/\.qcard\.urgency-critical\s+\.queue-card\s*{[^}]*var\(--el-color-danger-light-9\)/)
    expect(cardSource).toMatch(/\.qcard\.urgency-warning\s+\.queue-card\s*{[^}]*var\(--el-color-warning\)/)
  })
})
