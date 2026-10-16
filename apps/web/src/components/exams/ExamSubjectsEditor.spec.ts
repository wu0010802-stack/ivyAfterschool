import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { Exam, ExamSubject } from '@/api/exams'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import ExamSubjectsEditor from './ExamSubjectsEditor.vue'

const SUBJECTS = [
  { id: 'sub1', name: '國語', sort_order: 1, is_active: true },
  { id: 'sub2', name: '數學', sort_order: 2, is_active: true },
  { id: 'sub3', name: '英語', sort_order: 3, is_active: true },
  { id: 'sub4', name: '自然', sort_order: 4, is_active: true },
  { id: 'sub5', name: '社會', sort_order: 5, is_active: true },
]

function subj(id: string, name: string, fullScore: number, sortOrder: number): ExamSubject {
  return { subject_id: id, subject_name: name, full_score: fullScore, sort_order: sortOrder }
}

const TWO: ExamSubject[] = [subj('sub1', '國語', 100, 1), subj('sub2', '數學', 100, 2)]

function makeExam(overrides: Partial<Exam> = {}): Exam {
  return {
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
    subjects: TWO,
    roster_count: 32,
    created_at: '2026-09-20T02:00:00Z',
    ...overrides,
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountEditor(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(ExamSubjectsEditor, {
    props: { exam: makeExam(), scoredCounts: {}, canWrite: true, ...props },
  })
  await settle()
  await settle()
  return wrapper as VueWrapper
}

function rows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.subj-row')
}

/** 以下拉目前顯示的科目名稱找列（「社會（已停用）」也以「社會」開頭） */
function rowOf(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const row = rows(wrapper).find((r) => r.find('.el-select__placeholder').text().trim().startsWith(name))
  if (!row) throw new Error(`找不到科目列 ${name}`)
  return row
}

function rowNames(wrapper: VueWrapper): string[] {
  return rows(wrapper).map((r) => r.find('.el-select__placeholder').text().trim())
}

async function clickIn(root: VueWrapper | DOMWrapper<Element>, text: string): Promise<void> {
  const btn = root.findAll('button').find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  await btn.trigger('click')
  await settle()
  await settle()
}

function buttonIn(root: VueWrapper | DOMWrapper<Element>, text: string): DOMWrapper<Element> | undefined {
  return root.findAll('button').find((b) => b.text() === text)
}

async function setFullScore(row: DOMWrapper<Element>, value: string): Promise<void> {
  const input = row.find('.el-input-number input')
  await input.setValue(value)
  await input.trigger('change')
  await settle()
}

function lastMessageBox(): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
}

async function clickInMessageBox(text: string): Promise<void> {
  const btn = Array.from(lastMessageBox()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`message box 找不到「${text}」`)
  btn.click()
  await settle()
  await settle()
}

function putBodies(): unknown[] {
  return mock.history.put.map((c) => JSON.parse(c.data as string))
}

