import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { Exam, ScoreCell, ScoreGrid as ScoreGridData, ScoreGridStudent } from '@/api/exams'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import RenotifyChoiceDialog from './RenotifyChoiceDialog.vue'
import ScoreGrid from './ScoreGrid.vue'

const GRID_URL = '/admin/exams/e1/scores'
const RESULT = { written: 1, changed: 1, renotified_students: 0 }

const EXAM: Exam = {
  id: 'e1',
  name: '第一次段考',
  exam_type: { id: 't1', name: '段考' },
  exam_date: '2026-10-15',
  grade_level: 3,
  class: null,
  status: 'draft',
  published_at: null,
  published_by_name: null,
  note: null,
  subjects: [],
  roster_count: 2,
  created_at: '2026-09-20T02:00:00Z',
}

const WANG: ScoreGridStudent = { id: 's1', student_no: 'S11301', name: '王小明', class_name: '中年級班', in_roster: true }
const LIN: ScoreGridStudent = { id: 's2', student_no: 'S11302', name: '林小華', class_name: '中年級班', in_roster: false }
const CHEN: ScoreGridStudent = { id: 's3', student_no: 'S11305', name: '陳小美', class_name: '中年級班', in_roster: true }

const SUBJECTS = [
  { subject_id: 'sub1', subject_name: '國語', full_score: 100, sort_order: 1 },
  { subject_id: 'sub2', subject_name: '數學', full_score: 100, sort_order: 2 },
]

function cell(studentId: string, subjectId: string, overrides: Partial<ScoreCell> = {}): ScoreCell {
  return {
    student_id: studentId,
    subject_id: subjectId,
    score: null,
    is_absent: false,
    note: null,
    updated_at: '2026-10-15T01:00:00Z',
    ...overrides,
  }
}

function grid(overrides: Partial<ScoreGridData> = {}): ScoreGridData {
  return {
    exam: { ...EXAM, subjects: SUBJECTS },
    students: [WANG, LIN],
    subjects: SUBJECTS,
    cells: [cell('s1', 'sub1', { score: 95 })],
    ...overrides,
  }
}

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [{ path: '/exams/:id', component: Stub }]

let mock: MockAdapter

/** 推進 fake timers 並清空 promise（debounce、axios 回應、Element Plus 的 setTimeout） */
async function tick(ms = 0): Promise<void> {
  await nextTick()
  await vi.advanceTimersByTimeAsync(ms)
  await flushPromises()
  await nextTick()
}

async function mountGrid(opts: { canWrite?: boolean; data?: ScoreGridData; attach?: boolean } = {}) {
  mock.onGet(GRID_URL).reply(200, opts.data ?? grid())
  const mounted = await mountWithApp(ScoreGrid, {
    props: { examId: 'e1', canWrite: opts.canWrite ?? true },
    routes: ROUTES,
    initialRoute: '/exams/e1?tab=scores',
  })
  if (opts.attach) document.body.appendChild(mounted.wrapper.element)
  await tick()
  await tick()
  return { wrapper: mounted.wrapper as VueWrapper, router: mounted.router }
}

function cellAt(wrapper: VueWrapper, row: number, col: number): DOMWrapper<Element> {
  const el = wrapper.find(`.sg-cell[data-row="${row}"][data-col="${col}"]`)
  if (!el.exists()) throw new Error(`找不到格子 ${row},${col}`)
  return el
}

function scoreInput(wrapper: VueWrapper, row: number, col: number): HTMLInputElement {
  return cellAt(wrapper, row, col).find('input[inputmode=decimal]').element as HTMLInputElement
}

function absentInput(wrapper: VueWrapper, row: number, col: number): HTMLInputElement {
  return cellAt(wrapper, row, col).find('.score-cell__absent input[type=checkbox]').element as HTMLInputElement
}

async function typeAndBlur(wrapper: VueWrapper, row: number, col: number, value: string): Promise<void> {
  const input = cellAt(wrapper, row, col).find('input[inputmode=decimal]')
  await input.setValue(value)
  await input.trigger('blur')
  await tick()
}

async function press(el: Element, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  await tick()
  return event
}

function putBodies(): { cells: unknown[]; notify_parents: boolean }[] {
  return mock.history.put.map((c) => JSON.parse(c.data as string))
}

function toolbarText(wrapper: VueWrapper): string {
  return wrapper.find('.grid-toolbar').text()
}

function dialogOpen(wrapper: VueWrapper): boolean {
  return wrapper.findComponent(RenotifyChoiceDialog).props('modelValue') as boolean
}

