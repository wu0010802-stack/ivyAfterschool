import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { StudentListItem } from '@/api/students'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentSelect from './StudentSelect.vue'

function item(overrides: Partial<StudentListItem>): StudentListItem {
  return {
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
    ...overrides,
  }
}

const WANG = item({})
const WANG_HUA = item({ id: 's2', student_no: 'S1002', name: '王小華', class: null })
const LIN = item({ id: 's3', student_no: 'S1003', name: '林小華', class: { id: 'c2', name: '中年級班' } })

function page(items: StudentListItem[]) {
  return { items, total: items.length, page: 1, page_size: 20 }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountSelect(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(StudentSelect, { props: { modelValue: null, ...props } })
  await settle()
  return wrapper as VueWrapper
}

function input(wrapper: VueWrapper): DOMWrapper<HTMLInputElement> {
  return wrapper.find<HTMLInputElement>('input')
}

async function type(wrapper: VueWrapper, text: string): Promise<void> {
  await input(wrapper).setValue(text)
  await settle()
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

function dropdown(wrapper: VueWrapper): HTMLElement {
  const listId = input(wrapper).attributes('aria-controls')
  const el = document.getElementById(listId!)?.closest<HTMLElement>('.el-select-dropdown')
  if (!el) throw new Error('找不到下拉')
  return el
}

function optionTexts(wrapper: VueWrapper): string[] {
  return Array.from(dropdown(wrapper).querySelectorAll('.el-select-dropdown__item')).map(
    (o) => o.textContent?.trim() ?? '',
  )
}

function studentGets() {
  return mock.history.get.filter((r) => r.url === '/admin/students')
}

describe('StudentSelect', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('StudentSelect searches after debounce with filters', async () => {
    mock.onGet('/admin/students').reply(200, page([WANG]))
    const wrapper = await mountSelect({ classId: 'c1' })

    expect(wrapper.find('.el-select__placeholder').text()).toBe('輸入學號或姓名搜尋')
    await type(wrapper, '王')
    await advance(299)
    expect(studentGets()).toHaveLength(0)

    await advance(1)
    expect(studentGets()).toHaveLength(1)
    expect(studentGets()[0]?.params).toEqual({ q: '王', class_id: 'c1', status: 'active', page_size: 20 })
  })

  it('StudentSelect searches after debounce with filters: no class, first status, trims and skips empty input', async () => {
    mock.onGet('/admin/students').reply(200, page([WANG]))
    const wrapper = await mountSelect({ statuses: ['suspended', 'active'], placeholder: '輸入學號或姓名（中年級班）' })

    expect(wrapper.find('.el-select__placeholder').text()).toBe('輸入學號或姓名（中年級班）')
    await type(wrapper, '   ')
    await advance(1000)
    expect(studentGets()).toHaveLength(0)

    await type(wrapper, ' S10 ')
    await advance(300)
    expect(studentGets()).toHaveLength(1)
    expect(studentGets()[0]?.params).toEqual({ q: 'S10', status: 'suspended', page_size: 20 })
    expect(Object.keys(studentGets()[0]?.params as object)).not.toContain('class_id')
  })

  it('StudentSelect empty result copy: empty input does not open dropdown', async () => {
    mock.onGet('/admin/students').reply(200, page([]))
    const wrapper = await mountSelect()
    const popper = (): HTMLElement => dropdown(wrapper).closest<HTMLElement>('.el-select__popper')!

    await wrapper.find('.el-select__wrapper').trigger('click')
    await advance(300)
    expect(popper().style.display).toBe('none')
    expect(studentGets()).toHaveLength(0)

    await type(wrapper, '張')
    expect(popper().style.display).not.toBe('none')
    await advance(300)
    expect(dropdown(wrapper).textContent).toContain('找不到符合的學生')

    // 清掉文字：不再顯示查無結果，也不展開
    await type(wrapper, '')
    await advance(300)
    expect(popper().style.display).toBe('none')
    expect(studentGets()).toHaveLength(1)
  })

  it('StudentSelect formats options and emits student', async () => {
    mock.onGet('/admin/students').reply(200, page([WANG, WANG_HUA]))
    const wrapper = await mountSelect()

    await type(wrapper, '王')
    await advance(300)

    expect(optionTexts(wrapper)).toEqual(['王小明（S1001・低年級A班）', '王小華（S1002・未分班）'])
    dropdown(wrapper).querySelector<HTMLElement>('.el-select-dropdown__item')!.click()
    await settle()

    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['s1'])
    const changed = wrapper.emitted('change')?.[0]?.[0] as StudentListItem
    expect(changed.name).toBe('王小明')
    expect(changed).toEqual(WANG)
  })

  it('StudentSelect formats options and emits student: initial option and clear', async () => {
    const wrapper = await mountSelect({
      modelValue: 's3',
      initialOption: { id: 's3', name: '林小華', student_no: 'S1003', class_name: '中年級班' },
    })

    expect(wrapper.find('.el-select__placeholder').text()).toBe('林小華（S1003・中年級班）')
    expect(studentGets()).toHaveLength(0)

    await wrapper.find('.el-select').trigger('mouseenter')
    await settle()
    await wrapper.find('.el-select__clear').trigger('click')
    await settle()

    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([null])
    expect(wrapper.emitted('change')?.at(-1)).toEqual([null])
    // initialOption 只有顯示用欄位，清除後移除，要重選須重新搜尋（change 才帶得出完整學生）
    expect(optionTexts(wrapper)).toEqual([])
  })

  it('StudentSelect discards stale results', async () => {
    mock.onGet('/admin/students', { params: { q: '王', status: 'active', page_size: 20 } }).reply(
      () => new Promise((resolve) => setTimeout(() => resolve([200, page([WANG])]), 1000)),
    )
    mock.onGet('/admin/students', { params: { q: '林', status: 'active', page_size: 20 } }).reply(
      () => new Promise((resolve) => setTimeout(() => resolve([200, page([LIN])]), 10)),
    )
    const wrapper = await mountSelect()

    await type(wrapper, '王')
    await advance(300)
    expect(studentGets()).toHaveLength(1)
    await type(wrapper, '林')
    await advance(310)
    expect(optionTexts(wrapper)).toEqual(['林小華（S1003・中年級班）'])

    // 「王」的回應在「林」之後才到，丟棄
    await advance(1000)
    expect(studentGets()).toHaveLength(2)
    expect(optionTexts(wrapper)).toEqual(['林小華（S1003・中年級班）'])
  })

  it('StudentSelect discards stale results: clearing text cancels in-flight request', async () => {
    mock.onGet('/admin/students').reply(
      () => new Promise((resolve) => setTimeout(() => resolve([200, page([WANG])]), 500)),
    )
    const wrapper = await mountSelect()

    await type(wrapper, '王')
    await advance(300)
    expect(studentGets()).toHaveLength(1)
    // 回應未到前清掉文字：這個請求作廢
    await type(wrapper, '')
    await advance(600)

    expect(optionTexts(wrapper)).toEqual([])
  })

  it('StudentSelect discards stale results: new input cancels in-flight request during debounce', async () => {
    mock.onGet('/admin/students', { params: { q: '王', status: 'active', page_size: 20 } }).reply(
      () => new Promise((resolve) => setTimeout(() => resolve([200, page([WANG])]), 200)),
    )
    mock.onGet('/admin/students', { params: { q: '林', status: 'active', page_size: 20 } }).reply(200, page([LIN]))
    const wrapper = await mountSelect()

    await type(wrapper, '王')
    await advance(300)
    expect(studentGets()).toHaveLength(1)
    await type(wrapper, '林')
    // 「林」的 debounce 期間「王」的回應到達：仍只顯示搜尋中，不出現上一個關鍵字的結果
    await advance(250)
    expect(studentGets()).toHaveLength(1)
    expect(optionTexts(wrapper)).toEqual([])
    expect(dropdown(wrapper).textContent).toContain('搜尋中…')

    await advance(100)
    expect(optionTexts(wrapper)).toEqual(['林小華（S1003・中年級班）'])
  })

  it('StudentSelect empty result copy', async () => {
    mock.onGet('/admin/students').reply(200, page([]))
    const wrapper = await mountSelect()

    await type(wrapper, '張')
    // debounce 與請求期間顯示搜尋中
    expect(dropdown(wrapper).textContent).toContain('搜尋中…')
    await advance(300)

    expect(optionTexts(wrapper)).toEqual([])
    expect(dropdown(wrapper).textContent).toContain('找不到符合的學生')
    expect(dropdown(wrapper).textContent).not.toContain('搜尋中…')
  })

  it('StudentSelect empty result copy: request failure', async () => {
    mock.onGet('/admin/students').replyOnce(200, page([WANG])).onGet('/admin/students').replyOnce(500, {
      error: { code: 'internal_error', message: '伺服器錯誤', details: null },
    })
    const wrapper = await mountSelect()

    await type(wrapper, '王')
    await advance(300)
    expect(optionTexts(wrapper)).toHaveLength(1)

    await type(wrapper, '王小')
    await advance(300)

    // 失敗時清空選項，不保留上一次的結果
    expect(optionTexts(wrapper)).toEqual([])
    const alert = dropdown(wrapper).querySelector('[role=alert]')
    expect(alert?.textContent?.trim()).toBe('無法載入學生')
  })
})
