import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import type { BoardStudent, HomeworkBoard, HomeworkItem, Progress } from '@/api/homework'
import { adminHttp } from '@/api/http'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import HomeworkBatchAddDialog from '@/components/homework/HomeworkBatchAddDialog.vue'
import HomeworkItemDialog from '@/components/homework/HomeworkItemDialog.vue'
import ReadyEtaDialog from '@/components/homework/ReadyEtaDialog.vue'
import { createApiMock, mountWithApp } from '@/test/helpers'
import viewSource from './HomeworkBoardView.vue?raw'
import HomeworkBoardView from './HomeworkBoardView.vue'

const BOARD_URL = '/admin/homework/board'
const TODAY = '2026-10-02'
const WRITER = ['homework:read', 'homework:write']

const CLASSES = [
  { id: 'c1', name: '低年級A班', grade_levels: [1, 2], academic_year: 115, sort_order: 1, archived_at: null, student_count: 3, staff: [] },
  { id: 'c2', name: '中年級班', grade_levels: [3, 4], academic_year: 115, sort_order: 2, archived_at: null, student_count: 2, staff: [] },
]
const SUBJECTS = [
  { id: 'sub1', name: '國語', sort_order: 1, is_active: true },
  { id: 'sub2', name: '數學', sort_order: 2, is_active: true },
]

function item(overrides: Partial<HomeworkItem> = {}): HomeworkItem {
  return {
    id: 'h1',
    student_id: 's1',
    service_date: TODAY,
    subject_id: 'sub2',
    subject_name: '數學',
    title: '數學習作 p.12-13',
    status: 'todo',
    sort_order: 1,
    updated_at: '2026-10-02T06:00:00Z',
    ...overrides,
  }
}

function progress(studentId: string, overrides: Partial<Progress> = {}): Progress {
  return {
    student_id: studentId,
    service_date: TODAY,
    overall_status: 'not_started',
    ready_eta: null,
    note: null,
    eta_updated_at: null,
    eta_updated_by_name: null,
    ...overrides,
  }
}

function student(id: string, overrides: Partial<BoardStudent> = {}): BoardStudent {
  return {
    student_id: id,
    student_no: `S11${id.replace(/\D/g, '').padStart(3, '0')}`,
    name: '王小明',
    class_id: 'c1',
    class_name: '低年級A班',
    attendance_status: 'present',
    items: [],
    progress: progress(id),
    ...overrides,
  }
}

/** 王小明：一項未開始的作業 */
const WANG = student('s1', { name: '王小明', items: [item()] })
const LIN_LEAVE = student('s2', { name: '林小華', attendance_status: 'leave' })
const CHEN_ABSENT = student('s3', { name: '陳小美', attendance_status: 'absent' })
const LEE_DONE = student('s4', {
  name: '李承恩',
  items: [item({ id: 'h4', student_id: 's4', status: 'done', title: '國語習作' })],
  progress: progress('s4', { overall_status: 'done' }),
})
/** 張語晴：手動標記完成（項目推導不是 done） */
const CHANG_MANUAL = student('s5', {
  name: '張語晴',
  items: [item({ id: 'h5', student_id: 's5', status: 'todo', title: '英語聽寫' })],
  progress: progress('s5', { overall_status: 'done' }),
})
const HSU_C2 = student('s6', { name: '許家豪', class_id: 'c2', class_name: '中年級班' })

