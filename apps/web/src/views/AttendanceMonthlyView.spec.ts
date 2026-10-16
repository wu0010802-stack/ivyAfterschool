import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Router, RouteRecordRaw } from 'vue-router'
import type { MonthDay, MonthlyAttendance, MonthlyStats, MonthlyStudentRow } from '@/api/attendance'
import type { ClassItem } from '@/api/classes'
import { adminHttp } from '@/api/http'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { createApiMock, mountWithApp } from '@/test/helpers'
import AttendanceMonthlyView from './AttendanceMonthlyView.vue'

const MONTHLY_URL = '/admin/attendance/monthly'
const EXPORT_URL = '/admin/attendance/monthly/export'
const ZERO: MonthlyStats = { service_days: 0, attended: 0, absent: 0, leave: 0, unrecorded: 0 }

function klass(id: string, name: string): ClassItem {
  return {
    id,
    name,
    grade_levels: [1, 2],
    academic_year: 115,
    sort_order: 1,
    archived_at: null,
    student_count: 10,
    staff: [],
  }
}

const CLASSES = [klass('c1', '低年級A班'), klass('c2', '中年級班')]

/** 該月每一天；預設週一到週五為營業日，closed 列出的日期不營業 */
function monthDays(ym: string, closed: string[] = []): MonthDay[] {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return Array.from({ length: count }, (_, i) => {
    const date = `${ym}-${String(i + 1).padStart(2, '0')}`
    const weekday = (new Date(Date.UTC(y, m - 1, i + 1)).getUTCDay() + 6) % 7
    return { date, weekday, is_service_day: weekday < 5 && !closed.includes(date) }
  })
}

function student(no: string, name: string, days: MonthDay[], className: string | null = '低年級A班'): MonthlyStudentRow {
  return {
    student_id: `id-${no}`,
    student_no: no,
    name,
    class_name: className,
    statuses: days.map((d) => (d.is_service_day ? 'present' : null)),
    stats: { service_days: 20, attended: 20, absent: 0, leave: 0, unrecorded: 0 },
  }
}

function report(
  ym: string,
  days: MonthDay[],
  students: MonthlyStudentRow[],
  totals: Partial<MonthlyStats> = {},
  classId: string | null = null,
): MonthlyAttendance {
  return {
    month: ym,
    class_id: classId,
    class_name: classId ? (CLASSES.find((c) => c.id === classId)?.name ?? null) : null,
    days,
    students,
    totals: { ...ZERO, ...totals },
  }
}

const OCT_DAYS = monthDays('2026-10')
const SEP_DAYS = monthDays('2026-09', ['2026-09-28'])
const OCT_REPORT = report('2026-10', OCT_DAYS, [student('S11301', '王小明', OCT_DAYS), student('S11302', '陳小美', OCT_DAYS, '中年級班')])

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [{ path: '/attendance/monthly', component: Stub, meta: { title: '月出勤報表' } }]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountView(initialRoute = '/attendance/monthly'): Promise<{ wrapper: VueWrapper; router: Router }> {
  const mounted = await mountWithApp(AttendanceMonthlyView, {
    routes: ROUTES,
    initialRoute,
    piniaInitialState: {
      lookups: { classes: CLASSES, loaded: { classes: true, subjects: true, examTypes: true, schools: true } },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  return { wrapper: mounted.wrapper as VueWrapper, router: mounted.router }
}

function monthlyParams(): Record<string, unknown>[] {
  return mock.history.get.filter((c) => c.url === MONTHLY_URL).map((c) => c.params as Record<string, unknown>)
}

function exportButton(wrapper: VueWrapper): DOMWrapper<Element> {
  const btn = wrapper.findAll('button').find((b) => b.text().includes('匯出'))
  if (!btn) throw new Error('找不到匯出按鈕')
  return btn
}

async function chooseClass(wrapper: VueWrapper, label: string): Promise<void> {
  const filter = wrapper.find('[data-test=filter-class]')
  await filter.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = filter.find('input').attributes('aria-controls')
  const option = Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? []).find(
    (o) => o.textContent?.trim() === label,
  )
  if (!option) throw new Error(`找不到班級選項 ${label}`)
  option.click()
  await settle()
}

function recordDownloads(): string[] {
  const downloads: string[] = []
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:monthly')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download)
  })
  return downloads
}

