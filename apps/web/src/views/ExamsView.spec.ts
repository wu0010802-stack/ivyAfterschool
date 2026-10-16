import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { Exam } from '@/api/exams'
import { adminHttp } from '@/api/http'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { createApiMock, mountWithApp } from '@/test/helpers'
import ExamsView from './ExamsView.vue'

const LIST_URL = '/admin/exams'
const WRITER = ['exams:read', 'exams:write']
const READER = ['exams:read']
// 台北 2026-10-02 11:00；學年度 115
const NOW = new Date('2026-10-02T03:00:00Z')

const EXAM_TYPES = [{ id: 't1', name: '段考', sort_order: 1, is_active: true }]
const CLASSES = [
  {
    id: 'c1',
    name: '低年級A班',
    grade_levels: [1, 2],
    academic_year: 115,
    sort_order: 0,
    archived_at: null,
    student_count: 18,
    staff: [],
  },
]

function exam(overrides: Partial<Exam> = {}): Exam {
  return {
    id: 'e1',
    name: '第一次段考',
    exam_type: { id: 't1', name: '段考' },
    exam_date: '2026-10-15',
    grade_level: 2,
    class: { id: 'c1', name: '低年級A班' },
    status: 'published',
    published_at: '2026-10-16T02:00:00Z',
    published_by_name: '張主任',
    note: null,
    subjects: [
      { subject_id: 'sub1', subject_name: '國語', full_score: 100, sort_order: 1 },
      { subject_id: 'sub2', subject_name: '數學', full_score: 100, sort_order: 2 },
    ],
    roster_count: 18,
    created_at: '2026-09-20T02:00:00Z',
    ...overrides,
  }
}

const DRAFT = exam({ id: 'e2', name: '國語第四課小考', status: 'draft', published_at: null, published_by_name: null })

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [
  { path: '/exams', component: Stub, meta: { title: '考試' } },
  { path: '/exams/:id', component: Stub, props: true, meta: { title: '考試成績' } },
]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

function replyList(items: Exam[]): void {
  mock.onGet(LIST_URL).reply(200, { items, total: items.length })
}

async function mountView(permissions: string[] = WRITER, initialRoute = '/exams') {
  const mounted = await mountWithApp(ExamsView, {
    routes: ROUTES,
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
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  await settle()
  return mounted
}

function listParams(): Record<string, unknown>[] {
  return mock.history.get.filter((c) => c.url === LIST_URL).map((c) => c.params as Record<string, unknown>)
}

function rows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.el-table__body tr.el-table__row')
}

function rowOf(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const row = rows(wrapper).find((r) => r.text().includes(name))
  if (!row) throw new Error(`找不到考試列 ${name}`)
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

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')).find(
    (el) => el.textContent?.trim() === label,
  )
}

function lastMessageBox(): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
}

