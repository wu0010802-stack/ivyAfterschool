import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { StudentListItem } from '@/api/students'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentListPanel from './StudentListPanel.vue'

// 三個 dialog 各自有完整測試；這裡以替身驗證本元件的開關與完成後的行為（也避免多個 el-select 拖慢 happy-dom）
function dialogStub(name: string, doneEvent: string) {
  return defineComponent({
    name,
    props: { modelValue: { type: Boolean, default: false } },
    emits: ['update:modelValue', doneEvent],
    setup(props) {
      return () => h('div', { 'data-test': name, 'data-open': String(props.modelValue) })
    },
  })
}

vi.mock('./StudentFormDialog.vue', () => ({ default: dialogStub('StudentFormDialog', 'saved') }))
vi.mock('./StudentImportDialog.vue', () => ({ default: dialogStub('StudentImportDialog', 'imported') }))
vi.mock('./GradePromotionDialog.vue', () => ({ default: dialogStub('GradePromotionDialog', 'promoted') }))

const LIST_URL = '/admin/students'
const READER = ['students:read']
const WRITER = ['students:read', 'students:write']

function student(overrides: Partial<StudentListItem> = {}): StudentListItem {
  return {
    id: 's1',
    student_no: 'S1001',
    name: '王小明',
    gender: 'male',
    grade_level: 3,
    school: { id: 'sc1', name: '某某國民小學', short_name: '某某國小' },
    school_class: '三年二班',
    class: { id: 'c1', name: '低年級A班' },
    status: 'active',
    archived_at: null,
    ...overrides,
  } as StudentListItem
}

const ARCHIVED = student({
  id: 's2',
  student_no: 'S1002',
  name: '李小華',
  status: 'withdrawn',
  archived_at: '2026-09-01T02:00:00Z',
  school: null,
  school_class: null,
  class: null,
})

const CLASSES = [
  { id: 'c1', name: '低年級A班', grade_levels: [1, 2], academic_year: 115, sort_order: 1, archived_at: null, student_count: 18, staff: [] },
  { id: 'c0', name: '去年的班', grade_levels: [3], academic_year: 114, sort_order: 1, archived_at: null, student_count: 0, staff: [] },
]
const SCHOOLS = [{ id: 'sc1', name: '某某國民小學', short_name: '某某國小', is_active: true }]

const ROUTES: RouteRecordRaw[] = [{ path: '/students', component: { render: () => null } }]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

function page(items: StudentListItem[], total = items.length) {
  return { items, total }
}

async function mountPanel(
  options: { permissions?: string[]; initialRoute?: string; selectedId?: string | null } = {},
) {
  const mounted = await mountWithApp(StudentListPanel, {
    routes: ROUTES,
    initialRoute: options.initialRoute ?? '/students',
    props: { selectedId: options.selectedId ?? null },
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'clerk01',
          display_name: '林行政',
          role: { id: 'r-clerk', code: 'clerk', name: '行政' },
          permissions: options.permissions ?? WRITER,
          must_change_password: false,
        },
      },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  return mounted
}

function listParams(): Record<string, unknown>[] {
  return mock.history.get.filter((c) => c.url === LIST_URL).map((c) => c.params as Record<string, unknown>)
}

function lastParams(): Record<string, unknown> {
  const p = listParams().at(-1)
  if (!p) throw new Error('沒有 GET /admin/students')
  return p
}

function rows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.el-table__body tr.el-table__row')
}

function rowOf(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const row = rows(wrapper).find((r) => r.findAll('td')[1]?.text().startsWith(name))
  if (!row) throw new Error(`找不到學生列 ${name}`)
  return row
}

function buttonsText(root: VueWrapper | DOMWrapper<Element>): string[] {
  return root.findAll('button').map((b) => b.text())
}

async function clickIn(root: VueWrapper | DOMWrapper<Element>, text: string): Promise<void> {
  const btn = root.findAll('button').find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  await btn.trigger('click')
  await settle()
}