describe('ExamSubjectsEditor', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/subjects').reply(200, SUBJECTS)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('ExamSubjectsEditor saves reordered subjects', async () => {
    const saved = makeExam({ subjects: [subj('sub2', '數學', 100, 1), subj('sub1', '國語', 120, 2)] })
    mock.onPut('/admin/exams/e1/subjects').reply(200, saved)
    const wrapper = await mountEditor()

    expect(wrapper.text()).toContain('科目順序就是成績表與家長端的顯示順序；移除科目會一併刪除該科已輸入的成績。')
    expect(rowNames(wrapper)).toEqual(['國語', '數學'])
    expect(wrapper.text()).toContain('2 / 20')
    // 沒有變更時「儲存」停用、「還原變更」不出現
    expect(buttonIn(wrapper, '儲存')?.attributes('disabled')).toBeDefined()
    expect(buttonIn(wrapper, '還原變更')).toBeUndefined()

    await clickIn(rowOf(wrapper, '數學'), '上移')
    expect(rowNames(wrapper)).toEqual(['數學', '國語'])
    await setFullScore(rowOf(wrapper, '國語'), '120')
    expect(buttonIn(wrapper, '還原變更')).toBeDefined()
    expect(buttonIn(wrapper, '儲存')?.attributes('disabled')).toBeUndefined()
    await clickIn(wrapper, '儲存')

    expect(putBodies()).toEqual([
      {
        items: [
          { subject_id: 'sub2', full_score: 100, sort_order: 1 },
          { subject_id: 'sub1', full_score: 120, sort_order: 2 },
        ],
      },
    ])
    expect(document.body.textContent).toContain('已儲存科目設定')
    expect(wrapper.emitted('saved')).toEqual([[saved]])
    expect(wrapper.emitted('conflict')).toBeUndefined()
  })

  it('ExamSubjectsEditor confirms removal of scored subject', async () => {
    mock.onPut('/admin/exams/e1/subjects').reply(200, makeExam({ subjects: [subj('sub2', '數學', 100, 1)] }))
    const wrapper = await mountEditor({ scoredCounts: { sub1: 18 } })

    expect(rowOf(wrapper, '國語').text()).toContain('18 筆')
    expect(rowOf(wrapper, '數學').text()).toContain('—')
    await clickIn(rowOf(wrapper, '國語'), '移除')
    expect(rowNames(wrapper)).toEqual(['數學'])
    await clickIn(wrapper, '儲存')

    expect(document.body.textContent).toContain('移除「國語」會刪除已輸入的 18 筆成績，確定嗎？')
    await clickInMessageBox('取消')
    expect(mock.history.put).toHaveLength(0)
    expect(wrapper.emitted('saved')).toBeUndefined()

    await clickIn(wrapper, '儲存')
    await clickInMessageBox('移除並儲存')
    expect(putBodies()).toEqual([{ items: [{ subject_id: 'sub2', full_score: 100, sort_order: 1 }] }])
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('ExamSubjectsEditor readonly when published', async () => {
    const wrapper = await mountEditor({
      exam: makeExam({ status: 'published', published_at: '2026-10-05T09:00:00Z', published_by_name: '張主任' }),
      scoredCounts: { sub1: 30 },
    })

    expect(wrapper.text()).toContain('已發布的考試不可修改科目')
    expect(buttonIn(wrapper, '新增科目')).toBeUndefined()
    expect(buttonIn(wrapper, '儲存')).toBeUndefined()
    expect(wrapper.find('.el-select').exists()).toBe(false)
    const cells = wrapper.findAll('.el-table__body tr').map((r) => r.findAll('td').map((c) => c.text()))
    expect(cells).toEqual([
      ['1', '國語', '100', '30 筆'],
      ['2', '數學', '100', '—'],
    ])

    // 草稿但沒有 exams:write：唯讀表、沒有已發布的提示
    const viewer = await mountEditor({ canWrite: false })
    expect(viewer.text()).not.toContain('已發布的考試不可修改科目')
    expect(buttonIn(viewer, '新增科目')).toBeUndefined()
    expect(viewer.findAll('.el-table__body tr')).toHaveLength(2)
  })

  it('ExamSubjectsEditor shows full score conflict', async () => {
    mock.onPut('/admin/exams/e1/subjects').reply(409, {
      error: {
        code: 'full_score_below_existing',
        message: '滿分不可低於已登記的最高分',
        details: { subject_id: 'sub1', max_score: 95 },
      },
    })
    const wrapper = await mountEditor()

    await setFullScore(rowOf(wrapper, '國語'), '90')
    await clickIn(wrapper, '儲存')

    expect(putBodies()).toEqual([
      {
        items: [
          { subject_id: 'sub1', full_score: 90, sort_order: 1 },
          { subject_id: 'sub2', full_score: 100, sort_order: 2 },
        ],
      },
    ])
    expect(rowOf(wrapper, '國語').text()).toContain('滿分不可低於已輸入的最高分（目前最高 95 分）')
    expect(rowOf(wrapper, '國語').classes()).toContain('is-error-full')
    expect(rowOf(wrapper, '數學').classes()).not.toContain('is-error-full')
    expect(wrapper.emitted('saved')).toBeUndefined()

    // 改回滿分後列錯誤消失
    await setFullScore(rowOf(wrapper, '國語'), '100')
    expect(rowOf(wrapper, '國語').classes()).not.toContain('is-error-full')
  })

  it('ExamSubjectsEditor empty guidance', async () => {
    const wrapper = await mountEditor({ exam: makeExam({ subjects: [] }) })

    expect(wrapper.text()).toContain('尚未設定科目，請新增後才能輸入成績')
    expect(wrapper.text()).toContain('0 / 20')
    expect(buttonIn(wrapper, '儲存')?.attributes('disabled')).toBeDefined()

    await clickIn(wrapper, '新增科目')
    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.text()).not.toContain('尚未設定科目，請新增後才能輸入成績')
    expect((rowOf(wrapper, '選擇科目').find('.el-input-number input').element as HTMLInputElement).value).toBe('100')
  })

  it('ExamSubjectsEditor blocks empty list and caps at twenty', async () => {
    const wrapper = await mountEditor({ exam: makeExam({ subjects: [subj('sub1', '國語', 100, 1)] }) })

    await clickIn(rowOf(wrapper, '國語'), '移除')
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('考試至少要有一個科目：請新增科目，或按「還原變更」')
    expect(buttonIn(wrapper, '儲存')?.attributes('disabled')).toBeDefined()
    await clickIn(wrapper, '儲存')
    expect(mock.history.put).toHaveLength(0)
    await clickIn(wrapper, '還原變更')
    expect(rowNames(wrapper)).toEqual(['國語'])
    expect(buttonIn(wrapper, '儲存')?.attributes('disabled')).toBeDefined()

    const twenty = Array.from({ length: 20 }, (_, i) => subj(`s${i + 1}`, `科目${i + 1}`, 100, i + 1))
    mock.onGet('/admin/subjects').reply(
      200,
      twenty.map((s, i) => ({ id: s.subject_id, name: s.subject_name, sort_order: i + 1, is_active: true })),
    )
    const full = await mountEditor({ exam: makeExam({ subjects: twenty }) })
    expect(full.text()).toContain('20 / 20')
    expect(buttonIn(full, '新增科目')?.attributes('disabled')).toBeDefined()
    // 20 列 × 20 個 el-option 的掛載在共用 CPU 下可能超過預設 5 秒
  }, 20000)

  it('ExamSubjectsEditor conflict and invalid subject', async () => {
    mock.onPut('/admin/exams/e1/subjects').reply(409, {
      error: { code: 'exam_published', message: '考試已發布，請先取消發布再修改', details: null },
    })
    const wrapper = await mountEditor()

    await setFullScore(rowOf(wrapper, '國語'), '120')
    await clickIn(wrapper, '儲存')

    expect(wrapper.text()).toContain('考試已發布，請先取消發布再修改')
    expect(wrapper.find('.el-alert--error').exists()).toBe(true)
    expect(wrapper.emitted('conflict')).toHaveLength(1)
    expect(wrapper.emitted('saved')).toBeUndefined()
    wrapper.unmount()
    document.body.innerHTML = ''

    mock.resetHistory()
    mock.onGet('/admin/subjects').reply(200, SUBJECTS.filter((s) => s.id !== 'sub5'))
    mock.onPut('/admin/exams/e1/subjects').reply(422, {
      error: { code: 'invalid_subject', message: '科目不存在或已停用', details: { subject_ids: ['sub5'] } },
    })
    const stale = await mountEditor({ exam: makeExam({ subjects: [...TWO, subj('sub5', '社會', 100, 3)] }) })
    expect(rowOf(stale, '社會').find('.el-select__placeholder').text()).toBe('社會（已停用）')
    expect(rowOf(stale, '社會').find('.el-tag').text()).toBe('已停用')
    expect(rowOf(stale, '國語').find('.el-tag').exists()).toBe(false)

    await setFullScore(rowOf(stale, '國語'), '120')
    await clickIn(stale, '儲存')
    expect(mock.history.put).toHaveLength(1)
    expect(stale.text()).toContain('科目不存在或已停用')
    expect(rowOf(stale, '社會').classes()).toContain('is-error-subject')
    expect(rowOf(stale, '社會').text()).toContain('此科目已在參考資料停用，移除後才能儲存（會一併刪除該科成績）')
    expect(rowOf(stale, '國語').classes()).not.toContain('is-error-subject')
    expect(stale.emitted('conflict')).toBeUndefined()
    expect(stale.emitted('saved')).toBeUndefined()
  })
})
