import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { Leave } from '@/api/leaves'
import LeaveFormDialog from '@/components/leaves/LeaveFormDialog.vue'
import { createApiMock, mountWithApp } from '@/test/helpers'
import LeavesView from './LeavesView.vue'

const LIST_URL = '/admin/leaves'
const WRITER = ['leaves:read', 'leaves:write', 'students:read']

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
]

function leave(overrides: Partial<Leave>): Leave {
  return {
    id: 'l1',
    student: { id: 's1', student_no: 'S1001', name: '王小明', class_name: '低年級A班' },
    leave_type: 'sick',
    leave_type_label: '病假',
    start_date: '2026-10-05',
    end_date: '2026-10-06',
    reason: '發燒',
    status: 'active',
    created_by_type: 'parent',
    created_by_name: '王大明',
    created_at: '2026-10-01T23:45:00Z',
    cancelled_at: null,
    cancelled_by_type: null,
    cancelled_by_name: null,
    attachments: [],
    ...overrides,
  }
}

function page(items: Leave[], total = items.length) {
  return { items, total, page: 1, page_size: 20 }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountView(
  permissions: string[] = WRITER,
  initialRoute = '/leaves',
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const { wrapper, router } = await mountWithApp(LeavesView, {
    initialRoute,
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'director01',
          display_name: '張主任',
          role: { id: 'r-director', code: 'director', name: '主任' },
          permissions,
          must_change_password: false,
        },
      },
    },
  })
  await settle()
  return { wrapper: wrapper as VueWrapper, router }
}

function listParams(): Record<string, unknown>[] {
  return mock.history.get.filter((r) => r.url === LIST_URL).map((r) => r.params as Record<string, unknown>)
}

function headers(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-table__header th').map((th) => th.text().trim())
}

function bodyButtons(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-table__body button').map((b) => b.text().replace(/\s+/g, ''))
}

function button(wrapper: VueWrapper, text: string): DOMWrapper<HTMLButtonElement> | undefined {
  return wrapper.findAll<HTMLButtonElement>('button').find((b) => b.text().replace(/\s+/g, '') === text)
}

function rowOf(wrapper: VueWrapper, studentName: string): DOMWrapper<Element> {
  const row = wrapper.findAll('.el-table__body tr.el-table__row').find((r) => r.text().includes(studentName))
  if (!row) throw new Error(`找不到 ${studentName} 的列`)
  return row
}

function filterItem(wrapper: VueWrapper, label: string): DOMWrapper<Element> | undefined {
  return wrapper
    .findAll('.list-toolbar__filter')
    .find((f) => f.find('.list-toolbar__filter-label').text() === label)
}

