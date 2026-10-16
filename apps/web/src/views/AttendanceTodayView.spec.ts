import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import type { AttendanceRow, DailyAttendance } from '@/api/attendance'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import AttendanceTodayView from './AttendanceTodayView.vue'

const DAILY_URL = '/admin/attendance/daily'
const BATCH_URL = '/admin/attendance/batch-check-in'
const OPERATOR = ['attendance:read', 'attendance:operate', 'attendance:amend']

const CLASSES = [
  {
    id: 'c1',
    name: '低年級A班',
    grade_levels: [1, 2],
    academic_year: 115,
    sort_order: 1,
    archived_at: null,
    student_count: 3,
    staff: [],
  },
  {
    id: 'c2',
    name: '中年級班',
    grade_levels: [3, 4],
    academic_year: 115,
    sort_order: 2,
    archived_at: null,
    student_count: 2,
    staff: [],
  },
]

function row(overrides: Partial<AttendanceRow>): AttendanceRow {
  return {
    id: 'a1',
    student_id: 's1',
    student_no: 'S11301',
    student_name: '王小明',
    grade_level: 2,
    class_id: 'c1',
    class_name: '低年級A班',
    service_date: '2026-10-02',
    status: 'expected',
    check_in_at: null,
    check_in_source: null,
    check_out_at: null,
    check_out_source: null,
    leave: null,
    note: null,
    updated_at: '2026-10-02T05:00:00Z',
    ...overrides,
  }
}

const WANG = row({})
const LIN = row({ id: 'a2', student_id: 's2', student_no: 'S11302', student_name: '林小華' })
const CHEN = row({ id: 'a3', student_id: 's3', student_no: 'S11303', student_name: '陳小美', status: 'absent' })
const LEE = row({
  id: 'a4',
  student_id: 's4',
  student_no: 'S11304',
  student_name: '李承恩',
  class_id: 'c2',
  class_name: '中年級班',
  status: 'present',
  check_in_at: '2026-10-02T07:10:00Z',
  check_in_source: 'manual',
})

function daily(items: AttendanceRow[], date = '2026-10-02', isServiceDay = true): DailyAttendance {
  const summary = { total: items.length, expected: 0, present: 0, left: 0, absent: 0, leave: 0 }
  for (const r of items) summary[r.status] += 1
  return { date, is_service_day: isServiceDay, summary, items }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountView(
  { permissions = OPERATOR, route = '/attendance', deniedTopics = [] as string[] } = {},
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const { wrapper, router } = await mountWithApp(AttendanceTodayView, {
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
      adminWs: { deniedTopics },
    },
  })
  await settle()
  return { wrapper: wrapper as VueWrapper, router }
}

function dailyGets() {
  return mock.history.get.filter((r) => r.url === DAILY_URL)
}

function cards(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.acard')
}

function cardNames(wrapper: VueWrapper): string[] {
  return cards(wrapper).map((c) => c.find('.acard__name').text())
}

function cardButtons(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.acard [data-test=att-actions] button').map((b) => b.text())
}

function button(wrapper: VueWrapper, text: string): DOMWrapper<HTMLButtonElement> | undefined {
  return wrapper.findAll<HTMLButtonElement>('button').find((b) => b.text().replace(/\s+/g, '') === text)
}

function chip(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const c = wrapper
    .findAll('.stat-card[role=button]')
    .find((x) => x.find('.stat-card__label').text() === label)
  if (!c) throw new Error(`找不到 chip ${label}`)
  return c
}

