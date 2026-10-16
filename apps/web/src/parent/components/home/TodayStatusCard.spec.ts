import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { TodayPickup, TodayState } from '../../composables/useTodayStatus'
import TodayStatusCard from './TodayStatusCard.vue'

type Attendance = TodayState['attendance']
type Homework = TodayState['homework']

function today(overrides: Partial<TodayState> = {}): TodayState {
  return {
    student_id: 's1',
    date: '2026-10-02',
    is_service_day: true,
    attendance: { status: 'present', check_in_at: '2026-10-02T07:40:00Z', check_out_at: null },
    on_leave: false,
    leave: null,
    homework: { item_count: 3, done_count: 1, overall_status: 'in_progress', ready_eta: '17:30', note: '數學訂正中' },
    pickup_request: null,
    ...overrides,
  }
}

function pickup(overrides: Partial<TodayPickup> = {}): TodayPickup {
  return {
    id: 'r1',
    status: 'pending',
    expected_arrival_at: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    completed_at: null,
    picked_up_by_name: null,
    can_cancel: true,
    can_mark_arrived: true,
    ...overrides,
  }
}

const NO_HOMEWORK: Homework = { item_count: 0, done_count: 0, overall_status: 'not_started', ready_eta: null, note: null }
const HW_DONE: Homework = { item_count: 3, done_count: 3, overall_status: 'done', ready_eta: '17:30', note: null }
const LEFT: Attendance = { status: 'left', check_in_at: '2026-10-02T07:40:00Z', check_out_at: '2026-10-02T09:20:00Z' }

let mounted: VueWrapper[] = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
})

function mountCard(value: TodayState | null): VueWrapper {
  const wrapper = mount(TodayStatusCard, { props: { today: value } })
  mounted.push(wrapper)
  return wrapper
}

function buttonOf(w: VueWrapper, label: string): Omit<DOMWrapper<HTMLButtonElement>, 'exists'> | undefined {
  return w.findAll<HTMLButtonElement>('button').find((b) => b.text().includes(label))
}

function pills(w: VueWrapper): string[] {
  return w.findAll('.status-pill').map((p) => p.text())
}

/** 某區塊（依區塊 class）內的膠囊 */
function pillIn(w: VueWrapper, selector: string): DOMWrapper<Element> | undefined {
  return w.find(selector).findAll('.status-pill')[0]
}