function dirtyChanges(wrapper: VueWrapper): unknown[][] {
  return wrapper.emitted('dirty-change') ?? []
}

describe('ScoreGrid', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('ScoreGrid renders students by subjects with existing scores', async () => {
    const { wrapper } = await mountGrid()

    expect(mock.history.get.map((c) => c.url)).toEqual([GRID_URL])
    const headers = wrapper.findAll('.el-table__header th').map((th) => th.text())
    expect(headers).toEqual(['學號', '姓名', '班級', '國語（滿分 100）', '數學（滿分 100）'])
    expect(wrapper.find('.sg-head__full').text()).toBe('（滿分 100）')
    expect(scoreInput(wrapper, 0, 0).value).toBe('95')
    expect(scoreInput(wrapper, 0, 1).value).toBe('')

    const rows = wrapper.findAll('.el-table__body tr.el-table__row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('王小明')
    expect(rows[0]?.text()).not.toContain('已不在名單')
    expect(rows[1]?.text()).toContain('林小華')
    expect(rows[1]?.text()).toContain('已不在名單')
    expect(rows[1]?.classes()).toContain('row-out')
    expect(rows[0]?.classes()).not.toContain('row-out')
    // 草稿考試：工具列沒有通知切換，提示鍵盤操作
    expect(toolbarText(wrapper)).toContain('所有變更已儲存')
    expect(toolbarText(wrapper)).toContain('Shift')
    expect(toolbarText(wrapper)).not.toContain('修改後通知家長')
  })

  it('ScoreGrid enter moves to next row same subject', async () => {
    const { wrapper } = await mountGrid({ attach: true })
    const wang = scoreInput(wrapper, 0, 0)
    wang.focus()

    const event = await press(wang, { key: 'Enter' })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(scoreInput(wrapper, 1, 0))
    // ↑ 回上一列；在最後一列按 Enter 停在原格
    await press(scoreInput(wrapper, 1, 0), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(wang)
    await press(wang, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(scoreInput(wrapper, 1, 0))
    await press(scoreInput(wrapper, 1, 0), { key: 'Enter' })
    expect(document.activeElement).toBe(scoreInput(wrapper, 1, 0))
  })

  it('ScoreGrid autosaves edited cell', async () => {
    mock.onPut(GRID_URL).reply(200, RESULT)
    const { wrapper } = await mountGrid()

    await typeAndBlur(wrapper, 0, 1, '88')
    expect(toolbarText(wrapper)).toContain('1 格尚未儲存')
    await tick(799)
    expect(mock.history.put).toHaveLength(0)
    await tick(1)

    expect(mock.history.put).toHaveLength(1)
    expect(putBodies()[0]).toEqual({
      cells: [{ student_id: 's1', subject_id: 'sub2', score: 88, is_absent: false, note: null }],
      notify_parents: false,
    })
    expect(toolbarText(wrapper)).toContain('所有變更已儲存')
    expect(scoreInput(wrapper, 0, 1).value).toBe('88')
  })

  it('ScoreGrid readonly without write permission', async () => {
    const { wrapper } = await mountGrid({
      canWrite: false,
      data: grid({ exam: { ...EXAM, status: 'published', subjects: SUBJECTS } }),
    })

    const inputs = wrapper.findAll('input')
    expect(inputs.every((i) => {
      const el = i.element as HTMLInputElement
      return el.readOnly || el.disabled
    })).toBe(true)
    expect(wrapper.findAll('input[inputmode=decimal]')).toHaveLength(0)
    expect(wrapper.find('.grid-toolbar').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('修改後通知家長')
    expect(cellAt(wrapper, 0, 0).text()).toBe('95')
    expect(cellAt(wrapper, 0, 1).text()).toBe('—')
  })

  it('ScoreGrid empty states', async () => {
    const writer = await mountGrid({ data: grid({ subjects: [], cells: [] }) })
    expect(writer.wrapper.text()).toContain('尚未設定科目')
    expect(writer.wrapper.text()).toContain('設定考試科目與滿分後才能輸入成績')
    const go = writer.wrapper.findAll('button').find((b) => b.text() === '前往科目設定')
    expect(go).toBeDefined()
    await go!.trigger('click')
    await tick()
    expect(writer.router.currentRoute.value.query.tab).toBe('subjects')
    expect(writer.router.currentRoute.value.path).toBe('/exams/e1')
    writer.wrapper.unmount()

    const reader = await mountGrid({ canWrite: false, data: grid({ subjects: [], cells: [] }) })
    expect(reader.wrapper.text()).toContain('有成績編輯權限的人設定科目後，這裡才會出現成績表')
    expect(reader.wrapper.findAll('button').map((b) => b.text())).not.toContain('前往科目設定')
    reader.wrapper.unmount()

    const noStudents = await mountGrid({ data: grid({ students: [], cells: [] }) })
    expect(noStudents.wrapper.text()).toContain('此考試沒有應考學生，請確認年級或班級設定')
  })

  it('ScoreGrid reports unsaved state', async () => {
    mock.onPut(GRID_URL).reply(200, RESULT)
    const { wrapper } = await mountGrid()
    expect(dirtyChanges(wrapper)).toEqual([])

    await typeAndBlur(wrapper, 0, 1, '88')
    expect(dirtyChanges(wrapper).at(-1)).toEqual([true])
    expect((wrapper.vm as unknown as { hasUnsaved: boolean }).hasUnsaved).toBe(true)

    await tick(800)
    expect(mock.history.put).toHaveLength(1)
    expect(dirtyChanges(wrapper).at(-1)).toEqual([false])
    expect((wrapper.vm as unknown as { hasUnsaved: boolean }).hasUnsaved).toBe(false)
  })

  it('ScoreGrid reopens renotify dialog after dismiss', async () => {
    mock.onPut(GRID_URL).reply(200, RESULT)
    const { wrapper } = await mountGrid({
      attach: true,
      data: grid({ exam: { ...EXAM, status: 'published', subjects: SUBJECTS } }),
    })
    expect(toolbarText(wrapper)).toContain('修改後通知家長')
    expect(toolbarText(wrapper)).toContain('尚未選擇')
    expect(dialogOpen(wrapper)).toBe(false)

    await typeAndBlur(wrapper, 0, 1, '88')
    await tick(800)
    expect(dialogOpen(wrapper)).toBe(true)
    expect(document.body.textContent).toContain('目前有 1 格等待儲存')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
    await tick()
    expect(dialogOpen(wrapper)).toBe(false)
    expect(mock.history.put).toHaveLength(0)
    expect(toolbarText(wrapper)).toContain('尚未選擇')
    expect(toolbarText(wrapper)).toContain('1 格尚未儲存')

    await typeAndBlur(wrapper, 1, 1, '70')
    await tick(800)
    expect(dialogOpen(wrapper)).toBe(true)
    expect(mock.history.put).toHaveLength(0)

    // 在工具列直接選「開」：立即送出兩格並帶 notify_parents true
    const on = wrapper.findAll('.grid-toolbar .el-radio-button').find((b) => b.text() === '開')
    expect(on).toBeDefined()
    await on!.find('input').setValue(true)
    await tick()
    expect(mock.history.put).toHaveLength(1)
    expect(putBodies()[0]?.notify_parents).toBe(true)
    expect(putBodies()[0]?.cells).toHaveLength(2)
    expect(toolbarText(wrapper)).not.toContain('尚未選擇')
  })

  it('ScoreGrid keyboard wraps rows and respects caret', async () => {
    const { wrapper } = await mountGrid({ attach: true })

    const wangMath = scoreInput(wrapper, 0, 1)
    wangMath.focus()
    await press(wangMath, { key: 'Tab' })
    expect(document.activeElement).toBe(scoreInput(wrapper, 1, 0))

    await press(scoreInput(wrapper, 1, 0), { key: 'Enter', shiftKey: true })
    const wangChinese = scoreInput(wrapper, 0, 0)
    expect(document.activeElement).toBe(wangChinese)
    // 移入的格子全選內容
    expect([wangChinese.selectionStart, wangChinese.selectionEnd]).toEqual([0, 2])

    wangChinese.setSelectionRange(0, 0)
    const stay = await press(wangChinese, { key: 'ArrowRight' })
    expect(stay.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(wangChinese)
    wangChinese.setSelectionRange(2, 2)
    await press(wangChinese, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(wangMath)
    wangMath.setSelectionRange(0, 0)
    await press(wangMath, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(wangChinese)

    // Shift+Tab 從第一科回到上一列最後一科；表格第一格的 Shift+Tab 與最後一格的 Tab 交給瀏覽器
    await press(scoreInput(wrapper, 1, 0), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(wangMath)
    const first = await press(wangChinese, { key: 'Tab', shiftKey: true })
    expect(first.defaultPrevented).toBe(false)
    const last = await press(scoreInput(wrapper, 1, 1), { key: 'Tab' })
    expect(last.defaultPrevented).toBe(false)
    wrapper.unmount()
    document.body.innerHTML = ''

    const absent = await mountGrid({
      attach: true,
      data: grid({ students: [WANG, CHEN], cells: [cell('s1', 'sub1', { score: 95 }), cell('s3', 'sub1', { is_absent: true })] }),
    })
    expect(scoreInput(absent.wrapper, 1, 0).disabled).toBe(true)
    const from = scoreInput(absent.wrapper, 0, 0)
    from.focus()
    await press(from, { key: 'Enter' })
    expect(document.activeElement).toBe(absentInput(absent.wrapper, 1, 0))
  })

  it('ScoreGrid escape reverts typing', async () => {
    mock.onPut(GRID_URL).reply(200, RESULT)
    const { wrapper } = await mountGrid({ attach: true })
    const input = cellAt(wrapper, 0, 0).find('input[inputmode=decimal]')
    ;(input.element as HTMLInputElement).focus()
    await input.setValue('70')

    await press(input.element, { key: 'Escape' })

    const after = scoreInput(wrapper, 0, 0)
    expect(after.value).toBe('95')
    expect(document.activeElement).toBe(after)
    await tick(2000)
    expect(mock.history.put).toHaveLength(0)
    expect(dirtyChanges(wrapper)).not.toContainEqual([true])
    expect(toolbarText(wrapper)).toContain('所有變更已儲存')
  })

  it('ScoreGrid exposes failure count', async () => {
    mock.onPut(GRID_URL).networkErrorOnce().onPut(GRID_URL).reply(200, RESULT)
    const { wrapper } = await mountGrid()
    const vm = wrapper.vm as unknown as { failedCount: number; hasUnsaved: boolean }

    await typeAndBlur(wrapper, 0, 1, '88')
    await tick(800)

    expect(vm.failedCount).toBe(1)
    expect(vm.hasUnsaved).toBe(true)
    expect(toolbarText(wrapper)).toContain('1 格儲存失敗')
    const retry = wrapper.findAll('.grid-toolbar button').find((b) => b.text() === '重試')
    expect(retry).toBeDefined()
    await retry!.trigger('click')
    await tick()

    expect(mock.history.put).toHaveLength(2)
    expect(vm.failedCount).toBe(0)
    expect(vm.hasUnsaved).toBe(false)
    expect(toolbarText(wrapper)).toContain('所有變更已儲存')
  })

  it('ScoreGrid autosaves note edits', async () => {
    mock.onPut(GRID_URL).reply(200, RESULT)
    const { wrapper } = await mountGrid()

    await cellAt(wrapper, 0, 0).find('[data-test=note-trigger]').trigger('click')
    await tick()
    const textarea = document.body.querySelector<HTMLTextAreaElement>('[data-test=note-input]')
    expect(textarea).not.toBeNull()
    textarea!.value = '補考'
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.note-editor button')).find(
      (b) => b.textContent?.trim() === '確定',
    )
    confirm!.click()
    await tick()
    await tick(800)

    expect(putBodies()).toEqual([
      {
        cells: [{ student_id: 's1', subject_id: 'sub1', score: 95, is_absent: false, note: '補考' }],
        notify_parents: false,
      },
    ])
  })

  it('ScoreGrid note trigger click keeps editor focus', async () => {
    const { wrapper } = await mountGrid({ attach: true })
    const wang = scoreInput(wrapper, 0, 0)
    let wangFocused = 0
    wang.addEventListener('focus', () => {
      wangFocused += 1
    })

    await cellAt(wrapper, 0, 0).find('[data-test=note-trigger]').trigger('click')
    await tick()

    const textarea = document.body.querySelector<HTMLTextAreaElement>('[data-test=note-input]')
    expect(textarea).not.toBeNull()
    expect(document.activeElement).toBe(textarea)
    // 點備註圖示不會先把焦點搶到分數輸入框
    expect(wangFocused).toBe(0)

    // 編輯框內的 Esc 只關閉備註，不觸發格子的 Esc 還原
    await press(textarea!, { key: 'Escape' })
    expect(document.body.querySelector('[data-test=note-input]')).toBeNull()

    // 點林小華國語格的空白處（不是輸入框或「缺」）→ 聚焦該格分數輸入框
    await cellAt(wrapper, 1, 0).trigger('click')
    await tick()
    expect(document.activeElement).toBe(scoreInput(wrapper, 1, 0))
  })
})