// 頁面含日期元件、兩個下拉與多張帶 el-dropdown 的卡片，happy-dom 下單一案例 3~6 秒，多 agent 並行時易超過預設 5 秒
describe('AttendanceTodayView', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 台北 2026-10-02 09:00
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'))
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/classes').reply(200, CLASSES)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('AttendanceTodayView loads today with class filter from query', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG, LIN, CHEN]))
    const { wrapper } = await mountView({ route: '/attendance?class_id=c1' })

    expect(dailyGets()).toHaveLength(1)
    expect(dailyGets()[0]?.params).toEqual({ date: '2026-10-02', class_id: 'c1' })
    expect(cards(wrapper)).toHaveLength(3)
    // 選了班級時不顯示班級分組標題
    expect(wrapper.find('.att__group-title').exists()).toBe(false)
    expect(wrapper.find('.att__class .el-select__placeholder').text()).toBe('低年級A班')
  })

  it('AttendanceTodayView loads today with class filter from query: all classes grouped and class change writes query', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG, LIN, CHEN, LEE]))
    const { wrapper, router } = await mountView()

    expect(dailyGets()[0]?.params).toEqual({ date: '2026-10-02' })
    expect(wrapper.findAll('.att__group-title').map((t) => t.text().replace(/\s+/g, ''))).toEqual([
      '低年級A班3位',
      '中年級班1位',
    ])

    const select = wrapper.find('.att__class')
    await select.find('.el-select__wrapper').trigger('click')
    await settle()
    const listId = select.find('input').attributes('aria-controls')
    const option = Array.from(
      document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [],
    ).find((o) => o.textContent?.trim() === '中年級班')
    option!.click()
    await settle()

    expect(router.currentRoute.value.query).toEqual({ class_id: 'c2' })
    expect(dailyGets().at(-1)?.params).toEqual({ date: '2026-10-02', class_id: 'c2' })
  })

  it('AttendanceTodayView filters by summary chip locally', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG, LIN, CHEN, LEE]))
    const { wrapper } = await mountView()
    const gets = dailyGets().length

    const absent = chip(wrapper, '缺席')
    expect(absent.find('.stat-card__value').text()).toBe('1')
    await absent.trigger('click')
    await settle()

    expect(cardNames(wrapper)).toEqual(['陳小美'])
    expect(dailyGets()).toHaveLength(gets)

    await chip(wrapper, '缺席').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toEqual(['王小明', '林小華', '陳小美', '李承恩'])
    expect(dailyGets()).toHaveLength(gets)
  })

  it('AttendanceTodayView filters by summary chip locally: search by name or number and no-match copy', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG, LIN, CHEN, LEE]))
    const { wrapper } = await mountView()

    await wrapper.find('.att__search input').setValue('林')
    await settle()
    expect(cardNames(wrapper)).toEqual(['林小華'])

    await wrapper.find('.att__search input').setValue('s11304')
    await settle()
    expect(cardNames(wrapper)).toEqual(['李承恩'])

    await wrapper.find('.att__search input').setValue('張')
    await settle()
    expect(cards(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('沒有符合條件的學生')
  })

  it('AttendanceTodayView batch check-in reports skipped students', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG, LIN, LEE]))
    mock.onPost(BATCH_URL).reply(200, {
      succeeded: [{ ...WANG, status: 'present', check_in_at: '2026-10-02T08:00:00Z', check_in_source: 'manual' }],
      skipped: [{ student_id: 's2', code: 'student_on_leave', message: '學生今日請假' }],
    })
    const { wrapper } = await mountView()

    await button(wrapper, '批次到班')!.trigger('click')
    await settle()
    expect(wrapper.text()).toContain('點選要到班的學生')
    expect(cardButtons(wrapper)).toEqual([])
    const selectAll = button(wrapper, '全選未到（2）')
    expect(selectAll).toBeDefined()
    await selectAll!.trigger('click')
    await settle()
    expect(wrapper.find('.batch-bar__count').text()).toBe('已選 2 位')
    await button(wrapper, '確認到班')!.trigger('click')
    await settle()

    const sent = JSON.parse(mock.history.post[0]?.data as string) as { student_ids: string[] }
    expect(sent.student_ids).toHaveLength(2)
    expect([...sent.student_ids].sort()).toEqual(['s1', 's2'])
    expect(document.body.textContent).toContain('已到班 1 位')
    expect(document.body.textContent).toContain('林小華：學生今日請假')
    // 結束選取模式
    expect(wrapper.find('.batch-bar').exists()).toBe(false)
  })

  it('AttendanceTodayView batch check-in reports skipped students: toggle cards and cancel', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG, LIN, LEE]))
    const { wrapper } = await mountView()

    await button(wrapper, '批次到班')!.trigger('click')
    await settle()
    expect(button(wrapper, '確認到班')!.element.disabled).toBe(true)
    await cards(wrapper)[0]!.trigger('click')
    await cards(wrapper)[2]!.trigger('click') // 已到班不可選
    await settle()
    expect(wrapper.find('.batch-bar__count').text()).toBe('已選 1 位')

    await button(wrapper, '取消')!.trigger('click')
    await settle()
    expect(wrapper.find('.batch-bar').exists()).toBe(false)
    expect(button(wrapper, '批次到班')).toBeDefined()
    expect(mock.history.post).toHaveLength(0)
  })

  it('AttendanceTodayView past date is amend-only', async () => {
    mock.onGet(DAILY_URL).reply((config) => {
      const date = (config.params as { date: string }).date
      return [200, daily([{ ...WANG, service_date: date }, { ...LEE, service_date: date }], date)]
    })
    const { wrapper } = await mountView()
    expect(cardButtons(wrapper)).toContain('到班')

    const input = wrapper.find('.att__date input')
    await input.trigger('focus')
    await input.setValue('2026-10-01')
    await input.trigger('change')
    await settle()

    expect(dailyGets().at(-1)?.params).toEqual({ date: '2026-10-01' })
    expect(wrapper.text()).toContain('檢視 2026-10-01，僅可改判')
    expect(button(wrapper, '批次到班')).toBeUndefined()
    expect(cardButtons(wrapper)).not.toContain('到班')
    expect(cardButtons(wrapper)).toEqual([])
    // 改判入口仍在
    expect(wrapper.findAll('.acard [aria-label=更多操作]').length).toBeGreaterThan(0)
  })

  it('AttendanceTodayView non service day empty state', async () => {
    vi.setSystemTime(new Date('2026-10-04T01:00:00Z'))
    mock.onGet(DAILY_URL).reply(200, daily([], '2026-10-04', false))
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('2026-10-04 不是營業日')
    expect(wrapper.find('.summary-bar').exists()).toBe(false)
  })

  it('AttendanceTodayView non service day empty state: rows still shown, empty roster copy', async () => {
    vi.setSystemTime(new Date('2026-10-04T01:00:00Z'))
    mock.onGet(DAILY_URL).replyOnce(200, daily([{ ...LEE, service_date: '2026-10-04' }], '2026-10-04', false))
    const { wrapper } = await mountView()
    expect(wrapper.text()).not.toContain('不是營業日')
    expect(cardNames(wrapper)).toEqual(['李承恩'])
    document.body.innerHTML = ''

    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'))
    mock.onGet(DAILY_URL).reply(200, daily([]))
    const empty = await mountView({ route: '/attendance?class_id=c1' })
    expect(empty.wrapper.text()).toContain('沒有出勤名單')
    expect(empty.wrapper.text()).toContain('低年級A班目前沒有在學學生')
  })

  it('AttendanceTodayView readonly without operate permission', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG, LIN, CHEN, LEE]))
    const { wrapper } = await mountView({ permissions: ['attendance:read'] })

    expect(cards(wrapper)).toHaveLength(4)
    expect(button(wrapper, '批次到班')).toBeUndefined()
    expect(cardButtons(wrapper)).toEqual([])
    expect(wrapper.find('.acard [aria-label=更多操作]').exists()).toBe(false)
  })

  it('AttendanceTodayView readonly without operate permission: live update denied and load failure', async () => {
    mock.onGet(DAILY_URL).replyOnce(500, { error: { code: 'internal_error', message: '伺服器錯誤', details: null } })
    mock.onGet(DAILY_URL).reply(200, daily([WANG]))
    const { wrapper } = await mountView({ deniedTopics: ['attendance'] })

    expect(wrapper.text()).toContain('沒有即時更新權限，請手動重新整理')
    expect(wrapper.text()).toContain('無法載入出勤資料')
    await button(wrapper, '重試')!.trigger('click')
    await settle()

    expect(wrapper.text()).not.toContain('無法載入出勤資料')
    expect(cardNames(wrapper)).toEqual(['王小明'])
  })

  it('AttendanceTodayView readonly without operate permission: operate buttons call api', async () => {
    mock.onGet(DAILY_URL).reply(200, daily([WANG]))
    mock
      .onPost('/admin/attendance/s1/check-in')
      .reply(200, { ...WANG, status: 'present', check_in_at: '2026-10-02T08:00:00Z', check_in_source: 'manual' })
    const { wrapper } = await mountView()

    await button(wrapper, '到班')!.trigger('click')
    await settle()

    expect(mock.history.post.map((r) => r.url)).toEqual(['/admin/attendance/s1/check-in'])
    expect(cards(wrapper)[0]!.find('.el-tag').text()).toBe('已到班')
    expect(cardButtons(wrapper)).toEqual(['離班'])
  })
})