async function answerMessageBox(text: string): Promise<void> {
  await settle()
  const btn = Array.from(lastMessageBox()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`message box 找不到「${text}」`)
  btn.click()
  await settle()
  await settle()
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function formItem(label: string): DOMWrapper<Element> {
  const item = dialog()
    .findAll('.el-form-item')
    .find((i) => i.find('.el-form-item__label').text().trim() === label)
  if (!item) throw new Error(`找不到欄位 ${label}`)
  return item
}

async function choose(label: string, option: string): Promise<void> {
  const item = formItem(label)
  await item.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = item.find('input').attributes('aria-controls')
  const target = Array.from(
    document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [],
  ).find((o) => o.textContent?.trim() === option)
  if (!target) throw new Error(`找不到選項 ${option}`)
  target.click()
  await settle()
}

async function typeDate(value: string): Promise<void> {
  const input = formItem('考試日期').find('input')
  await input.trigger('focus')
  await input.setValue(value)
  await input.trigger('change')
  await settle()
}

async function search(wrapper: VueWrapper, text: string): Promise<void> {
  const input = wrapper.find('.list-toolbar__search input')
  await input.setValue(text)
  await input.trigger('keyup', { key: 'Enter' })
  await settle()
  await settle()
}

describe('ExamsView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/exam-types').reply(200, EXAM_TYPES)
    mock.onGet('/admin/classes').reply(200, CLASSES)
    mock.onGet('/admin/subjects').reply(200, [])
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('ExamsView loads with default date range', async () => {
    replyList([exam()])
    const { wrapper } = await mountView()

    expect(wrapper.find('h1').text()).toBe('考試')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe('建立考試、輸入各科成績；發布後家長才看得到成績')
    expect(listParams()).toHaveLength(1)
    expect(listParams()[0]).toMatchObject({ date_from: '2026-07-04', date_to: '2026-11-01', page: 1, page_size: 20 })
    expect(listParams()[0]).not.toHaveProperty('q')
    expect(listParams()[0]).not.toHaveProperty('status')
    // 日期區間以 YYYY/MM/DD 顯示
    const dateInputs = wrapper.findAll('[data-test=toolbar-extra-filters] input')
    expect(dateInputs.map((i) => (i.element as HTMLInputElement).value)).toEqual(['2026/07/04', '2026/11/01'])
    expect(wrapper.find('[data-test=toolbar-count]').text()).toBe('共 1 筆')
    expect(wrapper.findAll('.el-table__header th').map((th) => th.text())).toEqual([
      '考試日期',
      '名稱',
      '類型',
      '對象',
      '科目數',
      '應考人數',
      '狀態',
      '',
    ])
  })

  it('ExamsView renders target and status', async () => {
    replyList([
      exam(),
      exam({
        id: 'e3',
        name: '期末考',
        exam_date: '2025-12-18',
        grade_level: 3,
        class: null,
        status: 'draft',
        published_at: null,
        published_by_name: null,
        subjects: [],
        roster_count: 0,
      }),
    ])
    const { wrapper } = await mountView()

    const row = rowOf(wrapper, '第一次段考')
    const cells = row.findAll('td').map((c) => c.text())
    expect(cells[0]).toBe('10/15（四）')
    expect(cells[1]).toBe('第一次段考')
    expect(cells[2]).toBe('段考')
    expect(cells[3]).toBe('低年級A班・二年級')
    expect(cells[4]).toBe('2')
    expect(cells[5]).toBe('18')
    expect(cells[6]).toContain('已發布')
    expect(cells[6]).toContain('2026/10/16 10:00')
    expect(row.find('.el-tag').classes()).toContain('el-tag--success')
    expect(row.find('a.exam-name').attributes('href')).toBe('/exams/e1')

    const old = rowOf(wrapper, '期末考')
    const oldCells = old.findAll('td')
    // 不是今年的考試前面加灰色小字年份
    expect(oldCells[0]?.find('.exam-date__year').text()).toBe('2025')
    expect(oldCells[0]?.text()).toBe('202512/18（四）')
    expect(oldCells[3]?.text()).toBe('三年級')
    expect(oldCells[4]?.text()).toBe('未設定')
    expect(oldCells[4]?.find('.exam-warn').exists()).toBe(true)
    expect(oldCells[5]?.find('.exam-warn').exists()).toBe(true)
    expect(oldCells[6]?.text()).toBe('草稿')
    expect(old.find('.el-tag').classes()).toContain('el-tag--info')
  })

  it('ExamsView navigates to detail on row click', async () => {
    replyList([exam()])
    const { wrapper, router } = await mountView()

    await rowOf(wrapper, '第一次段考').trigger('click')
    await settle()

    expect(router.currentRoute.value.path).toBe('/exams/e1')
  })

  it('ExamsView create redirects to scores tab', async () => {
    replyList([])
    mock.onPost(LIST_URL).reply(201, exam({ id: 'e9', name: '第二次段考', status: 'draft', subjects: [] }))
    const { wrapper, router } = await mountView()

    await clickIn(wrapper.find('.page-header'), '建立考試')
    expect(dialog().find('.el-dialog__title').text()).toBe('建立考試')
    await formItem('名稱').find('input').setValue('第二次段考')
    await choose('考試類型', '段考')
    await typeDate('2026/11/20')
    await choose('年級', '三年級')
    await clickIn(dialog().find('.el-dialog__footer'), '建立')
    await settle()

    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({
      name: '第二次段考',
      exam_type_id: 't1',
      exam_date: '2026-11-20',
      grade_level: 3,
    })
    expect(mock.history.put).toHaveLength(0)
    expect(router.currentRoute.value.fullPath).toBe('/exams/e9?tab=scores')
    // 整頁 + 表格 + dialog 的掛載在共用 CPU 下可能超過預設 5 秒
  }, 20000)

  it('ExamsView delete only for drafts with permission', async () => {
    mock.onGet(LIST_URL).replyOnce(200, { items: [exam(), DRAFT], total: 2 }).onGet(LIST_URL).reply(200, { items: [exam()], total: 1 })
    mock.onDelete('/admin/exams/e2').reply(204)
    const { wrapper } = await mountView()

    const draft = rowOf(wrapper, '國語第四課小考')
    const more = draft.find('button[aria-label="更多操作：國語第四課小考"]')
    expect(more.exists()).toBe(true)
    expect(rowOf(wrapper, '第一次段考').find('.el-dropdown').exists()).toBe(false)
    expect(buttonsText(rowOf(wrapper, '第一次段考'))).toEqual([])

    await more.trigger('click')
    await settle()
    const item = menuItem('刪除')
    expect(item).toBeDefined()
    item!.click()
    await settle()
    expect(lastMessageBox()?.textContent).toContain('刪除後已輸入的成績會一併刪除，確定要刪除「國語第四課小考」嗎？')
    await answerMessageBox('刪除')

    expect(mock.history.delete.map((c) => c.url)).toEqual(['/admin/exams/e2'])
    expect(document.body.textContent).toContain('已刪除')
    expect(listParams()).toHaveLength(2)
    expect(rows(wrapper)).toHaveLength(1)

    wrapper.unmount()
    document.body.innerHTML = ''
    mock.resetHistory()
    mock.onGet(LIST_URL).reply(200, { items: [exam(), DRAFT], total: 2 })
    const reader = await mountView(READER)
    expect(buttonsText(reader.wrapper.find('.page-header'))).toEqual([])
    expect(reader.wrapper.find('.el-dropdown').exists()).toBe(false)
    expect(reader.wrapper.findAll('.el-table__header th').map((th) => th.text())).not.toContain('')
    expect(rows(reader.wrapper)).toHaveLength(2)
    // 兩次整頁掛載 + 下拉 + 確認框在共用 CPU 下可能超過預設 5 秒
  }, 20000)

  it('ExamsView empty states', async () => {
    replyList([])
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('還沒有考試紀錄')
    expect(wrapper.text()).toContain('預設只顯示近 90 天到未來 30 天的考試，更早的考試請調整日期區間')
    expect(buttonsText(wrapper.find('.el-table__empty-block'))).toEqual(['建立考試'])
    expect(wrapper.find('.list-pager').exists()).toBe(false)

    await search(wrapper, '期末')

    expect(listParams().at(-1)).toMatchObject({ q: '期末', page: 1 })
    expect(wrapper.text()).toContain('沒有符合條件的考試')
    expect(wrapper.text()).toContain('試著調整搜尋文字、篩選條件或日期區間')
    expect(wrapper.text()).not.toContain('還沒有考試紀錄')
    expect(buttonsText(wrapper.find('.el-table__empty-block'))).toEqual([])
  })

  it('ExamsView shows retry on load failure', async () => {
    mock
      .onGet(LIST_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
      .onGet(LIST_URL)
      .reply(200, { items: [exam()], total: 1 })
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入考試')
    expect(wrapper.find('.el-table').exists()).toBe(false)
    expect(wrapper.find('[data-test=toolbar-count]').exists()).toBe(false)

    await clickIn(wrapper, '重試')

    expect(listParams()).toHaveLength(2)
    expect(rows(wrapper)).toHaveLength(1)
  })

  it('ExamsView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.ExamsView()) as { default?: unknown }

    expect(loaded.default).toBe(ExamsView)
  })
})