describe('TodayStatusCard', () => {
  it('TodayStatusCard shows attendance and homework progress', () => {
    const w = mountCard(today())

    const text = w.text()
    expect(text).toContain('已到班')
    expect(text).toContain('15:40 到班')
    expect(text).toContain('作業進度 1/3')
    expect(text).toContain('預計 17:30 可接送')
    expect(text).toContain('老師說明：數學訂正中')
    expect(pillIn(w, '.tsc-att')?.classes()).toContain('status-pill--success')
    expect(pillIn(w, '.tsc-hw')?.text()).toBe('進行中')
    // 進度條是裝飾，數字已在標題
    const bar = w.get('.tsc-bar')
    expect(bar.attributes('aria-hidden')).toBe('true')
    expect(bar.get('.tsc-bar__fill').attributes('style')).toContain('width: 33%')
  })

  it('TodayStatusCard is a labelled region without the child name', () => {
    const w = mountCard(today())

    expect(w.attributes('role')).toBe('region')
    expect(w.attributes('aria-label')).toBe('今日狀態')
    expect(w.classes()).toContain('m3-card--elevated')
  })

  it('TodayStatusCard keeps the teacher note exactly as written', () => {
    const w = mountCard(today({ homework: { item_count: 3, done_count: 1, overall_status: 'in_progress', ready_eta: null, note: '數學訂正中\n國語圈詞' } }))

    // 說明以 pre-wrap 保留換行：模板的縮排空白不能混進文字
    expect(w.get('.tsc-note').element.textContent).toBe('老師說明：數學訂正中\n國語圈詞')
  })

  it('TodayStatusCard homework done message', () => {
    const w = mountCard(today({ homework: HW_DONE }))

    expect(w.text()).toContain('作業已完成，可以來接送了')
    expect(w.text()).not.toContain('預計')
    expect(pillIn(w, '.tsc-hw')?.text()).toBe('已完成')
    expect(w.get('.tsc-bar__fill').attributes('style')).toContain('width: 100%')
  })

  it('TodayStatusCard empty homework', () => {
    const w = mountCard(today({ homework: NO_HOMEWORK }))

    expect(w.text()).toContain('今天尚無作業項目')
    expect(w.text()).toContain('老師尚未提供預計時間')
    // 0 項時標題只寫「作業」、不畫進度條
    expect(w.get('.tsc-hw .tsc-row__label').text()).toBe('作業')
    expect(w.find('.tsc-bar').exists()).toBe(false)
    expect(w.text()).not.toContain('老師說明')
  })

  it('TodayStatusCard homework marked done with no items shows only the done state', () => {
    const w = mountCard(today({ homework: { item_count: 0, done_count: 0, overall_status: 'done', ready_eta: null, note: '今天沒有回家作業' } }))

    expect(w.text()).not.toContain('今天尚無作業項目')
    expect(pillIn(w, '.tsc-hw')?.text()).toBe('已完成')
    expect(w.text()).toContain('作業已完成，可以來接送了')
    expect(w.text()).toContain('老師說明：今天沒有回家作業')
  })

  it('TodayStatusCard homework block emits open-homework', async () => {
    const w = mountCard(today())

    const block = w.get('button.tsc-hw')
    expect(block.attributes('type')).toBe('button')
    expect(block.text()).toContain('chevron_right')
    await block.trigger('click')

    expect(w.emitted('open-homework')).toHaveLength(1)
    expect(w.emitted('request-pickup')).toBeUndefined()
  })

  it('TodayStatusCard pickup button emits request', async () => {
    const w = mountCard(today())

    const button = buttonOf(w, '我要來接')
    expect(button?.attributes('disabled')).toBeUndefined()
    await button?.trigger('click')

    expect(w.emitted('request-pickup')).toHaveLength(1)
    expect(w.emitted('arrive-now')).toBeUndefined()
  })

  it('TodayStatusCard arrive now entry without request', async () => {
    const w = mountCard(today())

    const arrive = buttonOf(w, '我已經到了')
    expect(arrive).toBeDefined()
    await arrive?.trigger('click')
    expect(w.emitted('arrive-now')).toHaveLength(1)
    expect(w.emitted('request-pickup')).toBeUndefined()
    mounted.pop()?.unmount()

    const onLeave = mountCard(
      today({ on_leave: true, leave: { id: 'l1', leave_type: 'sick', leave_type_label: '病假', start_date: '2026-10-02', end_date: '2026-10-02' } }),
    )
    expect(buttonOf(onLeave, '我已經到了')?.attributes('disabled')).toBeDefined()
  })

  it('TodayStatusCard disables pickup on leave', () => {
    const w = mountCard(
      today({
        attendance: { status: 'leave', check_in_at: null, check_out_at: null },
        on_leave: true,
        leave: { id: 'l1', leave_type: 'sick', leave_type_label: '病假', start_date: '2026-10-02', end_date: '2026-10-03' },
        homework: NO_HOMEWORK,
      }),
    )

    expect(w.text()).toContain('今日請假（病假）')
    expect(w.text()).toContain('請假期間 10/02（五）～10/03（六）')
    expect(buttonOf(w, '我要來接')?.attributes('disabled')).toBeDefined()
    expect(buttonOf(w, '我已經到了')?.attributes('disabled')).toBeDefined()
    expect(w.get('.tsc-reason').text()).toContain('今日請假，今天無法使用接送')
    mounted.pop()?.unmount()

    const left = mountCard(today({ attendance: LEFT, homework: HW_DONE }))
    expect(buttonOf(left, '我要來接')?.attributes('disabled')).toBeDefined()
    expect(left.text()).toContain('已離班')
    expect(left.text()).toContain('17:20 離班')
    expect(left.get('.tsc-reason').text()).toContain('已離班，今天無法使用接送')
  })

  it('TodayStatusCard disables pickup when absent', () => {
    const w = mountCard(today({ attendance: { status: 'absent', check_in_at: null, check_out_at: null }, homework: NO_HOMEWORK }))

    expect(pillIn(w, '.tsc-att')?.text()).toBe('缺席')
    expect(pillIn(w, '.tsc-att')?.classes()).toContain('status-pill--danger')
    expect(w.text()).toContain('今日缺席')
    expect(w.get('.tsc-reason').text()).toContain('今日缺席，今天無法使用接送')
    expect(buttonOf(w, '我要來接')?.attributes('disabled')).toBeDefined()
    expect(buttonOf(w, '我已經到了')?.attributes('disabled')).toBeDefined()
  })

  it('TodayStatusCard single day leave shows one date', () => {
    const w = mountCard(
      today({ on_leave: true, leave: { id: 'l1', leave_type: 'personal', leave_type_label: '事假', start_date: '2026-10-02', end_date: '2026-10-02' } }),
    )

    expect(w.text()).toContain('請假期間 10/02（五）')
    expect(w.text()).not.toContain('～')
  })

  it('TodayStatusCard on_leave overrides expected status', () => {
    const w = mountCard(
      today({
        attendance: { status: 'expected', check_in_at: null, check_out_at: null },
        on_leave: true,
        leave: { id: 'l1', leave_type: 'personal', leave_type_label: '事假', start_date: '2026-10-02', end_date: '2026-10-02' },
      }),
    )

    expect(pillIn(w, '.tsc-att')?.text()).toBe('請假')
    expect(w.text()).toContain('今日請假（事假）')
    expect(w.text()).not.toContain('尚未到班')
    expect(buttonOf(w, '我要來接')?.attributes('disabled')).toBeDefined()
    expect(buttonOf(w, '我已經到了')?.attributes('disabled')).toBeDefined()
  })

  it('TodayStatusCard expected and missing attendance keep pickup available', () => {
    const expected = mountCard(today({ attendance: { status: 'expected', check_in_at: null, check_out_at: null } }))
    expect(pillIn(expected, '.tsc-att')?.text()).toBe('預計到班')
    expect(expected.text()).toContain('尚未到班')
    expect(buttonOf(expected, '我要來接')?.attributes('disabled')).toBeUndefined()
    expect(expected.find('.tsc-reason').exists()).toBe(false)
    mounted.pop()?.unmount()

    const none = mountCard(today({ attendance: { status: null, check_in_at: null, check_out_at: null } }))
    expect(none.find('.tsc-att .status-pill').exists()).toBe(false)
    expect(none.text()).toContain('尚無出勤紀錄')
    expect(buttonOf(none, '我已經到了')?.attributes('disabled')).toBeUndefined()
  })

  it('TodayStatusCard shows open request reply', async () => {
    const w = mountCard(
      today({ pickup_request: pickup({ reply_ready_eta: '17:30', reply_message: '預計 17:30 可接送', reply_source: 'auto' }) }),
    )

    expect(buttonOf(w, '我要來接')).toBeUndefined()
    expect(buttonOf(w, '我已經到了')).toBeUndefined()
    expect(w.get('.tsc-reply').text()).toContain('預計 17:30 可接送')
    expect(w.text()).toContain('系統自動回覆')
    expect(pillIn(w, '.tsc-pickup')?.text()).toBe('待回覆')
    const view = buttonOf(w, '查看接送')
    expect(view).toBeDefined()
    await view?.trigger('click')

    expect(w.emitted('open-pickup')).toHaveLength(1)
  })

  it('TodayStatusCard shows staff reply for acknowledged request', () => {
    const w = mountCard(
      today({ homework: HW_DONE, pickup_request: pickup({ status: 'acknowledged', reply_message: '作業寫完了，正在收書包', reply_source: 'staff' }) }),
    )

    expect(pillIn(w, '.tsc-pickup')?.text()).toBe('已確認')
    expect(w.get('.tsc-reply').text()).toContain('作業寫完了，正在收書包')
    expect(w.text()).toContain('老師回覆')
  })

  it('TodayStatusCard arrived button for open request', async () => {
    const w = mountCard(today({ pickup_request: pickup({ status: 'acknowledged', can_mark_arrived: true }) }))

    const arrived = buttonOf(w, '我到了')
    expect(arrived).toBeDefined()
    expect(buttonOf(w, '查看接送')?.classes()).toContain('m3-button--outlined')
    await arrived?.trigger('click')
    expect(w.emitted('arrive-now')).toHaveLength(1)
    mounted.pop()?.unmount()

    const done = mountCard(today({ pickup_request: pickup({ status: 'arrived', can_mark_arrived: false }) }))
    expect(buttonOf(done, '我到了')).toBeUndefined()
    expect(buttonOf(done, '我已經到了')).toBeUndefined()
    expect(pillIn(done, '.tsc-pickup')?.text()).toBe('家長已到')
    expect(done.findAll('.tsc-actions button')).toHaveLength(1)
    expect(buttonOf(done, '查看接送')?.classes()).toContain('m3-button--tonal')
  })

  it('TodayStatusCard completed shows picker on first load', () => {
    const w = mountCard(
      today({
        attendance: LEFT,
        homework: HW_DONE,
        pickup_request: pickup({ status: 'completed', completed_at: '2026-10-02T09:40:00Z', picked_up_by_name: '王媽媽', can_cancel: false, can_mark_arrived: false }),
      }),
    )

    expect(w.text()).toContain('17:40 已由 王媽媽 接走')
    expect(pillIn(w, '.tsc-pickup')?.text()).toBe('已接走')
    expect(buttonOf(w, '查看接送')).toBeUndefined()
    expect(buttonOf(w, '我要來接')).toBeUndefined()
    // 已接走後不再提示「已離班」停用原因
    expect(w.find('.tsc-reason').exists()).toBe(false)
    mounted.pop()?.unmount()

    const noName = mountCard(
      today({ attendance: LEFT, homework: HW_DONE, pickup_request: pickup({ status: 'completed', completed_at: '2026-10-02T09:40:00Z', picked_up_by_name: null, can_mark_arrived: false }) }),
    )
    expect(noName.text()).toContain('今天已接走')
    expect(noName.text()).not.toContain('已由')
    mounted.pop()?.unmount()

    const noTime = mountCard(
      today({ attendance: LEFT, homework: HW_DONE, pickup_request: pickup({ status: 'completed', completed_at: null, picked_up_by_name: '王媽媽', can_mark_arrived: false }) }),
    )
    expect(noTime.text()).toContain('今天已接走')
  })

  it('TodayStatusCard cancelled or expired request falls back to the request buttons', async () => {
    for (const status of ['cancelled', 'expired'] as const) {
      const w = mountCard(today({ pickup_request: pickup({ status, can_cancel: false, can_mark_arrived: false }) }))
      expect(buttonOf(w, '我要來接')?.attributes('disabled')).toBeUndefined()
      expect(buttonOf(w, '我已經到了')).toBeDefined()
      expect(buttonOf(w, '查看接送')).toBeUndefined()
      expect(w.find('.tsc-pickup .status-pill').exists()).toBe(false)
      await buttonOf(w, '我要來接')?.trigger('click')
      expect(w.emitted('request-pickup')).toHaveLength(1)
      mounted.pop()?.unmount()
    }
  })

  it('TodayStatusCard closed day', () => {
    const w = mountCard(today({ is_service_day: false, attendance: { status: null, check_in_at: null, check_out_at: null } }))

    expect(w.text()).toBe('今天安親班休息')
    expect(w.findAll('button')).toHaveLength(0)
    expect(pills(w)).toEqual([])
  })

  it('TodayStatusCard shows a placeholder when today is null', () => {
    const w = mountCard(null)

    expect(w.text()).toBe('尚未取得今日狀態')
    expect(w.findAll('button')).toHaveLength(0)
  })

  it('TodayStatusCard updates in place when today changes', async () => {
    const w = mountCard(today())
    expect(buttonOf(w, '我要來接')).toBeDefined()

    await w.setProps({ today: today({ pickup_request: pickup({ status: 'pending' }) }) })

    expect(buttonOf(w, '我要來接')).toBeUndefined()
    expect(buttonOf(w, '查看接送')).toBeDefined()
  })
})
