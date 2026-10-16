import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { MonthDay, MonthlyAttendance, MonthlyStats, MonthlyStudentRow } from '@/api/attendance'
import type { AttendanceStatus } from '@/shared/types/api'
import { mountWithApp } from '@/test/helpers'
import MonthlyAttendanceGrid from './MonthlyAttendanceGrid.vue'

const ZERO_STATS: MonthlyStats = { service_days: 0, attended: 0, absent: 0, leave: 0, unrecorded: 0 }

/** MonthDay.weekday：0 = 週一 */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

function day(date: string, isServiceDay = true): MonthDay {
  return { date, weekday: weekdayOf(date), is_service_day: isServiceDay }
}

/** 2026-10-01（四）、10-02（五）營業日，10-03（六）非營業日 */
const THREE_DAYS = [day('2026-10-01'), day('2026-10-02'), day('2026-10-03', false)]

function student(
  no: string,
  name: string,
  statuses: (AttendanceStatus | null)[],
  overrides: Partial<MonthlyStudentRow> = {},
): MonthlyStudentRow {
  return {
    student_id: `id-${no}`,
    student_no: no,
    name,
    class_name: '中年級班',
    statuses,
    stats: { ...ZERO_STATS },
    ...overrides,
  }
}

function monthly(days: MonthDay[], students: MonthlyStudentRow[], totals: Partial<MonthlyStats> = {}): MonthlyAttendance {
  return { month: '2026-10', class_id: null, class_name: null, days, students, totals: { ...ZERO_STATS, ...totals } }
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountGrid(data: MonthlyAttendance, props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(MonthlyAttendanceGrid, { props: { data, today: '2026-10-02', ...props } })
  await settle()
  return wrapper as VueWrapper
}

function bodyRows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.el-table__body-wrapper tr.el-table__row')
}

function row(wrapper: VueWrapper, index = 0): DOMWrapper<Element> {
  const r = bodyRows(wrapper)[index]
  if (!r) throw new Error(`沒有第 ${index + 1} 列`)
  return r
}

function dayCellTexts(r: DOMWrapper<Element>): string[] {
  return r.findAll('td.mg-day').map((td) => td.text())
}

function statTexts(r: DOMWrapper<Element>): string[] {
  return r.findAll('td.mg-stat-col').map((td) => td.text())
}

function headerTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-table__header-wrapper th').map((th) => th.text())
}

function dayHeader(wrapper: VueWrapper, dayNumber: string): DOMWrapper<Element> {
  const th = wrapper
    .findAll('.el-table__header-wrapper th.mg-day')
    .find((h) => h.find('.mg-day-head span').text() === dayNumber)
  if (!th) throw new Error(`找不到 ${dayNumber} 日的表頭`)
  return th
}

function header(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const th = wrapper.findAll('.el-table__header-wrapper th').find((h) => h.text() === label)
  if (!th) throw new Error(`找不到表頭 ${label}`)
  return th
}

function footerTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-table__footer-wrapper td').map((td) => td.text())
}

