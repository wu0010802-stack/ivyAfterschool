import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { AttendanceDay, MonthlyAttendance } from '../api/attendance'
import type { ChildSummary } from '../api/children'
import { parentHttp } from '../api/http'
import PullToRefresh from '../components/PullToRefresh.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'
import AttendanceView from './AttendanceView.vue'
import viewSource from './AttendanceView.vue?raw'

// 系統時間固定 2026-10-02 09:00 台北（UTC 01:00）
const NOW = new Date('2026-10-02T01:00:00Z')
const TODAY = '2026-10-02'

const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級 A 班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

/** in_stats 預設依後端規則：營業日且不晚於今天 */
function day(date: string, overrides: Partial<AttendanceDay> = {}): AttendanceDay {
  const isServiceDay = overrides.is_service_day ?? true
  return {
    date,
    is_service_day: isServiceDay,
    in_stats: isServiceDay && date <= TODAY,
    status: null,
    check_in_at: null,
    check_out_at: null,
    leave_type: null,
    ...overrides,
  }
}

const DEFAULT_STATS: MonthlyAttendance['stats'] = { service_days: 21, attended: 1, leave: 0, absent: 0, unrecorded: 0 }

function monthData(
  month: string,
  days: AttendanceDay[],
  stats: Partial<MonthlyAttendance['stats']> = {},
  studentId = 's1',
): MonthlyAttendance {
  return { student_id: studentId, month, days, stats: { ...DEFAULT_STATS, ...stats } }
}

const PRESENT_TODAY = day(TODAY, {
  status: 'present',
  check_in_at: '2026-10-02T07:40:00Z',
  check_out_at: '2026-10-02T09:50:00Z',
})

const url = (childId: string) => `/parent/children/${childId}/attendance`

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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  mock = createApiMock(parentHttp)
})

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted = null
  mock.restore()
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

async function mountView(
  selectedId: string | null = 's1',
  state: { items?: ChildSummary[]; loaded?: boolean } = {},
): Promise<MountedApp> {
  mounted = await mountWithApp(AttendanceView, {
    piniaInitialState: {
      parentChildren: { items: state.items ?? KIDS, loaded: state.loaded ?? true, selectedId },
    },
  })
  return mounted
}

type Wrapper = MountedApp['wrapper']

function cell(w: Wrapper, dayNumber: number) {
  const found = w.findAll('.att-cal__grid button.att-day').find((b) => b.get('.att-day__num').text() === String(dayNumber))
  if (!found) throw new Error(`找不到 ${dayNumber} 日的格子`)
  return found
}

const detail = (w: Wrapper) => w.get('.att-detail')
const monthTitle = (w: Wrapper) => w.get('.att-month__title').text()
const statTexts = (w: Wrapper) => w.findAll('.att-stat').map((s) => `${s.get('dt').text()} ${s.get('dd').text()}`)