/** 以篩選標籤找到 AdminListToolbar 的下拉，選取選項（以 input 的 aria-controls 對應 teleport 的選單） */
async function chooseFilter(wrapper: VueWrapper, label: string, option: string): Promise<void> {
  const filter = wrapper
    .findAll('.list-toolbar__filter')
    .find((f) => f.find('.list-toolbar__filter-label').text() === label)
  if (!filter) throw new Error(`找不到篩選 ${label}`)
  await filter.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = filter.find('input').attributes('aria-controls')
  const options = Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [])
  const found = options.find((o) => o.textContent?.trim() === option)
  if (!found) throw new Error(`篩選 ${label} 找不到「${option}」，現有：${options.map((o) => o.textContent?.trim()).join('、')}`)
  found.click()
  await settle()
}

function filterOptions(wrapper: VueWrapper, label: string): Promise<string[]> {
  return (async () => {
    const filter = wrapper
      .findAll('.list-toolbar__filter')
      .find((f) => f.find('.list-toolbar__filter-label').text() === label)
    if (!filter) throw new Error(`找不到篩選 ${label}`)
    await filter.find('.el-select__wrapper').trigger('click')
    await settle()
    const listId = filter.find('input').attributes('aria-controls')
    return Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? []).map(
      (o) => o.textContent?.trim() ?? '',
    )
  })()
}

function selectedLabel(wrapper: VueWrapper, label: string): string {
  const filter = wrapper
    .findAll('.list-toolbar__filter')
    .find((f) => f.find('.list-toolbar__filter-label').text() === label)
  return filter?.find('.el-select__selected-item:not(.is-hidden)').text() ?? ''
}

async function setArchived(wrapper: VueWrapper, value: boolean): Promise<void> {
  const box = wrapper.findAll('.el-checkbox').find((c) => c.text() === '含封存')
  if (!box) throw new Error('找不到「含封存」')
  await box.find('input').setValue(value)
  await settle()
}

async function openBatchMenu(wrapper: VueWrapper): Promise<string[]> {
  const btn = wrapper.findAll('button').find((b) => b.text() === '批次作業')
  if (!btn) throw new Error('找不到「批次作業」')
  await btn.trigger('click')
  await vi.advanceTimersByTimeAsync(300)
  await settle()
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')).map(
    (i) => i.textContent?.trim() ?? '',
  )
}

async function chooseBatch(wrapper: VueWrapper, text: string): Promise<void> {
  await openBatchMenu(wrapper)
  const item = Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item'))
    .filter((i) => i.textContent?.trim() === text)
    .at(-1)
  if (!item) throw new Error(`批次作業找不到「${text}」`)
  item.click()
  await vi.advanceTimersByTimeAsync(300)
  await settle()
}

function dialog(wrapper: VueWrapper, name: string): VueWrapper {
  return wrapper.findComponent({ name }) as VueWrapper
}