describe('MonthlyAttendanceGrid', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('MonthlyAttendanceGrid maps statuses to symbols', async () => {
    const wrapper = await mountGrid(monthly(THREE_DAYS, [student('S11301', '王小明', ['present', 'absent', null])]))

    expect(dayCellTexts(row(wrapper))).toEqual(['●', '✕', ''])
    const cells = row(wrapper).findAll('td.mg-day')
    expect(cells[2]?.classes()).toContain('is-closed')
    expect(cells[0]?.classes()).not.toContain('is-closed')
    expect(dayHeader(wrapper, '3').classes()).toContain('is-closed')
    expect(cells[0]?.find('.mg-mark').classes()).toContain('tone-success')
    expect(cells[1]?.find('.mg-mark').classes()).toContain('tone-danger')
  })

  it('MonthlyAttendanceGrid distinguishes unrecorded service day', async () => {
    const days = [day('2026-10-01'), day('2026-10-02'), day('2026-10-05'), day('2026-10-06'), day('2026-10-07')]
    const wrapper = await mountGrid(
      monthly(days, [student('S11301', '王小明', [null, 'expected', 'leave', 'left', null])]),
      { today: '2026-10-06' },
    )

    expect(dayCellTexts(row(wrapper))).toEqual(['—', '○', '假', '✓', '—'])
    const marks = row(wrapper).findAll('td.mg-day .mg-mark')
    expect(marks[0]?.classes()).toContain('is-none')
    expect(marks[2]?.classes()).toContain('is-leave')
    expect(marks.map((m) => m.attributes('title'))).toEqual([
      '10/01（四）王小明：無紀錄',
      '10/02（五）王小明：預計到班（未點名）',
      '10/05（一）王小明：請假',
      '10/06（二）王小明：已離班',
      '10/07（三）王小明：尚未到',
    ])
    expect(row(wrapper).findAll('td.mg-day')[4]?.classes()).toContain('is-future')
  })

  it('MonthlyAttendanceGrid highlights today column and stats', async () => {
    const wrapper = await mountGrid(
      monthly(THREE_DAYS, [
        student('S11301', '王小明', ['present', 'present', null], {
          stats: { service_days: 21, attended: 18, absent: 1, leave: 2, unrecorded: 0 },
        }),
        student('S11302', '陳小美', ['present', 'expected', null], {
          stats: { service_days: 21, attended: 0, absent: 0, leave: 0, unrecorded: 3 },
        }),
      ]),
      { today: '2026-10-02' },
    )

    expect(dayHeader(wrapper, '2').classes()).toContain('is-today')
    expect(dayHeader(wrapper, '1').classes()).not.toContain('is-today')
    expect(row(wrapper).findAll('td.mg-day')[1]?.classes()).toContain('is-today')
    expect(dayHeader(wrapper, '2').text()).toBe('2五')

    expect(statTexts(row(wrapper, 0))).toEqual(['18', '1', '2', '0'])
    const stats = row(wrapper, 0).findAll('td.mg-stat-col .mg-stat')
    expect(stats[1]?.classes()).toContain('tone-danger')
    expect(stats[3]?.classes()).toContain('is-zero')
    const second = row(wrapper, 1).findAll('td.mg-stat-col .mg-stat')
    expect(second[0]?.classes()).toContain('is-zero')
    expect(second[3]?.classes()).toContain('tone-warning')
  })

  it('MonthlyAttendanceGrid summary row counts attended per day', async () => {
    const wrapper = await mountGrid(
      monthly(
        THREE_DAYS,
        [
          student('S11301', '王小明', ['present', null, null]),
          student('S11302', '陳小美', ['left', 'present', null]),
          student('S11303', '張小芸', ['absent', 'expected', null]),
        ],
        { service_days: 360, attended: 330, absent: 10, leave: 12, unrecorded: 8 },
      ),
      { today: '2026-10-05' },
    )

    // 學號 / 姓名 / 班級 / 10-01 / 10-02 / 10-03 / 出席 / 缺席 / 請假 / 未登記
    const footer = footerTexts(wrapper)
    expect(footer[0]).toBe('合計')
    expect(footer[3]).toBe('2')
    expect(footer[4]).toBe('1')
    expect(footer[5]).toBe('')
    expect(footer.slice(6, 10)).toEqual(['330', '10', '12', '8'])
  })

  it('MonthlyAttendanceGrid sorts by stats columns', async () => {
    const withAbsent = (no: string, name: string, absent: number) =>
      student(no, name, ['present', 'present', null], { stats: { ...ZERO_STATS, absent } })
    const wrapper = await mountGrid(
      monthly(THREE_DAYS, [withAbsent('S11301', '王小明', 0), withAbsent('S11302', '陳小美', 3), withAbsent('S11303', '張小芸', 1)]),
    )
    const absentColumn = () => bodyRows(wrapper).map((r) => statTexts(r)[1])

    expect(absentColumn()).toEqual(['0', '3', '1'])
    await header(wrapper, '缺席').trigger('click')
    await settle()
    expect(absentColumn()).toEqual(['0', '1', '3'])
    await header(wrapper, '缺席').trigger('click')
    await settle()
    expect(absentColumn()).toEqual(['3', '1', '0'])
    await header(wrapper, '缺席').trigger('click')
    await settle()
    expect(absentColumn()).toEqual(['0', '3', '1'])

    // 非統計欄不排序
    await header(wrapper, '姓名').trigger('click')
    await settle()
    expect(absentColumn()).toEqual(['0', '3', '1'])
  })

  it('MonthlyAttendanceGrid hides class column when requested', async () => {
    const data = monthly(THREE_DAYS, [
      student('S11301', '王小明', ['present', 'present', null]),
      student('S11312', '王語晴', ['present', 'present', null], { class_name: null }),
    ])

    const hidden = await mountGrid(data, { hideClassColumn: true })
    expect(headerTexts(hidden)).not.toContain('班級')
    expect(headerTexts(hidden).slice(0, 2)).toEqual(['學號', '姓名'])

    const shown = await mountGrid(data, { hideClassColumn: false })
    expect(headerTexts(shown).slice(0, 3)).toEqual(['學號', '姓名', '班級'])
    expect(row(shown, 0).findAll('td')[2]?.text()).toBe('中年級班')
    expect(row(shown, 1).findAll('td')[2]?.text()).toBe('未分班')
  })

  it('MonthlyAttendanceGrid fixes columns and fills viewport height', async () => {
    // happy-dom 不計算版面：以結構與 inline style 斷言固定欄、合計列與「撐滿可視區」的 max-height
    const original = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.test === 'mg-table-wrap' ? ({ top: 200 } as DOMRect) : original.call(this)
    })
    const innerHeight = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900)

    const wrapper = await mountGrid(monthly(THREE_DAYS, [student('S11301', '王小明', ['present', 'present', null])]), {
      loading: true,
    })

    const fixedLeft = wrapper.findAll('.el-table__header-wrapper th.el-table-fixed-column--left').map((th) => th.text())
    const fixedRight = wrapper.findAll('.el-table__header-wrapper th.el-table-fixed-column--right').map((th) => th.text())
    expect(fixedLeft).toEqual(['學號', '姓名', '班級'])
    expect(fixedRight).toEqual(['出席', '缺席', '請假', '未登記'])
    expect(wrapper.find('.el-table__footer-wrapper').exists()).toBe(true)
    expect(wrapper.find('.el-loading-mask').exists()).toBe(true)

    const scrollWrap = () => wrapper.find<HTMLElement>('.el-table__body-wrapper .el-scrollbar__wrap').element
    // 900（視窗高）− 200（表格頂端）− 40（頁面底部留白）
    expect(scrollWrap().style.maxHeight).toBe('660px')

    innerHeight.mockReturnValue(1000)
    window.dispatchEvent(new Event('resize'))
    await settle()
    expect(scrollWrap().style.maxHeight).toBe('760px')

    expect(wrapper.find('.mg-legend').text()).toBe(
      '●已到班✓已離班✕缺席假請假○預計到班（未點名）—無紀錄 / 尚未到非營業日今天',
    )
  })
})