// 31 欄的格狀表在共用容器高負載下單一案例可達 2~3 秒，放寬逾時避免假紅
describe('AttendanceMonthlyView', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T02:00:00Z'))
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('AttendanceMonthlyView loads current month by default', async () => {
    mock.onGet(MONTHLY_URL).reply((config) => {
      const classId = (config.params as { class_id?: string }).class_id ?? null
      return [200, { ...OCT_REPORT, class_id: classId }]
    })
    const { wrapper, router } = await mountView()

    expect(monthlyParams()).toEqual([{ month: '2026-10' }])
    expect(wrapper.find('h1').text()).toBe('月出勤報表')
    expect(wrapper.text()).toContain('每位學生每天的出勤狀態與本月統計')
    expect(wrapper.text()).toContain('共 2 位學生')
    expect(wrapper.findAll('.el-table__header-wrapper th').map((th) => th.text())).toContain('班級')

    await chooseClass(wrapper, '低年級A班')

    expect(monthlyParams().at(-1)).toEqual({ month: '2026-10', class_id: 'c1' })
    expect(router.currentRoute.value.query.class_id).toBe('c1')
    // 選了班級：格狀表不顯示班級欄
    expect(wrapper.findAll('.el-table__header-wrapper th').map((th) => th.text())).not.toContain('班級')

    await chooseClass(wrapper, '全部')
    expect(monthlyParams().at(-1)).toEqual({ month: '2026-10' })
    expect(router.currentRoute.value.query.class_id).toBeUndefined()
  })

  it('AttendanceMonthlyView renders totals', async () => {
    expect(SEP_DAYS.filter((d) => d.is_service_day)).toHaveLength(21)
    mock
      .onGet(MONTHLY_URL)
      .reply(200, report('2026-09', SEP_DAYS, [student('S11301', '王小明', SEP_DAYS)], {
        service_days: 420,
        attended: 398,
        absent: 6,
        leave: 12,
        unrecorded: 4,
      }))
    const { wrapper } = await mountView('/attendance/monthly?month=2026-09')

    expect(monthlyParams()).toEqual([{ month: '2026-09' }])
    const text = wrapper.text()
    expect(text).toContain('營業日 21')
    expect(text).toContain('應出勤 420')
    expect(text).toContain('出席 398')
    expect(text).toContain('缺席 6')
    expect(text).toContain('請假 12')
    expect(text).toContain('未登記 4')
    expect(text).not.toContain('已過')
    const summary = wrapper.find('[data-test=monthly-summary]')
    expect(summary.find('.tone-danger').text()).toBe('6')
    expect(summary.find('.tone-warning').text()).toBe('4')
  })

  it('AttendanceMonthlyView shows elapsed service days for current month', async () => {
    expect(OCT_DAYS.filter((d) => d.is_service_day)).toHaveLength(22)
    mock.onGet(MONTHLY_URL).reply(200, OCT_REPORT)
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('營業日 22 天')
    expect(wrapper.text()).toContain('統計到 10/02，已過 2 天')
  })

  it('AttendanceMonthlyView exports with server filename', async () => {
    const downloads = recordDownloads()
    mock.onGet(MONTHLY_URL).reply(200, report('2026-09', SEP_DAYS, [student('S11301', '王小明', SEP_DAYS)]))
    mock.onGet(EXPORT_URL).reply(200, new Blob(['xlsx']), {
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('出勤月報_全部_2026-09.xlsx')}`,
    })
    const { wrapper } = await mountView('/attendance/monthly?month=2026-09')

    expect(exportButton(wrapper).attributes('disabled')).toBeUndefined()
    await exportButton(wrapper).trigger('click')
    await settle()

    const call = mock.history.get.find((c) => c.url === EXPORT_URL)
    expect(call?.responseType).toBe('blob')
    expect(call?.params).toEqual({ month: '2026-09' })
    expect(downloads).toEqual(['出勤月報_全部_2026-09.xlsx'])
  })

  it('AttendanceMonthlyView falls back to class name in export filename', async () => {
    const downloads = recordDownloads()
    mock.onGet(MONTHLY_URL).reply(200, report('2026-10', OCT_DAYS, [student('S11301', '王小明', OCT_DAYS)], {}, 'c1'))
    mock.onGet(EXPORT_URL).reply(200, new Blob(['xlsx']))
    const { wrapper } = await mountView('/attendance/monthly?class_id=c1')

    expect(monthlyParams()).toEqual([{ month: '2026-10', class_id: 'c1' }])
    await exportButton(wrapper).trigger('click')
    await settle()

    expect(mock.history.get.find((c) => c.url === EXPORT_URL)?.params).toEqual({ month: '2026-10', class_id: 'c1' })
    expect(downloads).toEqual(['出勤月報_低年級A班_2026-10.xlsx'])
  })

  it('AttendanceMonthlyView shows export error message', async () => {
    mock.onGet(MONTHLY_URL).reply(200, OCT_REPORT)
    mock
      .onGet(EXPORT_URL)
      .reply(404, new Blob(['{"error":{"code":"class_not_found","message":"找不到班級"}}'], { type: 'application/json' }))
    const { wrapper } = await mountView()

    await exportButton(wrapper).trigger('click')
    await settle()

    expect(document.body.textContent).toContain('找不到班級')
    expect(exportButton(wrapper).text()).toBe('匯出 Excel')
    expect(exportButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('AttendanceMonthlyView empty state', async () => {
    mock.onGet(MONTHLY_URL).reply(200, report('2026-10', OCT_DAYS, []))
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('此月份沒有出勤資料')
    expect(wrapper.text()).toContain('全部班級在 2026 年 10 月沒有學生與出勤紀錄')
    expect(wrapper.find('[data-test=monthly-summary]').exists()).toBe(false)
    expect(wrapper.find('.el-table').exists()).toBe(false)
    expect(exportButton(wrapper).attributes('disabled')).toBeDefined()
  })

  it('AttendanceMonthlyView falls back to current month for invalid query', async () => {
    mock.onGet(MONTHLY_URL).reply(200, OCT_REPORT)
    await mountView('/attendance/monthly?month=2027-01')
    await mountView('/attendance/monthly?month=2026-13')

    expect(monthlyParams()).toEqual([{ month: '2026-10' }, { month: '2026-10' }])
  })

  it('AttendanceMonthlyView keeps table while refetching and retries after failure', async () => {
    let release: () => void = () => undefined
    mock
      .onGet(MONTHLY_URL)
      .replyOnce(200, OCT_REPORT)
      .onGet(MONTHLY_URL)
      .replyOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return [500, { error: { code: 'internal_error', message: '伺服器忙碌中' } }]
      })
      .onGet(MONTHLY_URL)
      .replyOnce(200, OCT_REPORT)
    const { wrapper } = await mountView()

    await chooseClass(wrapper, '中年級班')
    // 重抓中：保留舊表格並蓋 loading，匯出停用
    expect(wrapper.find('.el-table').exists()).toBe(true)
    expect(wrapper.find('.el-loading-mask').exists()).toBe(true)
    expect(exportButton(wrapper).attributes('disabled')).toBeDefined()

    release()
    await settle()
    expect(wrapper.text()).toContain('無法載入出勤月報')
    expect(wrapper.text()).toContain('伺服器忙碌中')
    expect(exportButton(wrapper).attributes('disabled')).toBeDefined()

    const retry = wrapper.findAll('button').find((b) => b.text() === '重試')
    await retry?.trigger('click')
    await settle()
    expect(monthlyParams()).toHaveLength(3)
    expect(wrapper.text()).not.toContain('無法載入出勤月報')
    expect(wrapper.find('.el-table').exists()).toBe(true)
  })

  it('AttendanceMonthlyView uses latest response when filters change', async () => {
    const gates: Record<string, () => void> = {}
    mock.onGet(MONTHLY_URL).reply(async (config) => {
      const classId = (config.params as { class_id?: string }).class_id ?? 'all'
      if (classId !== 'all') {
        await new Promise<void>((resolve) => {
          gates[classId] = resolve
        })
      }
      const name = classId === 'c1' ? '王小明' : classId === 'c2' ? '陳小美' : '林小華'
      return [200, report('2026-10', OCT_DAYS, [student('S11301', name, OCT_DAYS)], {}, classId === 'all' ? null : classId)]
    })
    const { wrapper } = await mountView()

    await chooseClass(wrapper, '低年級A班')
    await chooseClass(wrapper, '中年級班')
    gates.c2?.()
    await settle()
    gates.c1?.()
    await settle()

    expect(monthlyParams().map((p) => p.class_id)).toEqual([undefined, 'c1', 'c2'])
    expect(wrapper.find('.el-table__body').text()).toContain('陳小美')
    expect(wrapper.find('.el-table__body').text()).not.toContain('王小明')
  })

  it('AttendanceMonthlyView is wired into view loaders', async () => {
    const loaded = (await VIEW_LOADERS.AttendanceMonthlyView()) as { default?: unknown }

    expect(loaded.default).toBe(AttendanceMonthlyView)
  })
})
