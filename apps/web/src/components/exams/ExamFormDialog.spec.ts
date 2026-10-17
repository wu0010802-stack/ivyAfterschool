import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { Exam } from '@/api/exams'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import { currentAcademicYear } from '@/utils/academicYear'
import ExamFormDialog from './ExamFormDialog.vue'

const YEAR = currentAcademicYear()

const EXAM_TYPES = [
  { id: 't1', name: '段考', sort_order: 1, is_active: true },
  { id: 't2', name: '小考', sort_order: 2, is_active: true },
]
const SUBJECTS = [
  { id: 'sub1', name: '國語', sort_order: 1, is_active: true },
  { id: 'sub2', name: '數學', sort_order: 2, is_active: true },
  { id: 'sub3', name: '英語', sort_order: 3, is_active: true },
  { id: 'sub4', name: '自然', sort_order: 4, is_active: true },
]
function makeClass(id: string, name: string, academicYear: number) {
  return {
    id,
    name,
    grade_levels: [3, 4],
    academic_year: academicYear,
    sort_order: 0,
    archived_at: null,
    student_count: 20,
    staff: [],
  }
}
const CLASSES = [makeClass('c3', '中年級A班', YEAR), makeClass('c9', '舊年度班', YEAR - 1)]

const DRAFT: Exam = {
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
  roster_count: 32,
  created_at: '2026-09-20T02:00:00Z',
}
const PUBLISHED: Exam = {
  ...DRAFT,
  id: 'e4',
  status: 'published',
  published_at: '2026-10-05T09:00:00Z',
  published_by_name: '張主任',
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

/** el-form-item 的錯誤訊息有 100ms debounce，斷言錯誤文字前等過 */
async function settleErrors(): Promise<void> {
  await settle()
  await new Promise((resolve) => setTimeout(resolve, 150))
  await settle()
}

function mockLookups(): void {
  mock.onGet('/admin/exam-types').reply(200, EXAM_TYPES)
  mock.onGet('/admin/classes').reply(200, CLASSES)
  mock.onGet('/admin/subjects').reply(200, SUBJECTS)
}

async function mountDialog(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(ExamFormDialog, { props: { modelValue: true, ...props } })
  await settle()
  await settle()
  return wrapper as VueWrapper
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

/** 打開下拉並點選項（選單 teleport 到 body，以 input 的 aria-controls 對應） */
async function choose(label: string, option: string): Promise<void> {
  const item = formItem(label)
  await item.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = item.find('input').attributes('aria-controls')
  const options = Array.from(
    document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [],
  )
  const target = options.find((o) => o.textContent?.trim() === option)
  if (!target) throw new Error(`找不到選項 ${option}（欄位 ${label}）`)
  target.click()
  await settle()
}

function optionLabels(label: string): string[] {
  const listId = formItem(label).find('input').attributes('aria-controls')
  return Array.from(
    document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [],
  ).map((o) => o.textContent?.trim() ?? '')
}

/** 在日期欄輸入顯示格式（YYYY/MM/DD）後觸發 change，由 el-date-picker 解析成 value-format */
async function typeDate(value: string): Promise<void> {
  const input = formItem('考試日期').find('input')
  await input.trigger('focus')
  await input.setValue(value)
  await input.trigger('change')
  await settle()
}

function subjectBox(name: string): DOMWrapper<Element> {
  const box = dialog()
    .findAll('.ef-subject')
    .find((b) => b.find('.el-checkbox__label').text().trim() === name)
  if (!box) throw new Error(`找不到科目 ${name}`)
  return box
}

async function uncheckSubject(name: string): Promise<void> {
  await subjectBox(name).find('input[type=checkbox]').setValue(false)
  await settle()
}

function submitButton(text: string): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到「${text}」`)
  return btn
}

async function submit(text: string): Promise<void> {
  await submitButton(text).trigger('click')
  await settle()
  await settle()
}

function isDisabled(item: DOMWrapper<Element>): boolean {
  return item.find('input').attributes('disabled') !== undefined
}

async function fillCreateBasics(): Promise<void> {
  await formItem('名稱').find('input').setValue('第一次段考')
  await choose('考試類型', '段考')
  await typeDate('2026/10/15')
}

describe('ExamFormDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
    mockLookups()
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('ExamFormDialog creates exam then subjects', async () => {
    const created: Exam = { ...DRAFT, id: 'e9', subjects: [] }
    const withSubjects: Exam = {
      ...created,
      subjects: [
        { subject_id: 'sub1', subject_name: '國語', full_score: 100, sort_order: 1 },
        { subject_id: 'sub2', subject_name: '數學', full_score: 100, sort_order: 2 },
      ],
    }
    mock.onPost('/admin/exams').reply(201, created)
    mock.onPut('/admin/exams/e9/subjects').reply(200, withSubjects)
    const wrapper = await mountDialog()

    expect(dialog().find('.el-dialog__title').text()).toBe('建立考試')
    expect(dialog().text()).toContain('科目與滿分')
    // 班級下拉只列目前學年度
    await formItem('班級').find('.el-select__wrapper').trigger('click')
    await settle()
    expect(optionLabels('班級')).toEqual(['中年級A班'])
    await formItem('班級').find('.el-select__wrapper').trigger('click')
    await settle()

    await fillCreateBasics()
    await choose('年級', '三年級')
    // 預設全部勾選、滿分 100；取消勾選的科目滿分停用
    for (const name of ['國語', '數學', '英語', '自然']) {
      expect((subjectBox(name).find('input[type=checkbox]').element as HTMLInputElement).checked).toBe(true)
      expect((subjectBox(name).find('.el-input-number input').element as HTMLInputElement).value).toBe('100')
    }
    await uncheckSubject('英語')
    await uncheckSubject('自然')
    expect(subjectBox('英語').find('.el-input-number').classes()).toContain('is-disabled')
    expect(subjectBox('國語').find('.el-input-number').classes()).not.toContain('is-disabled')
    // 部分勾選時「全選」半選
    expect(dialog().find('.ef-section .el-checkbox').classes()).not.toContain('is-checked')
    expect(dialog().find('.ef-section .el-checkbox__input').classes()).toContain('is-indeterminate')

    await submit('建立')

    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({
      name: '第一次段考',
      exam_type_id: 't1',
      exam_date: '2026-10-15',
      grade_level: 3,
    })
    expect(JSON.parse(mock.history.put[0]?.data as string)).toEqual({
      items: [
        { subject_id: 'sub1', full_score: 100, sort_order: 1 },
        { subject_id: 'sub2', full_score: 100, sort_order: 2 },
      ],
    })
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.emitted('saved')?.[0]).toEqual([withSubjects])
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
    expect(document.body.textContent).toContain('已建立考試')
  })

  it('ExamFormDialog accepts full score with two decimals', async () => {
    const created: Exam = { ...DRAFT, id: 'e9', subjects: [] }
    mock.onPost('/admin/exams').reply(201, created)
    mock.onPut('/admin/exams/e9/subjects').reply(200, created)
    await mountDialog()
    await fillCreateBasics()
    await choose('年級', '三年級')
    for (const name of ['數學', '英語', '自然']) await uncheckSubject(name)

    const full = subjectBox('國語').find('.el-input-number input')
    await full.setValue('99.755')
    await full.trigger('change')
    await settle()
    await submit('建立')
    expect(dialog().text()).toContain('請輸入勾選科目的滿分（大於 0、最多 1000、最多兩位小數）')
    expect(mock.history.post).toHaveLength(0)

    await full.setValue('99.75')
    await full.trigger('change')
    await settle()
    await submit('建立')
    expect(JSON.parse(mock.history.put[0]?.data as string)).toEqual({
      items: [{ subject_id: 'sub1', full_score: 99.75, sort_order: 1 }],
    })
  })

  it('ExamFormDialog accepts minimum full score 0.01', async () => {
    const created: Exam = { ...DRAFT, id: 'e9', subjects: [] }
    mock.onPost('/admin/exams').reply(201, created)
    mock.onPut('/admin/exams/e9/subjects').reply(200, created)
    await mountDialog()
    await fillCreateBasics()
    await choose('年級', '三年級')
    for (const name of ['數學', '英語', '自然']) await uncheckSubject(name)

    const full = subjectBox('國語').find('.el-input-number input')
    await full.setValue('0.01')
    await full.trigger('change')
    await settle()
    await submit('建立')

    expect(dialog().text()).not.toContain('請輸入勾選科目的滿分')
    expect(JSON.parse(mock.history.put[0]?.data as string)).toEqual({
      items: [{ subject_id: 'sub1', full_score: 0.01, sort_order: 1 }],
    })
  })

  it('ExamFormDialog requires grade or class', async () => {
    const wrapper = await mountDialog()

    await fillCreateBasics()
    await submit('建立')
    await settleErrors()

    expect(dialog().text()).toContain('請選擇年級或班級')
    expect(dialog().find('.ef-scope').classes()).toContain('is-error')
    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('saved')).toBeUndefined()

    // 選了年級後錯誤消失
    await choose('年級', '三年級')
    expect(dialog().text()).not.toContain('請選擇年級或班級')
  })

  it('ExamFormDialog warns when subject step fails', async () => {
    const created: Exam = { ...DRAFT, id: 'e9', subjects: [] }
    mock.onPost('/admin/exams').reply(201, created)
    mock.onPut('/admin/exams/e9/subjects').reply(500, {
      error: { code: 'internal_error', message: '伺服器錯誤', details: null },
    })
    const wrapper = await mountDialog()

    await fillCreateBasics()
    await choose('年級', '三年級')
    await submit('建立')

    expect(mock.history.put).toHaveLength(1)
    expect(document.body.textContent).toContain('考試已建立，但科目設定失敗')
    expect(wrapper.emitted('saved')).toHaveLength(1)
    expect(wrapper.emitted('saved')?.[0]).toEqual([created])
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([false])
  })

  it('ExamFormDialog published exam limits fields', async () => {
    const updated: Exam = { ...PUBLISHED, exam_date: '2026-10-16' }
    mock.onPatch('/admin/exams/e4').reply(200, updated)
    const wrapper = await mountDialog({ exam: PUBLISHED })

    expect(dialog().find('.el-dialog__title').text()).toBe('編輯考試')
    expect(dialog().text()).toContain('已發布的考試只能修改名稱、日期與備註')
    expect(isDisabled(formItem('考試類型'))).toBe(true)
    expect(isDisabled(formItem('年級'))).toBe(true)
    expect(isDisabled(formItem('班級'))).toBe(true)
    expect(isDisabled(formItem('名稱'))).toBe(false)
    // 編輯沒有科目區；沒有變更時「儲存」停用
    expect(dialog().text()).not.toContain('科目與滿分')
    expect(submitButton('儲存').attributes('disabled')).toBeDefined()

    await typeDate('2026/10/16')
    expect(submitButton('儲存').attributes('disabled')).toBeUndefined()
    await submit('儲存')

    expect(mock.history.patch).toHaveLength(1)
    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({ exam_date: '2026-10-16' })
    expect(wrapper.emitted('saved')?.[0]).toEqual([updated])
    expect(document.body.textContent).toContain('已更新')
  })

  it('ExamFormDialog maps grade class mismatch', async () => {
    mock.onPost('/admin/exams').reply(422, {
      error: { code: 'grade_not_in_class', message: '此班級沒有該年級', details: null },
    })
    const wrapper = await mountDialog()

    await fillCreateBasics()
    await choose('年級', '三年級')
    await choose('班級', '中年級A班')
    expect(dialog().text()).toContain('只包含該班中該年級的學生')
    await submit('建立')
    await settleErrors()

    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({
      name: '第一次段考',
      exam_type_id: 't1',
      exam_date: '2026-10-15',
      grade_level: 3,
      class_id: 'c3',
    })
    expect(formItem('年級').find('.el-form-item__error').text()).toBe('此班級沒有該年級')
    expect(mock.history.put).toHaveLength(0)
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('ExamFormDialog scope change hint and published conflict', async () => {
    mock.onPatch('/admin/exams/e1').reply(409, {
      error: { code: 'exam_published', message: '考試已發布，名單與類型不可修改，請先取消發布', details: null },
    })
    const wrapper = await mountDialog({ exam: DRAFT })

    expect(dialog().text()).not.toContain('已不在名單')
    expect(dialog().text()).not.toContain('已發布的考試只能修改名稱、日期與備註')
    expect(isDisabled(formItem('年級'))).toBe(false)
    await choose('班級', '中年級A班')
    expect(dialog().text()).toContain('成績會保留並標示「已不在名單」')
    await submit('儲存')

    expect(JSON.parse(mock.history.patch[0]?.data as string)).toEqual({ class_id: 'c3' })
    expect(dialog().text()).toContain('考試已發布，名單與類型不可修改，請先取消發布')
    expect(dialog().find('.el-alert--error').exists()).toBe(true)
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })
})