function button(w: Wrapper, label: string) {
  const found = w.findAll('button').find((b) => b.text().includes(label))
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

const iconButton = (w: Wrapper, label: string) => w.get(`button[aria-label="${label}"]`)

function requestParams(index: number): unknown {
  return mock.history.get[index]?.params
}

describe('AttendanceView', () => {
  it('AttendanceView loads current month with stats and today detail', async () => {
    mock.onGet(url('s1'), { params: { month: '2026-10' } }).reply(200, monthData('2026-10', [PRESENT_TODAY]))

    const { wrapper } = await mountView()

    expect(mock.history.get).toHaveLength(1)
    expect(mock.history.get[0]!.url).toBe('/parent/children/s1/attendance')
    expect(requestParams(0)).toEqual({ month: '2026-10' })
    expect(monthTitle(wrapper)).toBe('2026 年 10 月')
    expect(statTexts(wrapper)).toEqual(['上課日 21', '出席 1', '請假 0', '缺席 0', '未登記 0'])
    expect(wrapper.text()).toContain('上課日')
    // 本月預設選中今天：明細顯示今天的到班、離班時間（台北時間）
    const d = detail(wrapper)
    expect(d.text()).toContain('10/02（五）')
    expect(d.text()).toContain('今天')
    expect(d.get('.status-pill').text()).toBe('已到班')
    expect(d.text()).toContain('到班 15:40')
    expect(d.text()).toContain('離班 17:50')
    expect(cell(wrapper, 2).classes()).toEqual(expect.arrayContaining(['is-today', 'is-selected']))
    expect(wrapper.findAll('.att-cal__grid button.att-day')).toHaveLength(31)
    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(wrapper.text()).toContain('申請請假')
  })

  it('AttendanceView month navigation', async () => {
    mock.onGet(url('s1'), { params: { month: '2026-10' } }).reply(200, monthData('2026-10', [PRESENT_TODAY]))
    mock.onGet(url('s1'), { params: { month: '2026-09' } }).reply(200, monthData('2026-09', [], { service_days: 20 }))
    const { wrapper } = await mountView()
    // 顯示本月：「›」與「本月」停用但仍在畫面上
    expect(iconButton(wrapper, '下個月').attributes('disabled')).toBeDefined()
    expect(button(wrapper, '本月').attributes('disabled')).toBeDefined()
    expect(iconButton(wrapper, '上個月').attributes('disabled')).toBeUndefined()

    await iconButton(wrapper, '上個月').trigger('click')
    await flushPromises()

    expect(mock.history.get).toHaveLength(2)
    expect(requestParams(1)).toEqual({ month: '2026-09' })
    expect(monthTitle(wrapper)).toBe('2026 年 9 月')
    expect(statTexts(wrapper)[0]).toBe('上課日 20')
    expect(iconButton(wrapper, '下個月').attributes('disabled')).toBeUndefined()
    expect(button(wrapper, '本月').attributes('disabled')).toBeUndefined()
    // 9 月往後一個月 = 本月
    await iconButton(wrapper, '下個月').trigger('click')
    await flushPromises()
    expect(requestParams(2)).toEqual({ month: '2026-10' })
    expect(monthTitle(wrapper)).toBe('2026 年 10 月')

    await iconButton(wrapper, '上個月').trigger('click')
    await flushPromises()
    expect(monthTitle(wrapper)).toBe('2026 年 9 月')
    await button(wrapper, '本月').trigger('click')
    await flushPromises()

    expect(mock.history.get).toHaveLength(5)
    expect(requestParams(4)).toEqual({ month: '2026-10' })
    expect(monthTitle(wrapper)).toBe('2026 年 10 月')
    // 回到本月後又預設選中今天
    expect(cell(wrapper, 2).classes()).toContain('is-selected')
    expect(iconButton(wrapper, '下個月').attributes('disabled')).toBeDefined()
  })

  it('AttendanceView month title announces changes and the row is a labelled group', async () => {
    mock.onGet(url('s1')).reply(200, monthData('2026-10', [PRESENT_TODAY]))

    const { wrapper } = await mountView()

    expect(wrapper.get('.att-month').attributes('role')).toBe('group')
    expect(wrapper.get('.att-month').attributes('aria-label')).toBe('切換月份')
    expect(wrapper.get('.att-month__title').attributes('aria-live')).toBe('polite')
    expect(wrapper.get('.att-month__title').element.tagName).toBe('H2')
    expect(detail(wrapper).attributes('aria-live')).toBe('polite')
  })

  it('AttendanceView child switch uses new id and drops stale', async () => {
    const s1 = deferredReply()
    mock.onGet(url('s1')).reply(s1.reply)
    mock.onGet(url('s2')).reply(200, monthData('2026-10', [PRESENT_TODAY], { service_days: 5, attended: 2 }, 's2'))
    const { wrapper } = await mountView('s1')
    expect(mock.history.get).toHaveLength(1)
    expect(wrapper.find('.skeleton').exists()).toBe(true)

    useChildrenStore().select('s2')
    await flushPromises()

    expect(mock.history.get).toHaveLength(2)
    expect(mock.history.get[1]!.url).toBe('/parent/children/s2/attendance')
    expect(requestParams(1)).toEqual(requestParams(0))
    expect(statTexts(wrapper)).toEqual(['上課日 5', '出席 2', '請假 0', '缺席 0', '未登記 0'])
    // 換小孩保留目前月份與選中日
    expect(monthTitle(wrapper)).toBe('2026 年 10 月')
    expect(cell(wrapper, 2).classes()).toContain('is-selected')

    // s1 晚到的回應不覆蓋畫面
    s1.resolve([200, monthData('2026-10', [PRESENT_TODAY], { service_days: 21, attended: 9 })])
    await flushPromises()

    expect(statTexts(wrapper)).toEqual(['上課日 5', '出席 2', '請假 0', '缺席 0', '未登記 0'])
  })

  it('AttendanceView child switch from the header shows the skeleton and keeps the selected day', async () => {
    mock.onGet(url('s1')).reply(200, monthData('2026-10', [PRESENT_TODAY]))
    const s2 = deferredReply()
    mock.onGet(url('s2')).reply(s2.reply)
    const { wrapper } = await mountView('s1')
    await cell(wrapper, 1).trigger('click')
    expect(detail(wrapper).text()).toContain('10/01（四）')

    await wrapper.get('.cch').trigger('click')
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('.cch-option'))
    options[1]!.click()
    await flushPromises()

    expect(useChildrenStore().selectedId).toBe('s2')
    // 載入中：三塊換成骨架，不保留上一位小孩的資料；月份列仍在
    expect(wrapper.find('.skeleton--card').exists()).toBe(true)
    expect(wrapper.find('.att-stat').exists()).toBe(false)
    expect(wrapper.find('.att-cal__grid').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('申請請假')
    expect(monthTitle(wrapper)).toBe('2026 年 10 月')
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)

    s2.resolve([200, monthData('2026-10', [day('2026-10-01', { status: 'absent' })], {}, 's2')])
    await flushPromises()

    expect(detail(wrapper).text()).toContain('10/01（四）')
    expect(detail(wrapper).text()).toContain('這天沒有到班，也沒有請假紀錄')
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(false)
  })

  it('AttendanceView day detail states', async () => {
    mock.onGet(url('s1')).reply(200, monthData('2026-10', [PRESENT_TODAY, day('2026-10-04', { is_service_day: false })]))
    const { wrapper } = await mountView()

    await cell(wrapper, 4).trigger('click')
    expect(detail(wrapper).text()).toContain('10/04（日）')
    expect(detail(wrapper).text()).toContain('安親班休息')
    expect(detail(wrapper).find('.status-pill').exists()).toBe(false)
    expect(detail(wrapper).text()).not.toContain('今天')
    expect(cell(wrapper, 4).attributes('aria-pressed')).toBe('true')
    expect(cell(wrapper, 2).attributes('aria-pressed')).toBe('false')

    await cell(wrapper, 20).trigger('click')
    expect(detail(wrapper).text()).toContain('10/20（二）')
    expect(detail(wrapper).text()).toContain('這天沒有出勤紀錄')
    expect(detail(wrapper).find('.status-pill').exists()).toBe(false)
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(1)
  })

  it('AttendanceView load error retry', async () => {
    mock.onGet(url('s1')).replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('出勤紀錄載入失敗')
    expect(wrapper.get('.empty-state').attributes('role')).toBe('alert')
    expect(wrapper.find('.att-stat').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('申請請假')
    // 月份列照常可操作
    expect(monthTitle(wrapper)).toBe('2026 年 10 月')
    expect(iconButton(wrapper, '上個月').attributes('disabled')).toBeUndefined()

    mock.onGet(url('s1')).reply(200, monthData('2026-10', [PRESENT_TODAY]))
    await button(wrapper, '重試').trigger('click')
    expect(wrapper.find('.skeleton--card').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('出勤紀錄載入失敗')
    await flushPromises()

    expect(mock.history.get).toHaveLength(2)
    expect(wrapper.text()).not.toContain('出勤紀錄載入失敗')
    expect(statTexts(wrapper)[0]).toBe('上課日 21')
  })

  it('AttendanceView error state still lets the month row load another month', async () => {
    mock.onGet(url('s1'), { params: { month: '2026-10' } }).reply(500, SERVER_ERROR)
    mock.onGet(url('s1'), { params: { month: '2026-09' } }).reply(200, monthData('2026-09', [], { service_days: 20 }))
    const { wrapper } = await mountView()
    expect(wrapper.text()).toContain('出勤紀錄載入失敗')

    await iconButton(wrapper, '上個月').trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('出勤紀錄載入失敗')
    expect(monthTitle(wrapper)).toBe('2026 年 9 月')
    expect(statTexts(wrapper)[0]).toBe('上課日 20')
  })

  it('AttendanceView stats note', async () => {
    mock.onGet(url('s1'), { params: { month: '2026-10' } }).replyOnce(200, monthData('2026-10', [day(TODAY, { status: 'expected' })]))
    const pending = await mountView()
    expect(pending.wrapper.get('.att-stats__note').text()).toBe('統計到今天（10/02）為止；今天還沒到班，先算在「未登記」')
    pending.wrapper.unmount()
    mounted = null

    mock.onGet(url('s1'), { params: { month: '2026-10' } }).reply(200, monthData('2026-10', [PRESENT_TODAY]))
    mock.onGet(url('s1'), { params: { month: '2026-09' } }).reply(200, monthData('2026-09', [], { service_days: 20 }))
    mock.onGet(url('s1'), { params: { month: '2026-08' } }).reply(200, monthData('2026-08', [], { service_days: 0, attended: 0 }))
    const { wrapper } = await mountView()
    expect(wrapper.get('.att-stats__note').text()).toBe('統計到今天（10/02）為止')
    expect(wrapper.text()).not.toContain('先算在')

    await iconButton(wrapper, '上個月').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('統計到今天')
    expect(wrapper.find('.att-stats__note').exists()).toBe(false)

    await iconButton(wrapper, '上個月').trigger('click')
    await flushPromises()
    expect(monthTitle(wrapper)).toBe('2026 年 8 月')
    expect(wrapper.get('.att-stats__note').text()).toBe('這個月沒有出勤紀錄')
    expect(statTexts(wrapper)[0]).toBe('上課日 0')
  })

  it('AttendanceView stats note treats a counted day without a record as pending', async () => {
    mock.onGet(url('s1')).replyOnce(200, monthData('2026-10', [day(TODAY, { status: null, in_stats: true })]))
    const first = await mountView()
    expect(first.wrapper.get('.att-stats__note').text()).toContain('今天還沒到班，先算在「未登記」')
    first.wrapper.unmount()
    mounted = null

    // 今天不是營業日：不說明「還沒到班」
    mock.onGet(url('s1')).replyOnce(200, monthData('2026-10', [day(TODAY, { is_service_day: false })]))
    const closed = await mountView()
    expect(closed.wrapper.get('.att-stats__note').text()).toBe('統計到今天（10/02）為止')
  })

  it('AttendanceView day detail texts', async () => {
    mock.onGet(url('s1'), { params: { month: '2026-10' } }).reply(
      200,
      monthData('2026-10', [
        day('2026-10-01', { status: 'expected' }),
        day(TODAY, { status: 'absent' }),
        day('2026-10-06', { status: 'leave', leave_type: 'personal' }),
        day('2026-10-07', { status: 'leave', leave_type: 'sick' }),
        day('2026-10-08', { status: 'leave', leave_type: 'other' }),
      ]),
    )
    mock.onGet(url('s1'), { params: { month: '2026-09' } }).reply(200, monthData('2026-09', [], { service_days: 20 }))
    const { wrapper } = await mountView()

    // 今天缺席（預設選中）
    expect(detail(wrapper).get('.status-pill').text()).toBe('缺席')
    expect(detail(wrapper).text()).toContain('這天沒有到班，也沒有請假紀錄')

    await cell(wrapper, 1).trigger('click')
    expect(detail(wrapper).get('.status-pill').text()).toBe('未登記')
    expect(detail(wrapper).text()).toContain('老師沒有登記這天的到班情形')
    expect(detail(wrapper).text()).not.toContain('今天')

    await cell(wrapper, 6).trigger('click')
    expect(detail(wrapper).get('.status-pill').text()).toBe('請假')
    expect(detail(wrapper).text()).toContain('假別 事假')
    await cell(wrapper, 7).trigger('click')
    expect(detail(wrapper).text()).toContain('假別 病假')
    await cell(wrapper, 8).trigger('click')
    expect(detail(wrapper).text()).toContain('假別 其他')

    await iconButton(wrapper, '上個月').trigger('click')
    await flushPromises()
    expect(detail(wrapper).text()).toContain('未選擇日期')
    expect(detail(wrapper).text()).toContain('點月曆上的日期，查看當天的到班、離班時間')
    expect(wrapper.findAll('[aria-pressed="true"]')).toHaveLength(0)
  })

  it('AttendanceView day detail shows times for left and expected today', async () => {
    mock.onGet(url('s1')).replyOnce(
      200,
      monthData('2026-10', [
        day('2026-10-01', { status: 'left', check_in_at: '2026-10-01T07:31:00Z', check_out_at: '2026-10-01T10:05:00Z' }),
        day(TODAY, { status: 'expected' }),
      ]),
    )
    const { wrapper } = await mountView()

    expect(detail(wrapper).get('.status-pill').text()).toBe('預計到班')
    expect(detail(wrapper).text()).toContain('到班 —')
    expect(detail(wrapper).text()).toContain('離班 —')

    await cell(wrapper, 1).trigger('click')
    expect(detail(wrapper).get('.status-pill').text()).toBe('已離班')
    expect(detail(wrapper).text()).toContain('到班 15:31')
    expect(detail(wrapper).text()).toContain('離班 18:05')
  })

  it('AttendanceView pull refresh failure keeps data', async () => {
    mock.onGet(url('s1')).replyOnce(200, monthData('2026-10', [PRESENT_TODAY]))
    const { wrapper } = await mountView()
    expect(statTexts(wrapper)[0]).toBe('上課日 21')
    mock.onGet(url('s1')).reply(500, SERVER_ERROR)

    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(wrapper.text()).toContain('上課日')
    expect(statTexts(wrapper)[0]).toBe('上課日 21')
    expect(wrapper.findAll('.att-cal__grid button.att-day')).toHaveLength(31)
    expect(wrapper.text()).not.toContain('出勤紀錄載入失敗')
    expect(useSnackbarStore().items.map((i) => [i.message, i.tone])).toEqual([['更新失敗，請稍後再試', 'error']])
  })

  it('AttendanceView pull refresh keeps content while reloading and then replaces it', async () => {
    mock.onGet(url('s1')).replyOnce(200, monthData('2026-10', [PRESENT_TODAY]))
    const { wrapper } = await mountView()
    const refreshed = deferredReply()
    mock.onGet(url('s1')).replyOnce(refreshed.reply)

    const pending = wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()
    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(statTexts(wrapper)[0]).toBe('上課日 21')

    refreshed.resolve([200, monthData('2026-10', [PRESENT_TODAY], { service_days: 22, attended: 3 })])
    await pending
    await flushPromises()

    expect(statTexts(wrapper)).toEqual(['上課日 22', '出席 3', '請假 0', '缺席 0', '未登記 0'])
    expect(mock.history.get).toHaveLength(2)
    expect(requestParams(1)).toEqual({ month: '2026-10' })
    expect(useSnackbarStore().items).toHaveLength(0)
  })

  it('AttendanceView counted day without record shows unrecorded', async () => {
    mock.onGet(url('s1')).reply(
      200,
      monthData('2026-10', [
        day('2026-10-01', { is_service_day: true, in_stats: true, status: null }),
        PRESENT_TODAY,
        day('2026-10-23', { is_service_day: true, in_stats: false, status: null }),
      ]),
    )
    const { wrapper } = await mountView()

    await cell(wrapper, 1).trigger('click')
    expect(detail(wrapper).get('.status-pill').text()).toBe('未登記')
    expect(detail(wrapper).text()).toContain('老師沒有登記這天的到班情形')
    expect(cell(wrapper, 1).classes()).toContain('att-day--unrecorded')

    await cell(wrapper, 23).trigger('click')
    expect(detail(wrapper).text()).toContain('這天沒有出勤紀錄')
    expect(detail(wrapper).find('.status-pill').exists()).toBe(false)
  })

  it('AttendanceView shows card skeletons while loading and disables pull to refresh', async () => {
    const first = deferredReply()
    mock.onGet(url('s1')).reply(first.reply)

    const { wrapper } = await mountView()

    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(monthTitle(wrapper)).toBe('2026 年 10 月')
    expect(wrapper.findAll('.skeleton--card')).toHaveLength(2)
    expect(wrapper.findAll('.skeleton-card')).toHaveLength(3)
    expect(wrapper.find('.att-stat').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('申請請假')
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)

    first.resolve([200, monthData('2026-10', [PRESENT_TODAY])])
    await flushPromises()

    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(false)
  })

  it('AttendanceView apply leave button navigates to leaves', async () => {
    mock.onGet(url('s1')).reply(200, monthData('2026-10', [PRESENT_TODAY]))
    const { wrapper, router } = await mountView()

    await button(wrapper, '申請請假').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/leaves')
  })

  it('AttendanceView waits for the child list before requesting', async () => {
    const kids = deferredReply()
    mock.onGet('/parent/children').reply(kids.reply)
    mock.onGet(url('s1')).reply(200, monthData('2026-10', [PRESENT_TODAY]))

    const { wrapper } = await mountView(null, { items: [], loaded: false })

    // 小孩清單還沒回來：不打出勤 API，顯示骨架
    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children'])
    expect(wrapper.find('.skeleton--card').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('出勤紀錄載入失敗')

    kids.resolve([200, KIDS])
    await flushPromises()

    expect(useChildrenStore().selectedId).toBe('s1')
    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children', '/parent/children/s1/attendance'])
    expect(statTexts(wrapper)[0]).toBe('上課日 21')
  })

  it('AttendanceView calendar card padding', async () => {
    mock.onGet(url('s1'), { params: { month: '2026-10' } }).reply(200, monthData('2026-10', [PRESENT_TODAY]))

    const { wrapper } = await mountView()

    // PARENT-207：月曆卡內距上下 12px、左右 8px（M3Card padding none + 頁面自訂內距）
    const calendarCard = wrapper.get('.att-cal').element.closest('.m3-card')
    expect(calendarCard?.classList.contains('m3-card--pad-none')).toBe(true)
    expect(calendarCard?.classList.contains('att-cal-card')).toBe(true)
    expect(viewSource).toMatch(/\.att-cal-card \{[^}]*padding: 12px 8px;/)
  })
})