// 頁面含表格、日期區間與多個下拉，happy-dom 下單一案例約 2~5 秒，多 agent 並行時易超過預設 5 秒
describe('LeavesView', { timeout: 20_000 }, () => {
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

  it('LeavesView loads active leaves for next 30 days', async () => {
    mock.onGet(LIST_URL).reply(200, page([leave({})]))
    const { wrapper } = await mountView()

    expect(listParams()[0]).toEqual({
      status: 'active',
      date_from: '2026-10-02',
      date_to: '2026-11-01',
      page: 1,
      page_size: 20,
    })
    expect(wrapper.find('.page-header__title').text()).toBe('請假')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe('家長在 LINE 送出即生效；員工可代登記與取消')
    expect(wrapper.find('.list-toolbar__count').text()).toBe('共 1 筆')
    expect(button(wrapper, '重設')!.element.disabled).toBe(true)
  })

  it('LeavesView loads active leaves for next 30 days: clearing dates and resetting', async () => {
    mock.onGet(LIST_URL).reply(200, page([]))
    const { wrapper, router } = await mountView()

    const picker = wrapper.findComponent({ name: 'ElDatePicker' })
    picker.vm.$emit('update:modelValue', null)
    await settle()

    expect(listParams().at(-1)).toEqual({ status: 'active', page: 1, page_size: 20 })
    expect(router.currentRoute.value.query).toMatchObject({ date_from: 'all', date_to: 'all', page: '1' })
    expect(wrapper.text()).toContain('沒有符合條件的請假紀錄')
    expect(button(wrapper, '重設')!.element.disabled).toBe(false)

    await button(wrapper, '重設')!.trigger('click')
    await settle()
    expect(listParams().at(-1)).toEqual({
      status: 'active',
      date_from: '2026-10-02',
      date_to: '2026-11-01',
      page: 1,
      page_size: 20,
    })
    expect(button(wrapper, '重設')!.element.disabled).toBe(true)
  })

  it('LeavesView renders creator and in-progress tag', async () => {
    mock.onGet(LIST_URL).reply(
      200,
      page([
        leave({
          student: { id: 's1', name: '王小明', student_no: 'S1001', class_name: null },
          leave_type: 'sick',
          leave_type_label: '病假',
          start_date: '2026-10-01',
          end_date: '2026-10-03',
          created_by_type: 'parent',
          created_by_name: '王大明',
          status: 'active',
        }),
      ]),
    )
    const { wrapper } = await mountView()

    const text = wrapper.find('.el-table__body').text()
    expect(text).toContain('病假')
    expect(text).toContain('2026-10-01~2026-10-03')
    expect(text).toContain('進行中')
    expect(text).toContain('家長：王大明')
    expect(text).toContain('2026/10/02 07:45')
    expect(text).toContain('S1001・未分班')
    expect(headers(wrapper)).not.toContain('狀態')
    expect(headers(wrapper)).not.toContain('班級')
  })

  it('LeavesView renders creator and in-progress tag: single day, reason fallback and student link', async () => {
    mock.onGet(LIST_URL).reply(
      200,
      page([leave({ start_date: '2026-10-05', end_date: '2026-10-05', reason: null, created_by_type: 'staff', created_by_name: '林行政' })]),
    )
    const { wrapper, router } = await mountView()

    const row = rowOf(wrapper, '王小明')
    expect(row.text()).toContain('2026-10-05')
    expect(row.text()).not.toContain('2026-10-05~2026-10-05')
    expect(row.text()).not.toContain('進行中')
    expect(row.text()).toContain('員工：林行政')
    expect(row.text()).toContain('—')
    const link = row.find('a')
    expect(link.text()).toBe('王小明')
    await link.trigger('click')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/students?student=s1')
  })

  it('LeavesView shows cancel actions per leave state with permission', async () => {
    mock.onGet(LIST_URL).reply(
      200,
      page([
        leave({ id: 'l1', end_date: '2026-10-03' }),
        leave({
          id: 'l2',
          student: { id: 's2', student_no: 'S1002', name: '林小華', class_name: '低年級A班' },
          start_date: '2026-09-28',
          end_date: '2026-09-30',
        }),
        leave({
          id: 'l3',
          student: { id: 's3', student_no: 'S1003', name: '陳小美', class_name: '低年級A班' },
          status: 'cancelled',
          cancelled_at: '2026-10-01T02:00:00Z',
          cancelled_by_type: 'staff',
          cancelled_by_name: '林行政',
        }),
      ]),
    )
    const { wrapper } = await mountView()

    expect(headers(wrapper)).toContain('操作')
    expect(button(wrapper, '代登記請假')).toBeDefined()
    expect(rowOf(wrapper, '王小明').findAll('button').map((b) => b.text())).toContain('取消')
    const ended = rowOf(wrapper, '林小華')
      .findAll('button')
      .find((b) => b.text() === '整筆取消')
    expect(ended).toBeDefined()
    const cancelledButtons = rowOf(wrapper, '陳小美')
      .findAll('button')
      .map((b) => b.text())
    expect(cancelledButtons).not.toContain('取消')
    expect(cancelledButtons).not.toContain('整筆取消')

    await ended!.trigger('click')
    await settle()
    expect(document.body.textContent).toContain('已結束的請假只能整筆取消')
    document.body.innerHTML = ''

    const reader = await mountView(['leaves:read', 'students:read'])
    expect(button(reader.wrapper, '代登記請假')).toBeUndefined()
    expect(bodyButtons(reader.wrapper)).not.toContain('取消')
    expect(bodyButtons(reader.wrapper)).not.toContain('整筆取消')
    expect(headers(reader.wrapper)).not.toContain('操作')
  })

  it('LeavesView shows cancel actions per leave state with permission: reloads after cancel', async () => {
    mock.onGet(LIST_URL).reply(200, page([leave({ id: 'l1', start_date: '2026-10-05', end_date: '2026-10-06' })]))
    mock.onPost('/admin/leaves/l1/cancel').reply(200, leave({ id: 'l1', status: 'cancelled' }))
    const { wrapper } = await mountView()
    const before = listParams().length

    await rowOf(wrapper, '王小明')
      .findAll('button')
      .find((b) => b.text() === '取消')!
      .trigger('click')
    await settle()
    const submit = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.el-dialog__footer button')).find(
      (b) => b.textContent?.trim() === '取消請假',
    )
    submit!.click()
    await settle()

    expect(mock.history.post.map((r) => r.url)).toEqual(['/admin/leaves/l1/cancel'])
    expect(listParams()).toHaveLength(before + 1)
  })

  it('LeavesView shows cancel actions per leave state with permission: reloads after failed cancel closes', async () => {
    mock.onGet(LIST_URL).reply(200, page([leave({ id: 'l1', start_date: '2026-10-05', end_date: '2026-10-06' })]))
    mock.onPost('/admin/leaves/l1/cancel').reply(409, {
      error: { code: 'leave_not_active', message: '這筆請假已取消', details: null },
    })
    const { wrapper } = await mountView()
    const before = listParams().length

    await rowOf(wrapper, '王小明')
      .findAll('button')
      .find((b) => b.text() === '取消')!
      .trigger('click')
    await settle()
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('.el-dialog__footer button'))
      .find((b) => b.textContent?.trim() === '取消請假')!
      .click()
    await settle()
    expect(document.body.textContent).toContain('這筆請假已取消')
    expect(listParams()).toHaveLength(before)

    // dialog 關閉動畫結束（closed）後才重新整理
    wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('closed')
    await settle()
    expect(listParams()).toHaveLength(before + 1)
  })

  it('LeavesView shows cancelled info', async () => {
    mock
      .onGet(LIST_URL)
      .replyOnce(
        200,
        page([
          leave({
            status: 'cancelled',
            cancelled_by_type: 'staff',
            cancelled_by_name: '林行政',
            cancelled_at: '2026-10-01T02:00:00Z',
          }),
        ]),
      )
      .onGet(LIST_URL)
      .replyOnce(200, page([leave({})]))
    const first = await mountView()

    expect(headers(first.wrapper)).toContain('取消紀錄')
    expect(first.wrapper.find('.el-table__body').text()).toContain('員工：林行政 於 2026/10/01 10:00 取消')
    document.body.innerHTML = ''

    const second = await mountView()
    expect(headers(second.wrapper)).not.toContain('取消紀錄')
  })

  it('LeavesView empty state', async () => {
    mock.onGet(LIST_URL).reply(200, { items: [], total: 0, page: 1, page_size: 20 })
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('這段期間沒有請假紀錄')
    expect(wrapper.text()).toContain('試著調整日期區間或篩選條件')
  })

  it('LeavesView empty state: load failure and retry', async () => {
    mock
      .onGet(LIST_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器錯誤', details: null } })
      .onGet(LIST_URL)
      .replyOnce(200, page([leave({})]))
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入請假紀錄')
    expect(wrapper.find('.el-table').exists()).toBe(false)
    await button(wrapper, '重試')!.trigger('click')
    await settle()

    expect(wrapper.text()).not.toContain('無法載入請假紀錄')
    expect(rowOf(wrapper, '王小明').exists()).toBe(true)
  })

  it('LeavesView hides create without students:read', async () => {
    mock.onGet(LIST_URL).reply(200, page([leave({})]))
    const noStudents = await mountView(['leaves:read', 'leaves:write'])

    expect(button(noStudents.wrapper, '代登記請假')).toBeUndefined()
    expect(filterItem(noStudents.wrapper, '學生')).toBeUndefined()
    expect(rowOf(noStudents.wrapper, '王小明').find('a').exists()).toBe(false)
    document.body.innerHTML = ''

    const full = await mountView(['leaves:read', 'leaves:write', 'students:read'])
    expect(button(full.wrapper, '代登記請假')).toBeDefined()
    expect(filterItem(full.wrapper, '學生')).toBeDefined()
  })

  it('LeavesView toggles attachment row', async () => {
    mock.onGet(LIST_URL).reply(
      200,
      page([
        leave({
          attachments: [
            { id: 'a1', mime_type: 'image/jpeg', size_bytes: 524288, created_at: '2026-10-01T23:46:00Z' },
            { id: 'a2', mime_type: 'application/pdf', size_bytes: 2621440, created_at: '2026-10-01T23:47:00Z' },
          ],
        }),
      ]),
    )
    const { wrapper } = await mountView()

    const toggle = () => button(wrapper, '2個')!
    expect(toggle().attributes('aria-expanded')).toBe('false')
    await toggle().trigger('click')
    await settle()

    expect(wrapper.text()).toContain('附件 1')
    expect(toggle().attributes('aria-expanded')).toBe('true')

    await toggle().trigger('click')
    await settle()
    expect(wrapper.text()).not.toContain('附件 1')
    expect(toggle().attributes('aria-expanded')).toBe('false')
  })

  it('LeavesView presets filtered student in create dialog', async () => {
    mock.onGet(LIST_URL).reply(200, page([leave({})]))
    mock.onGet('/admin/students').reply(200, {
      items: [
        {
          id: 's1',
          student_no: 'S1001',
          name: '王小明',
          gender: 'male',
          grade_level: 2,
          school: null,
          school_class: null,
          class: { id: 'c1', name: '低年級A班' },
          status: 'active',
          archived_at: null,
        },
      ],
      total: 1,
      page: 1,
      page_size: 20,
    })
    const { wrapper } = await mountView()

    const select = filterItem(wrapper, '學生')!
    await select.find('input').setValue('王')
    await new Promise((resolve) => setTimeout(resolve, 350))
    await settle()
    const listId = select.find('input').attributes('aria-controls')
    document.getElementById(listId!)!.querySelector<HTMLElement>('.el-select-dropdown__item')!.click()
    await settle()

    expect(listParams().at(-1)).toMatchObject({ student_id: 's1', page: 1 })
    await button(wrapper, '代登記請假')!.trigger('click')
    await settle()

    const dialog = wrapper.findComponent(LeaveFormDialog)
    expect((dialog.props('presetStudent') as { id: string } | undefined)?.id).toBe('s1')
    expect(document.body.textContent).toContain('代登記請假')
  })
})
