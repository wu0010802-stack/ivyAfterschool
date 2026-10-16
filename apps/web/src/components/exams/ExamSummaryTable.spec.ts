import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { ExamSummary, SubjectSummary } from '@/api/exams'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import ExamSummaryTable from './ExamSummaryTable.vue'

const SUMMARY_URL = '/admin/exams/e1/summary'

const MATH: SubjectSummary = {
  subject_id: 'sub2',
  subject_name: '數學',
  full_score: 100,
  scored_count: 16,
  absent_count: 1,
  missing_count: 1,
  average: 82.444,
  max: 100,
  min: 45,
}

function summary(subjects: SubjectSummary[], rosterCount = 18): ExamSummary {
  return { exam_id: 'e1', roster_count: rosterCount, subjects }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountTable(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(ExamSummaryTable, { props: { examId: 'e1', refreshKey: 0, ...props } })
  await settle()
  return wrapper as VueWrapper
}

function headers(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-table__header th').map((th) => th.text())
}

function rowCells(wrapper: VueWrapper, subjectName: string): DOMWrapper<Element>[] {
  const row = wrapper.findAll('.el-table__body tr').find((r) => r.findAll('td')[0]?.text() === subjectName)
  if (!row) throw new Error(`找不到科目列 ${subjectName}`)
  return row.findAll('td')
}

function summaryRequests(): number {
  return mock.history.get.filter((c) => c.url === SUMMARY_URL).length
}

describe('ExamSummaryTable', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
  })

  it('ExamSummaryTable renders statistics', async () => {
    mock.onGet(SUMMARY_URL).reply(200, summary([MATH]))
    const wrapper = await mountTable()

    expect(summaryRequests()).toBe(1)
    expect(wrapper.text()).toContain('應考 18 人')
    expect(wrapper.text()).toContain('平均只計有分數的學生，缺考與未填不計入；不做排名')
    expect(headers(wrapper)).toEqual(['科目', '滿分', '平均', '最高', '最低', '已填', '缺考', '未填'])
    const cells = rowCells(wrapper, '數學')
    expect(cells.map((c) => c.text())).toEqual(['數學', '100', '82.4得分率 82%', '100', '45', '16', '1', '1'])
    expect(cells[2]?.text()).toContain('82.4')
    expect(cells[2]?.text()).toContain('82%')
    expect(cells[7]?.find('.is-warning').exists()).toBe(true)
    expect(cells[5]?.find('.is-warning').exists()).toBe(false)
  })

  it('ExamSummaryTable shows dash for null averages', async () => {
    mock.onGet(SUMMARY_URL).reply(
      200,
      summary([
        {
          ...MATH,
          subject_id: 'sub3',
          subject_name: '英語',
          full_score: 50,
          average: null,
          max: null,
          min: null,
          scored_count: 0,
          absent_count: 0,
          missing_count: 0,
        },
        { ...MATH, average: 59.95, max: 88.5, min: 59.95, scored_count: 2, absent_count: 0, missing_count: 16 },
      ]),
    )
    const wrapper = await mountTable()

    const english = rowCells(wrapper, '英語').map((c) => c.text())
    expect(english).toEqual(['英語', '50', '—', '—', '—', '0', '0', '0'])
    expect(rowCells(wrapper, '英語')[2]?.text()).not.toContain('%')
    expect(rowCells(wrapper, '英語')[7]?.find('.is-warning').exists()).toBe(false)
    // 平均一位小數、最高最低原樣、得分率整數百分比
    const math = rowCells(wrapper, '數學').map((c) => c.text())
    expect(math).toEqual(['數學', '100', '60.0得分率 60%', '88.5', '59.95', '2', '0', '16'])
  })

  it('ExamSummaryTable reloads on refresh key', async () => {
    mock.onGet(SUMMARY_URL).replyOnce(200, summary([MATH])).onGet(SUMMARY_URL).reply(200, summary([], 0))
    const wrapper = await mountTable()
    expect(summaryRequests()).toBe(1)
    expect(wrapper.text()).toContain('數學')

    await wrapper.setProps({ refreshKey: 1 })
    await settle()

    expect(summaryRequests()).toBe(2)
    expect(wrapper.text()).toContain('應考 0 人')
    expect(wrapper.text()).toContain('尚未設定科目')
    expect(wrapper.find('.el-table').exists()).toBe(false)
  })

  it('ExamSummaryTable error and retry', async () => {
    mock
      .onGet(SUMMARY_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器錯誤', details: null } })
      .onGet(SUMMARY_URL)
      .reply(200, summary([MATH]))
    const wrapper = await mountTable()

    expect(wrapper.text()).toContain('無法載入各科平均')
    expect(wrapper.find('.el-table').exists()).toBe(false)
    const retry = wrapper.findAll('button').find((b) => b.text() === '重試')
    expect(retry).toBeDefined()
    await retry!.trigger('click')
    await settle()

    expect(summaryRequests()).toBe(2)
    expect(wrapper.text()).not.toContain('無法載入各科平均')
    expect(wrapper.text()).toContain('應考 18 人')
    expect(rowCells(wrapper, '數學')[2]?.text()).toContain('82.4')
  })
})