function board(students: BoardStudent[], overrides: Partial<HomeworkBoard> = {}): HomeworkBoard {
  return {
    date: TODAY,
    window: { past_days: 30, future_days: 7 },
    summary: { total: students.length, done: 0, in_progress: 0, not_started: 0 },
    students,
    ...overrides,
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountView(
  { permissions = WRITER, route = '/homework', deniedTopics = [] as string[] } = {},
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const { wrapper, router } = await mountWithApp(HomeworkBoardView, {
    initialRoute: route,
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'tutor01',
          display_name: '陳老師',
          role: { id: 'r-tutor', code: 'tutor', name: '課輔老師' },
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

function boardGets() {
  return mock.history.get.filter((r) => r.url === BOARD_URL)
}

function cardNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.hw-card__name').map((n) => n.text())
}

function card(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const c = wrapper.findAll('.hw-card').find((x) => x.find('.hw-card__name').text() === name)
  if (!c) throw new Error(`找不到 ${name} 的卡片`)
  return c
}

function button(wrapper: VueWrapper | DOMWrapper<Element>, text: string): DOMWrapper<HTMLButtonElement> | undefined {
  return wrapper.findAll<HTMLButtonElement>('button').find((b) => b.text().replace(/\s+/g, '') === text)
}

function statCard(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const c = wrapper.findAll('.stat-card[role=button]').find((x) => x.find('.stat-card__label').text() === label)
  if (!c) throw new Error(`找不到摘要卡 ${label}`)
  return c
}

/** 以觸發鈕的 aria-controls 找到對應的下拉選單並點選項目 */
async function pickMenu(trigger: DOMWrapper<Element>, label: string): Promise<void> {
  await trigger.trigger('click')
  await settle()
  const menu = document.getElementById(trigger.attributes('aria-controls') ?? '')
  const option = Array.from(menu?.querySelectorAll<HTMLElement>('.el-dropdown-menu__item') ?? []).find(
    (el) => el.textContent?.trim() === label,
  )
  if (!option) throw new Error(`選單沒有「${label}」`)
  option.click()
  await settle()
}

async function cardMenu(wrapper: VueWrapper, name: string, label: string): Promise<void> {
  await pickMenu(card(wrapper, name).find(`button[aria-label="${name} 的選項"]`), label)
}

async function itemMenu(wrapper: VueWrapper, name: string, label: string): Promise<void> {
  await pickMenu(card(wrapper, name).find('button[aria-label="作業選項"]'), label)
}

/** 目前打開的 dialog（標題以 prefix 開頭） */
function dialog(titlePrefix: string): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).find((d) =>
    d.querySelector('.el-dialog__title')?.textContent?.startsWith(titlePrefix),
  )
  if (!el) throw new Error(`沒有「${titlePrefix}」dialog`)
  return new DOMWrapper(el)
}

type DialogComponent = typeof ReadyEtaDialog | typeof HomeworkItemDialog | typeof HomeworkBatchAddDialog

/** happy-dom 不跑關閉動畫，開合以 dialog 元件的 modelValue 判斷 */
function isOpen(wrapper: VueWrapper, comp: DialogComponent): boolean {
  return wrapper.findComponent(comp).props('modelValue') === true
}

function formItem(dlg: DOMWrapper<Element>, label: string): DOMWrapper<Element> {
  const fi = dlg.findAll('.el-form-item').find((i) => i.find('.el-form-item__label').text().trim() === label)
  if (!fi) throw new Error(`找不到欄位 ${label}`)
  return fi
}

async function chooseOption(fi: DOMWrapper<Element>, label: string): Promise<void> {
  await fi.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = fi.find('input').attributes('aria-controls')
  const option = Array.from(
    document.getElementById(listId ?? '')?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [],
  ).find((o) => o.textContent?.trim() === label)
  if (!option) throw new Error(`找不到選項 ${label}`)
  option.click()
  await settle()
}

async function clickFooter(dlg: DOMWrapper<Element>, text: string): Promise<void> {
  const btn = dlg.findAll('.el-dialog__footer button').find((b) => b.text().replace(/\s+/g, '') === text)
  if (!btn) throw new Error(`footer 沒有「${text}」`)
  await btn.trigger('click')
  await settle()
  await settle()
}

async function clickMessageBox(text: string): Promise<void> {
  await settle()
  const btn = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.el-message-box button'))
    .filter((b) => b.textContent?.trim() === text)
    .at(-1)
  if (!btn) throw new Error(`確認框沒有「${text}」`)
  btn.click()
  await settle()
  await settle()
}

function body(method: 'post' | 'put' | 'patch', index = -1): unknown {
  const call = mock.history[method].at(index)
  if (!call) throw new Error(`沒有 ${method}`)
  return JSON.parse(call.data as string)
}

// 頁面含日期元件、兩個下拉、開關與多張帶 el-dropdown / 四段切換的卡片，happy-dom 下單一案例數秒，多 agent 並行時放寬逾時
describe('HomeworkBoardView', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 台北 2026-10-02 16:00
    vi.setSystemTime(new Date('2026-10-02T08:00:00Z'))
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/classes').reply(200, CLASSES)
    mock.onGet('/admin/subjects').reply(200, SUBJECTS)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('HomeworkBoardView loads board for today and class', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    const { wrapper } = await mountView({ route: '/homework?class_id=c1' })

    expect(boardGets()).toHaveLength(1)
    expect(boardGets()[0]?.params).toEqual({ date: TODAY, class_id: 'c1' })
    expect(cardNames(wrapper)).toEqual(['王小明'])
    // 選了班級不顯示分組標題
    expect(wrapper.find('.hw-group__title').exists()).toBe(false)
  })

  it('HomeworkBoardView groups cards by class when no class is selected', async () => {
    const b1 = student('s9', { name: '吳承翰', student_no: 'S11309' })
    const a1 = student('s7', { name: '周子晴', student_no: 'S11307' })
    mock.onGet(BOARD_URL).reply(200, board([b1, HSU_C2, a1]))
    const { wrapper, router } = await mountView()

    expect(boardGets()[0]?.params).toEqual({ date: TODAY })
    expect(wrapper.findAll('.hw-group__title').map((t) => t.text())).toEqual(['低年級A班（2）', '中年級班（1）'])
    // 組內依學號
    expect(cardNames(wrapper)).toEqual(['周子晴', '吳承翰', '許家豪'])

    await chooseOption(new DOMWrapper(wrapper.find('.hw-toolbar__class').element), '中年級班')
    expect(router.currentRoute.value.query).toEqual({ class_id: 'c2' })
    expect(boardGets().at(-1)?.params).toEqual({ date: TODAY, class_id: 'c2' })
  })

  it('HomeworkBoardView hides absent and leave students by default', async () => {
    const left = student('s8', { name: '吳伯伯孫', attendance_status: 'left' })
    mock.onGet(BOARD_URL).reply(200, board([WANG, LIN_LEAVE, CHEN_ABSENT, left]))
    const { wrapper } = await mountView()

    expect(cardNames(wrapper)).toEqual(['王小明'])

    await wrapper.find('.hw-toolbar__switch .el-switch').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toHaveLength(4)
    expect(localStorage.getItem('homework.hideAway')).toBe('false')

    // 偏好存在 localStorage：重新進頁沿用
    wrapper.unmount()
    const again = await mountView()
    expect(cardNames(again.wrapper)).toHaveLength(4)
  })

  it('HomeworkBoardView filters by summary card', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG, LEE_DONE, CHANG_MANUAL, LIN_LEAVE]))
    const { wrapper } = await mountView()
    const gets = boardGets().length

    // 摘要不計請假 / 缺席
    expect(statCard(wrapper, '全部').find('.stat-card__value').text()).toBe('3')
    expect(statCard(wrapper, '已完成').find('.stat-card__value').text()).toBe('2')

    await statCard(wrapper, '已完成').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toEqual(['李承恩', '張語晴'])
    expect(statCard(wrapper, '已完成').attributes('aria-pressed')).toBe('true')
    expect(boardGets()).toHaveLength(gets)

    // 再點一次回到全部
    await statCard(wrapper, '已完成').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toEqual(['王小明', '李承恩', '張語晴'])

    await statCard(wrapper, '尚未開始').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toEqual(['王小明'])
    await statCard(wrapper, '全部').trigger('click')
    await settle()
    expect(cardNames(wrapper)).toHaveLength(3)
  })

  it('HomeworkBoardView searches by name or student number', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG, LEE_DONE]))
    const { wrapper } = await mountView()
    await wrapper.find('.hw-toolbar__search input').setValue('承恩')
    await settle()
    expect(cardNames(wrapper)).toEqual(['李承恩'])
    await wrapper.find('.hw-toolbar__search input').setValue('s11001')
    await settle()
    expect(cardNames(wrapper)).toEqual(['王小明'])
  })

  it('HomeworkBoardView batch add requires class', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG, LIN_LEAVE]))
    const all = await mountView()
    expect(button(all.wrapper, '整班新增作業')?.element.disabled).toBe(true)
    all.wrapper.unmount()
    document.body.innerHTML = ''

    const { wrapper } = await mountView({ route: '/homework?class_id=c1' })
    const batch = button(wrapper, '整班新增作業')
    expect(batch?.element.disabled).toBe(false)
    await batch!.trigger('click')
    await settle()
    expect(isOpen(wrapper, HomeworkBatchAddDialog)).toBe(true)
    expect(dialog('整班新增作業：低年級A班').exists()).toBe(true)
  })

  it('HomeworkBoardView batch add submits and reloads', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG, LIN_LEAVE]))
    mock.onPost('/admin/homework/items/batch').reply(200, { created: 2, items: [] })
    const { wrapper } = await mountView({ route: '/homework?class_id=c1' })
    const gets = boardGets().length

    await button(wrapper, '整班新增作業')!.trigger('click')
    await settle()
    const dlg = dialog('整班新增作業')
    await formItem(dlg, '內容').find('input').setValue('國語第 5 課生字')
    await clickFooter(dlg, '新增給2位學生')

    expect(body('post')).toEqual({ class_id: 'c1', service_date: TODAY, title: '國語第 5 課生字' })
    expect(document.body.textContent).toContain('已新增給 2 位學生')
    expect(boardGets()).toHaveLength(gets + 1)
    expect(isOpen(wrapper, HomeworkBatchAddDialog)).toBe(false)
  })

  it('HomeworkBoardView readonly without write permission', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    const { wrapper } = await mountView({ permissions: ['homework:read'], route: '/homework?class_id=c1' })

    expect(button(wrapper, '整班新增作業')).toBeUndefined()
    expect(wrapper.text()).not.toContain('新增作業')
    const segs = card(wrapper, '王小明').findAll('.hw-seg__btn')
    expect(segs.length).toBe(4)
    expect(segs.every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    expect(card(wrapper, '王小明').find('button[aria-label="王小明 的選項"]').exists()).toBe(false)
  })

  it('HomeworkBoardView non-today notice', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    const { wrapper } = await mountView()
    expect(wrapper.text()).not.toContain('預計可接送時間只能設定今天')

    mock.onGet(BOARD_URL).reply(200, board([WANG], { date: '2026-10-01' }))
    wrapper.findComponent({ name: 'ElDatePicker' }).vm.$emit('update:modelValue', '2026-10-01')
    await settle()

    expect(wrapper.text()).toContain('檢視 2026-10-01：可修改作業項目，預計可接送時間只能設定今天')
    expect(boardGets().at(-1)?.params).toEqual({ date: '2026-10-01' })
    // 非今天：卡片沒有「設定預計可接送時間」的整列按鈕
    expect(wrapper.find('[aria-label="設定 王小明 的預計可接送時間"]').exists()).toBe(false)
  })

  it('HomeworkBoardView edit-eta saves ready eta and note', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    mock.onPut('/admin/homework/progress/s1').reply(200, progress('s1', { ready_eta: '17:30', note: '數學訂正中' }))
    const { wrapper } = await mountView()

    await cardMenu(wrapper, '王小明', '設定預計可接送時間')
    const dlg = dialog('預計可接送時間：王小明')
    await chooseOption(formItem(dlg, '預計可接送時間'), '17:30')
    await formItem(dlg, '給家長的說明').find('textarea').setValue('數學訂正中')
    await clickFooter(dlg, '儲存')

    expect(mock.history.put.map((c) => c.url)).toEqual(['/admin/homework/progress/s1'])
    expect(body('put')).toEqual({ service_date: TODAY, ready_eta: '17:30', note: '數學訂正中' })
    expect(card(wrapper, '王小明').text()).toContain('預計 17:30 可接送')
    expect(isOpen(wrapper, ReadyEtaDialog)).toBe(false)
  })

  it('HomeworkBoardView edit-eta keeps dialog open with error', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    mock.onPut('/admin/homework/progress/s1').reply(422, {
      error: { code: 'invalid_service_date', message: '只能設定今天的預計可接送時間', details: null },
    })
    const { wrapper } = await mountView()

    await card(wrapper, '王小明').find('[aria-label="設定 王小明 的預計可接送時間"]').trigger('click')
    await settle()
    const dlg = dialog('預計可接送時間：王小明')
    await chooseOption(formItem(dlg, '預計可接送時間'), '17:30')
    await clickFooter(dlg, '儲存')

    expect(isOpen(wrapper, ReadyEtaDialog)).toBe(true)
    expect(dialog('預計可接送時間').find('.el-alert--error').text()).toContain('只能設定今天的預計可接送時間')
  })

  it('HomeworkBoardView add-item creates homework item', async () => {
    const empty = student('s1', { name: '王小明' })
    const created = item({ id: 'h9', title: '數學習作 p.12-13', status: 'todo' })
    mock.onGet(BOARD_URL).reply(200, board([empty]))
    mock.onPost('/admin/homework/items').reply(201, { item: created, progress: progress('s1') })
    const { wrapper } = await mountView()
    expect(card(wrapper, '王小明').text()).toContain('今天沒有作業項目')

    await button(card(wrapper, '王小明'), '新增作業')!.trigger('click')
    await settle()
    const dlg = dialog('新增作業：王小明')
    await chooseOption(formItem(dlg, '科目'), '數學')
    await formItem(dlg, '內容').find('input').setValue('數學習作 p.12-13')
    await clickFooter(dlg, '儲存')

    expect(body('post')).toEqual({ student_id: 's1', service_date: TODAY, subject_id: 'sub2', title: '數學習作 p.12-13' })
    expect(card(wrapper, '王小明').text()).toContain('數學習作 p.12-13')
    expect(isOpen(wrapper, HomeworkItemDialog)).toBe(false)
  })

  it('HomeworkBoardView edit-item sends only changed fields', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    mock
      .onPatch('/admin/homework/items/h1')
      .reply(200, { item: item({ title: '數學習作 p.12-14' }), progress: progress('s1') })
    const { wrapper } = await mountView()

    await itemMenu(wrapper, '王小明', '編輯')
    let dlg = dialog('編輯作業：王小明')
    await formItem(dlg, '內容').find('input').setValue('數學習作 p.12-14')
    await clickFooter(dlg, '儲存')

    expect(mock.history.patch).toHaveLength(1)
    expect(body('patch')).toEqual({ title: '數學習作 p.12-14' })
    expect(card(wrapper, '王小明').text()).toContain('數學習作 p.12-14')
    expect(isOpen(wrapper, HomeworkItemDialog)).toBe(false)

    // 未修改直接儲存：不送請求、直接關閉
    await itemMenu(wrapper, '王小明', '編輯')
    dlg = dialog('編輯作業：王小明')
    await clickFooter(dlg, '儲存')
    expect(mock.history.patch).toHaveLength(1)
    expect(isOpen(wrapper, HomeworkItemDialog)).toBe(false)
  })

  it('HomeworkBoardView set-status patches item status', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    mock
      .onPatch('/admin/homework/items/h1')
      .reply(200, { item: item({ status: 'done' }), progress: progress('s1', { overall_status: 'done' }) })
    const { wrapper } = await mountView()

    const done = card(wrapper, '王小明')
      .findAll('.hw-seg__btn')
      .find((b) => b.text() === '完成')
    await done!.trigger('click')
    await settle()

    expect(mock.history.patch.map((c) => c.url)).toEqual(['/admin/homework/items/h1'])
    expect(body('patch')).toEqual({ status: 'done' })
    expect(card(wrapper, '王小明').find('.hw-seg__btn.is-active').text()).toBe('完成')
  })

  it('HomeworkBoardView remove-item confirms before delete', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    mock.onDelete('/admin/homework/items/h1').reply(200, { item: null, progress: progress('s1') })
    const { wrapper } = await mountView()

    await itemMenu(wrapper, '王小明', '刪除')
    expect(document.body.textContent).toContain('確定要刪除作業「數學習作 p.12-13」嗎？')
    await clickMessageBox('取消')
    expect(mock.history.delete).toHaveLength(0)
    expect(card(wrapper, '王小明').text()).toContain('數學習作 p.12-13')

    await itemMenu(wrapper, '王小明', '刪除')
    await clickMessageBox('刪除')
    expect(mock.history.delete.map((c) => c.url)).toEqual(['/admin/homework/items/h1'])
    expect(card(wrapper, '王小明').text()).not.toContain('數學習作 p.12-13')
    expect(card(wrapper, '王小明').text()).toContain('今天沒有作業項目')
  })

  it('HomeworkBoardView set-overall updates progress', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG, CHANG_MANUAL]))
    mock.onPut('/admin/homework/progress/s1').reply(200, progress('s1', { overall_status: 'done' }))
    mock.onPut('/admin/homework/progress/s5').reply(200, progress('s5', { overall_status: 'not_started' }))
    const { wrapper } = await mountView()

    await cardMenu(wrapper, '王小明', '標記整體完成')
    expect(mock.history.put.at(-1)?.url).toBe('/admin/homework/progress/s1')
    expect(body('put')).toEqual({ service_date: TODAY, overall: 'done' })
    expect(card(wrapper, '王小明').text()).toContain('已完成')

    await cardMenu(wrapper, '張語晴', '改回依項目判斷')
    expect(mock.history.put.at(-1)?.url).toBe('/admin/homework/progress/s5')
    expect(body('put')).toEqual({ service_date: TODAY, overall: 'auto' })
    expect(card(wrapper, '張語晴').text()).not.toContain('手動標記')
  })

  it('HomeworkBoardView date range follows board window', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.onGet(BOARD_URL).reply(async () => {
      await gate
      return [200, board([WANG], { window: { past_days: 10, future_days: 3 } })]
    })
    const { wrapper } = await mountView()
    const disabledDate = (): ((d: Date) => boolean) =>
      wrapper.findComponent({ name: 'ElDatePicker' }).props('disabledDate') as (d: Date) => boolean

    // 首次載入前：預設 30 / 7
    expect(disabledDate()(new Date(2026, 8, 2))).toBe(false)
    expect(disabledDate()(new Date(2026, 8, 1))).toBe(true)
    expect(disabledDate()(new Date(2026, 9, 9))).toBe(false)
    expect(disabledDate()(new Date(2026, 9, 10))).toBe(true)

    release()
    await settle()

    expect(disabledDate()(new Date(2026, 8, 22))).toBe(false)
    expect(disabledDate()(new Date(2026, 9, 5))).toBe(false)
    expect(disabledDate()(new Date(2026, 8, 21))).toBe(true)
    expect(disabledDate()(new Date(2026, 9, 6))).toBe(true)

    // 範圍外的日期（例如鍵盤輸入）不切換
    const gets = boardGets().length
    wrapper.findComponent({ name: 'ElDatePicker' }).vm.$emit('update:modelValue', '2026-10-06')
    await settle()
    expect(boardGets()).toHaveLength(gets)
  })

  it('HomeworkBoardView shows empty and error states', async () => {
    mock.onGet(BOARD_URL).reply(200, board([]))
    const oneClass = await mountView({ route: '/homework?class_id=c1' })
    expect(oneClass.wrapper.text()).toContain('低年級A班 目前沒有在學學生')
    oneClass.wrapper.unmount()
    document.body.innerHTML = ''

    const all = await mountView()
    expect(all.wrapper.text()).toContain('沒有學生資料')
    all.wrapper.unmount()
    document.body.innerHTML = ''

    // 有資料但被篩掉：inline 提示 +「清除篩選」
    mock.onGet(BOARD_URL).reply(200, board([LIN_LEAVE]))
    const filtered = await mountView()
    expect(filtered.wrapper.text()).toContain('沒有符合條件的學生')
    await button(filtered.wrapper, '清除篩選')!.trigger('click')
    await settle()
    expect(cardNames(filtered.wrapper)).toEqual(['林小華'])
    filtered.wrapper.unmount()
    document.body.innerHTML = ''

    mock.onGet(BOARD_URL).reply(500, { error: { code: 'internal_error', message: '伺服器忙碌中', details: null } })
    const failed = await mountView()
    expect(failed.wrapper.text()).toContain('無法載入作業進度')
    const gets = boardGets().length
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    await button(failed.wrapper, '重試')!.trigger('click')
    await settle()
    expect(boardGets()).toHaveLength(gets + 1)
    expect(cardNames(failed.wrapper)).toEqual(['王小明'])
  })

  it('HomeworkBoardView warns when realtime topic is denied', async () => {
    mock.onGet(BOARD_URL).reply(200, board([WANG]))
    const { wrapper } = await mountView({ deniedTopics: ['homework'] })
    expect(wrapper.text()).toContain('沒有即時更新權限，請手動重新整理')
    const gets = boardGets().length
    await button(wrapper, '重新整理')!.trigger('click')
    await settle()
    expect(boardGets()).toHaveLength(gets + 1)
  })

  it('HomeworkBoardView sizes date picker through toolbar deep selector', () => {
    // el-date-picker 的根節點不帶本元件的 scoped 屬性：寬度規則要從工具列以 :deep() 選取才會生效（稿：日期 190px，
    // 平板 1024 寬時篩選列維持單行）。happy-dom 不計算版面，以原始碼斷言規則。
    expect(viewSource).toMatch(/\.hw-toolbar\s+:deep\(\.hw-toolbar__date\.el-date-editor\)\s*{[^}]*width:\s*190px/)
    // 根節點高度也要 44px：只有內層 wrapper 44px 時會溢出根節點，比同列其他控制項低 6px
    expect(viewSource).toMatch(/\.hw-toolbar\s+:deep\(\.hw-toolbar__date\.el-date-editor\)\s*{[^}]*height:\s*44px/)
    expect(viewSource).not.toMatch(/(^|\n)\.hw-toolbar__date\s*{/)
  })

  it('HomeworkBoardView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.HomeworkBoardView()) as unknown as { default?: unknown }
    expect(loaded.default ?? loaded).toBe(HomeworkBoardView)
  })
})