describe('StudentListPanel', () => {
  beforeEach(() => {
    // el-dropdown 以 setTimeout 開關；Date 固定讓「目前學年度」為 115
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-02T03:00:00Z'))
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/classes').reply(200, CLASSES)
    mock.onGet('/admin/schools').reply(200, SCHOOLS)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('StudentListPanel loads active students by default', async () => {
    mock.onGet(LIST_URL).reply(200, page([student()]))
    const { wrapper } = await mountPanel()

    expect(listParams()).toEqual([{ status: 'active', page: 1, page_size: 20 }])
    expect(wrapper.findAll('.el-table__header th').map((th) => th.text())).toEqual([
      '學號',
      '姓名',
      '年級',
      '就讀國小 / 班級',
      '安親班班級',
      '狀態',
    ])
    const cells = rowOf(wrapper, '王小明').findAll('td').map((td) => td.text())
    expect(cells).toEqual(['S1001', '王小明', '三年級', '某某國小 三年二班', '低年級A班', '在學'])
    expect(rowOf(wrapper, '王小明').find('.el-tag').classes()).toContain('el-tag--success')
    expect(selectedLabel(wrapper, '狀態')).toBe('在學')
    expect(wrapper.find('[data-test=toolbar-count]').text()).toBe('共 1 筆')
  })

  it('StudentListPanel filters by class and archived', async () => {
    mock.onGet(LIST_URL).reply((config) => {
      const params = config.params as { include_archived?: boolean }
      return [200, page(params.include_archived ? [student(), ARCHIVED] : [student()])]
    })
    const { wrapper, router } = await mountPanel()

    // 班級只列目前學年度（115）
    expect(await filterOptions(wrapper, '班級')).toEqual(['全部', '低年級A班'])
    await chooseFilter(wrapper, '班級', '低年級A班')
    await setArchived(wrapper, true)

    expect(lastParams()).toMatchObject({ class_id: 'c1', include_archived: true, page: 1 })
    expect(router.currentRoute.value.query).toMatchObject({ class_id: 'c1', include_archived: 'true', page: '1' })
    const archived = rowOf(wrapper, '李小華')
    expect(archived.text()).toContain('已封存')
    expect(archived.classes()).toContain('row-archived')
    expect(archived.findAll('td').map((td) => td.text())).toEqual([
      'S1002',
      '李小華已封存',
      '三年級',
      '—',
      '—',
      '退班',
    ])
    expect(rowOf(wrapper, '王小明').classes()).not.toContain('row-archived')
  })

  it('StudentListPanel filters by grade school and status', async () => {
    mock.onGet(LIST_URL).reply(200, page([student()]))
    const { wrapper, router } = await mountPanel()

    await chooseFilter(wrapper, '年級', '三年級')
    expect(lastParams()).toMatchObject({ grade_level: 3, status: 'active', page: 1 })
    await chooseFilter(wrapper, '就讀國小', '某某國小')
    expect(lastParams()).toMatchObject({ grade_level: 3, school_id: 'sc1' })

    // 狀態選「全部」：不帶 status，網址記成 all（重新整理仍是全部，不會退回預設「在學」）
    await chooseFilter(wrapper, '狀態', '全部')
    expect(lastParams().status).toBeUndefined()
    expect(router.currentRoute.value.query.status).toBe('all')
    await chooseFilter(wrapper, '狀態', '暫停')
    expect(lastParams().status).toBe('suspended')
  })

  it('StudentListPanel restores filters from query', async () => {
    mock.onGet(LIST_URL).reply(200, page([student()]))
    const { wrapper } = await mountPanel({
      initialRoute: '/students?status=all&grade_level=3&include_archived=true&q=王&page=2',
    })

    expect(listParams()).toEqual([{ q: '王', grade_level: 3, include_archived: true, page: 2, page_size: 20 }])
    expect(selectedLabel(wrapper, '狀態')).toBe('全部')
    expect(selectedLabel(wrapper, '年級')).toBe('三年級')
    expect(wrapper.findAll('.el-checkbox').find((c) => c.text() === '含封存')?.classes()).toContain('is-checked')
    expect(wrapper.find<HTMLInputElement>('.list-toolbar__search input').element.value).toBe('王')
  })

  it('StudentListPanel emits select on row click', async () => {
    mock.onGet(LIST_URL).reply(200, page([student(), student({ id: 's3', student_no: 'S1003', name: '陳小美' })]))
    const { wrapper } = await mountPanel()

    await rowOf(wrapper, '王小明').trigger('click')

    expect(wrapper.emitted('select')).toEqual([['s1']])
  })

  it('StudentListPanel highlights selected row', async () => {
    mock.onGet(LIST_URL).reply(200, page([student(), student({ id: 's3', student_no: 'S1003', name: '陳小美' })]))
    const { wrapper } = await mountPanel({ selectedId: 's3' })

    expect(rowOf(wrapper, '陳小美').classes()).toContain('current-row')
    expect(rowOf(wrapper, '王小明').classes()).not.toContain('current-row')

    await wrapper.setProps({ selectedId: 's1' })
    await settle()
    expect(rowOf(wrapper, '王小明').classes()).toContain('current-row')
    expect(rowOf(wrapper, '陳小美').classes()).not.toContain('current-row')
  })

  it('StudentListPanel write actions depend on permission', async () => {
    mock.onGet(LIST_URL).reply(200, page([student()]))
    const reader = await mountPanel({ permissions: READER })
    expect(buttonsText(reader.wrapper)).not.toContain('新增學生')
    expect(buttonsText(reader.wrapper)).not.toContain('批次作業')
    expect(document.body.textContent).not.toContain('匯入 Excel')
    expect(document.body.textContent).not.toContain('學年升級')
    expect(dialog(reader.wrapper, 'StudentFormDialog').exists()).toBe(false)
    reader.wrapper.unmount()
    document.body.innerHTML = ''

    const writer = await mountPanel({ permissions: WRITER })
    expect(buttonsText(writer.wrapper)).toContain('新增學生')
    expect(await openBatchMenu(writer.wrapper)).toEqual(['匯入 Excel', '學年升級'])
  })

  it('StudentListPanel creates student then selects it', async () => {
    mock.onGet(LIST_URL).reply(200, page([student()]))
    const { wrapper } = await mountPanel()

    await clickIn(wrapper.find('[data-test=toolbar-actions]'), '新增學生')
    const form = dialog(wrapper, 'StudentFormDialog')
    expect(form.props('modelValue')).toBe(true)

    form.vm.$emit('saved', { ...student({ id: 's9', name: '新同學' }) })
    await settle()

    expect(wrapper.emitted('select')).toEqual([['s9']])
    expect(listParams()).toHaveLength(2)
  })

  it('StudentListPanel opens import and promotion and reloads after done', async () => {
    mock.onGet(LIST_URL).reply(200, page([student()]))
    const { wrapper } = await mountPanel()

    await chooseBatch(wrapper, '匯入 Excel')
    expect(dialog(wrapper, 'StudentImportDialog').props('modelValue')).toBe(true)
    dialog(wrapper, 'StudentImportDialog').vm.$emit('imported', { created: 3 })
    await settle()
    expect(listParams()).toHaveLength(2)

    await chooseBatch(wrapper, '學年升級')
    expect(dialog(wrapper, 'GradePromotionDialog').props('modelValue')).toBe(true)
    dialog(wrapper, 'GradePromotionDialog').vm.$emit('promoted', { promoted: 10, graduated: 2 })
    await settle()
    expect(listParams()).toHaveLength(3)
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('StudentListPanel empty states', async () => {
    mock.onGet(LIST_URL).reply(200, page([]))
    const { wrapper } = await mountPanel()

    const empty = () => wrapper.find('.el-table__empty-block')
    expect(empty().text()).toContain('還沒有學生')
    expect(empty().text()).toContain('新增第一位學生，或用 Excel 一次匯入')
    expect(buttonsText(empty())).toEqual(['新增學生', '匯入 Excel'])

    const search = wrapper.find('.list-toolbar__search input')
    await search.setValue('不存在')
    await search.trigger('keyup', { key: 'Enter' })
    await settle()
    expect(lastParams().q).toBe('不存在')
    expect(empty().text()).toContain('沒有符合條件的學生')
    expect(empty().text()).not.toContain('還沒有學生')

    await clickIn(empty(), '清除篩選')
    expect(lastParams()).toEqual({ status: 'active', page: 1, page_size: 20 })
    expect('q' in lastParams()).toBe(false)
    expect(empty().text()).toContain('還沒有學生')
    expect(wrapper.find<HTMLInputElement>('.list-toolbar__search input').element.value).toBe('')
  })

  it('StudentListPanel empty state counts non default status as filter', async () => {
    mock.onGet(LIST_URL).reply(200, page([]))
    const { wrapper } = await mountPanel({ permissions: READER, initialRoute: '/students?status=suspended' })

    const empty = wrapper.find('.el-table__empty-block')
    expect(empty.text()).toContain('沒有符合條件的學生')

    await clickIn(empty, '清除篩選')
    expect(lastParams()).toEqual({ status: 'active', page: 1, page_size: 20 })
    // 沒有寫入權限：「還沒有學生」不附按鈕
    expect(buttonsText(wrapper.find('.el-table__empty-block'))).toEqual([])
  })

  it('StudentListPanel paginates', async () => {
    mock.onGet(LIST_URL).reply(200, page([student()], 45))
    const { wrapper, router } = await mountPanel()

    expect(wrapper.find('.el-pagination').text()).toContain('45')
    await wrapper.find('.el-pagination .btn-next').trigger('click')
    await settle()

    expect(lastParams()).toMatchObject({ status: 'active', page: 2, page_size: 20 })
    expect(router.currentRoute.value.query.page).toBe('2')
  })

  it('StudentListPanel shows retry on load failure and exposes reload', async () => {
    mock
      .onGet(LIST_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
      .onGet(LIST_URL)
      .reply(200, page([student()]))
    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('無法載入學生列表')
    expect(wrapper.find('.el-table').exists()).toBe(false)
    await clickIn(wrapper, '重試')
    expect(rows(wrapper)).toHaveLength(1)

    await (wrapper.vm as unknown as { reload: () => Promise<void> }).reload()
    await settle()
    expect(listParams()).toHaveLength(3)
  })
})
