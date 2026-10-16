import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { ClassItem } from '@/api/classes'
import { adminHttp } from '@/api/http'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { useLookupsStore } from '@/stores/lookups'
import { createApiMock, mountWithApp } from '@/test/helpers'
import ClassesView from './ClassesView.vue'

const LIST_URL = '/admin/classes'
const WRITER = ['classes:read', 'classes:write']

function klass(overrides: Partial<ClassItem> = {}): ClassItem {
  return {
    id: 'c1',
    name: '低年級A班',
    grade_levels: [1, 2],
    academic_year: 115,
    sort_order: 1,
    archived_at: null,
    student_count: 18,
    staff: [
      { staff_user_id: 'u3', display_name: '林老師', role: 'assistant' },
      { staff_user_id: 'u2', display_name: '陳老師', role: 'lead' },
    ],
    ...overrides,
  }
}

const EMPTY_CLASS = klass({ id: 'c2', name: '中年級班', grade_levels: [3, 4], sort_order: 2, student_count: 0, staff: [] })

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [
  { path: '/classes', component: Stub, meta: { title: '班級管理' } },
  { path: '/students', component: Stub, meta: { title: '學生工作台' } },
]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountView(permissions: string[] = WRITER, initialRoute = '/classes') {
  const mounted = await mountWithApp(ClassesView, {
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
      lookups: { loaded: { classes: true, subjects: true, examTypes: true, schools: true } },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
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
  const row = rows(wrapper).find((r) => r.findAll('td')[0]?.text() === name)
  if (!row) throw new Error(`找不到班級列 ${name}`)
  return row
}

function headers(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-table__header th').map((th) => th.text())
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

/** ElMessageBox 下一個 tick 才渲染；已關閉的仍可能留在 DOM，取最後一個 */
async function answerMessageBox(text: string): Promise<HTMLElement> {
  await settle()
  const box = Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
  if (!box) throw new Error('message box 沒有出現')
  const btn = Array.from(box.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text)
  if (!btn) throw new Error(`message box 找不到「${text}」`)
  btn.click()
  await settle()
  await settle()
  return box
}

function lastMessageBoxText(): string {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)?.textContent ?? ''
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

async function chooseYear(wrapper: VueWrapper, label: string): Promise<void> {
  const select = wrapper.find('[data-test=filter-year] .el-select')
  await select.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = select.find('input').attributes('aria-controls')
  const options = Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [])
  const option = options.find((o) => o.textContent?.trim() === label)
  if (!option) throw new Error(`找不到學年度 ${label}，現有：${options.map((o) => o.textContent?.trim()).join('、')}`)
  option.click()
  await settle()
}

async function setCheckbox(wrapper: VueWrapper, label: string, value: boolean): Promise<void> {
  const box = wrapper.findAll('.el-checkbox').find((c) => c.text() === label)
  if (!box) throw new Error(`找不到勾選框 ${label}`)
  await box.find('input').setValue(value)
  await settle()
}

describe('ClassesView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T03:00:00Z'))
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('ClassesView loads current academic year', async () => {
    mock.onGet(LIST_URL).reply(200, [EMPTY_CLASS, klass()])
    const { wrapper } = await mountView()

    expect(wrapper.find('h1').text()).toBe('班級管理')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe('安親班內部的班級；學生就讀國小的班級在學生資料裡填寫')
    expect(listParams()).toEqual([{ academic_year: 115, include_archived: false, mine: false }])
    expect(headers(wrapper)).toEqual(['班級名稱', '年級', '在學人數', '負責老師', '排序', '操作'])
    // 依排序、再依名稱
    expect(rows(wrapper).map((r) => r.findAll('td')[0]?.text())).toEqual(['低年級A班', '中年級班'])

    const row = rowOf(wrapper, '低年級A班')
    expect(row.text()).toContain('一、二年級')
    expect(row.findAll('td')[2]?.text()).toBe('18')
    // 負責老師粗體在前、協助老師在後
    expect(row.findAll('td')[3]?.text()).toBe('陳老師、林老師')
    expect(row.find('td:nth-child(4) strong').text()).toBe('陳老師')
    expect(wrapper.find('[data-test=class-count]').text()).toBe('共 2 班')

    const empty = rowOf(wrapper, '中年級班')
    expect(empty.findAll('td')[2]?.find('button').exists()).toBe(false)
    expect(empty.findAll('td')[2]?.text()).toBe('0')
    expect(empty.findAll('td')[3]?.text()).toBe('尚未指派')
  })

  it('ClassesView student count links to students page', async () => {
    mock.onGet(LIST_URL).reply(200, [klass()])
    const { wrapper, router } = await mountView()

    await clickIn(rowOf(wrapper, '低年級A班'), '18')

    expect(router.currentRoute.value.path).toBe('/students')
    expect(router.currentRoute.value.query.class_id).toBe('c1')
  })

  it('ClassesView archive conflict shows guidance', async () => {
    mock.onGet(LIST_URL).reply(200, [klass()])
    mock.onPost('/admin/classes/c1/archive').reply(409, {
      error: { code: 'class_has_students', message: '班級仍有學生', details: { student_count: 5 } },
    })
    const { wrapper, router } = await mountView()

    await clickIn(rowOf(wrapper, '低年級A班'), '封存')
    expect(lastMessageBoxText()).toContain('封存後此班級不會出現在班級選單，確定要封存 低年級A班 嗎？')
    await answerMessageBox('封存')

    expect(mock.history.post[0]?.url).toBe('/admin/classes/c1/archive')
    expect(document.body.textContent).toContain('班級仍有 5 位在學學生，請先將學生調班或退班')
    await answerMessageBox('查看班上學生')

    expect(router.currentRoute.value.path).toBe('/students')
    expect(router.currentRoute.value.query.class_id).toBe('c1')
  })

  it('ClassesView archives class and reloads', async () => {
    mock.onGet(LIST_URL).replyOnce(200, [klass({ student_count: 0 })]).onGet(LIST_URL).replyOnce(200, [])
    mock.onPost('/admin/classes/c1/archive').reply(200, klass({ student_count: 0, archived_at: '2026-10-02T03:00:00Z' }))
    const { wrapper, pinia } = await mountView()

    await clickIn(rowOf(wrapper, '低年級A班'), '封存')
    await answerMessageBox('封存')

    expect(mock.history.post).toHaveLength(1)
    expect(document.body.textContent).toContain('已封存 低年級A班')
    expect(listParams()).toHaveLength(2)
    expect(useLookupsStore(pinia).classesLoaded).toBe(false)
    expect(rows(wrapper)).toHaveLength(0)
  })

  it('ClassesView hides write actions without permission', async () => {
    mock.onGet(LIST_URL).reply(200, [klass()])
    const { wrapper } = await mountView(['classes:read'])

    const texts = buttonsText(wrapper)
    for (const label of ['新增班級', '編輯', '指派老師', '封存']) expect(texts).not.toContain(label)
    expect(headers(wrapper)).not.toContain('操作')
  })

  it('ClassesView empty state per year', async () => {
    mock.onGet(LIST_URL).reply(200, [])
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('115 學年度還沒有班級')
    expect(buttonsText(wrapper.find('.el-table__empty-block'))).toEqual(['新增班級'])
  })

  it('ClassesView invalidates lookups after write', async () => {
    const created = klass({ id: 'c9', name: '中年級A班', grade_levels: [3], staff: [], student_count: 0 })
    mock.onGet(LIST_URL).replyOnce(200, []).onGet(LIST_URL).replyOnce(200, [created])
    mock.onPost(LIST_URL).reply(201, created)
    const { wrapper, pinia } = await mountView()
    expect(useLookupsStore(pinia).classesLoaded).toBe(true)

    await clickIn(wrapper.find('.page-header'), '新增班級')
    expect(dialog().find('.el-dialog__title').text()).toBe('新增班級')
    const nameInput = dialog()
      .findAll('.el-form-item')
      .find((i) => i.find('.el-form-item__label').text().trim() === '班級名稱')
      ?.find('input')
    if (!nameInput) throw new Error('找不到班級名稱')
    await nameInput.setValue('中年級A班')
    const grade = dialog()
      .findAll('.el-checkbox-button')
      .find((b) => b.text() === '三年級')
    if (!grade) throw new Error('找不到三年級')
    await grade.find('input').setValue(true)
    await clickIn(dialog().find('.el-dialog__footer'), '儲存')

    expect(JSON.parse(mock.history.post[0]?.data as string)).toMatchObject({ name: '中年級A班', academic_year: 115 })
    expect(useLookupsStore(pinia).classesLoaded).toBe(false)
    expect(listParams()).toHaveLength(2)
    expect(rows(wrapper).map((r) => r.findAll('td')[0]?.text())).toEqual(['中年級A班'])
  })

  it('ClassesView mine empty state', async () => {
    mock.onGet(LIST_URL).reply((config) => [200, (config.params as { mine: boolean }).mine ? [] : [klass()]])
    const { wrapper, router } = await mountView()

    await setCheckbox(wrapper, '只看我的班', true)

    expect(listParams().at(-1)).toEqual({ academic_year: 115, include_archived: false, mine: true })
    expect(router.currentRoute.value.query.mine).toBe('true')
    expect(wrapper.text()).toContain('115 學年度沒有你負責的班級')
    expect(wrapper.text()).toContain('負責老師由有「管理班級」權限的人在「指派老師」設定')
    expect(wrapper.text()).not.toContain('115 學年度還沒有班級')

    await clickIn(wrapper.find('.el-table__empty-block'), '顯示全部班級')

    expect(listParams().at(-1)?.mine).toBe(false)
    expect(wrapper.findAll('.el-checkbox').find((c) => c.text() === '只看我的班')?.classes()).not.toContain('is-checked')
    expect(rows(wrapper)).toHaveLength(1)
  })

  it('ClassesView syncs filters with query', async () => {
    mock.onGet(LIST_URL).reply((config) => {
      const params = config.params as { include_archived: boolean }
      return [200, params.include_archived ? [klass(), klass({ id: 'c3', name: '舊班', sort_order: 9, archived_at: '2026-09-01T02:00:00Z', student_count: 0 })] : [klass()]]
    })
    const { wrapper, router } = await mountView()

    await chooseYear(wrapper, '114 學年度')
    expect(listParams().at(-1)).toEqual({ academic_year: 114, include_archived: false, mine: false })
    expect(router.currentRoute.value.query.academic_year).toBe('114')
    expect(headers(wrapper)).not.toContain('狀態')

    await setCheckbox(wrapper, '含已封存', true)
    expect(listParams().at(-1)).toEqual({ academic_year: 114, include_archived: true, mine: false })
    expect(router.currentRoute.value.query.include_archived).toBe('true')
    expect(headers(wrapper)).toContain('狀態')
    const archived = rowOf(wrapper, '舊班')
    expect(archived.classes()).toContain('cls-row-archived')
    expect(archived.text()).toContain('已封存')
    expect(archived.text()).toContain('2026/09/01')
    // 已封存的列沒有操作
    expect(buttonsText(archived)).toEqual([])
    expect(buttonsText(rowOf(wrapper, '低年級A班'))).toEqual(['18', '編輯', '指派老師', '封存'])
  })

  it('ClassesView restores filters from query', async () => {
    mock.onGet(LIST_URL).reply(200, [klass({ academic_year: 114 })])
    const { wrapper } = await mountView(WRITER, '/classes?academic_year=114&mine=true&include_archived=true')

    expect(listParams()).toEqual([{ academic_year: 114, include_archived: true, mine: true }])
    const checked = wrapper
      .findAll('.el-checkbox')
      .filter((c) => c.classes().includes('is-checked'))
      .map((c) => c.text())
    expect(checked).toEqual(['只看我的班', '含已封存'])
  })

  it('ClassesView opens edit and staff dialogs', async () => {
    mock.onGet(LIST_URL).reply(200, [klass()])
    mock.onGet('/admin/staff-users/options').reply(200, [
      { id: 'u2', display_name: '陳老師' },
      { id: 'u3', display_name: '林老師' },
    ])
    const { wrapper } = await mountView()

    await clickIn(rowOf(wrapper, '低年級A班'), '編輯')
    expect(dialog().find('.el-dialog__title').text()).toBe('編輯班級')
    await clickIn(dialog().find('.el-dialog__footer'), '取消')

    await clickIn(rowOf(wrapper, '低年級A班'), '指派老師')
    expect(dialog().find('.el-dialog__title').text()).toBe('指派老師：低年級A班')
  })

  it('ClassesView shows retry on load failure', async () => {
    mock
      .onGet(LIST_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
      .onGet(LIST_URL)
      .replyOnce(200, [klass()])
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入班級')
    expect(wrapper.find('.el-table').exists()).toBe(false)
    expect(wrapper.find('[data-test=class-count]').exists()).toBe(false)

    await clickIn(wrapper, '重試')

    expect(listParams()).toHaveLength(2)
    expect(rows(wrapper)).toHaveLength(1)
  })

  it('ClassesView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.ClassesView()) as { default?: unknown }

    expect(loaded.default).toBe(ClassesView)
  })
})
