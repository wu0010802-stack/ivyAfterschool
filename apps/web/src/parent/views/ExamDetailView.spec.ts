import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ChildSummary } from '../api/children'
import type { ParentExamDetail } from '../api/exams'
import { parentHttp } from '../api/http'
import { useChildrenStore } from '../stores/children'
import ExamDetailView from './ExamDetailView.vue'
import source from './ExamDetailView.vue?raw'

const NOT_FOUND = { error: { code: 'exam_not_found', message: '找不到考試', details: null } }
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級 A 班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

const stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [
  { path: '/', component: stub },
  { path: '/exams/:examId', component: stub },
  { path: '/exams', component: stub },
]

function detail(overrides: Partial<ParentExamDetail> = {}): ParentExamDetail {
  return {
    exam_id: 'e1',
    name: '第一次段考',
    exam_type_name: '段考',
    exam_date: '2026-10-14',
    note: '數學範圍第 1~3 單元',
    subjects: [
      { subject_name: '國語', full_score: 100, score: 92.5, is_absent: false, note: null },
      { subject_name: '數學', full_score: 100, score: null, is_absent: true, note: '請病假' },
    ],
    ...overrides,
  }
}

const url = (childId: string, examId: string) => `/parent/children/${childId}/exams/${examId}`

/** 可手動決定何時回應的 reply */
function deferredReply() {
  let resolve!: (value: [number, unknown]) => void
  const promise = new Promise<[number, unknown]>((r) => {
    resolve = r
  })
  return { reply: () => promise, resolve }
}

let mock: MockAdapter
let mounted: MountedApp | null = null

beforeEach(() => {
  mock = createApiMock(parentHttp)
})

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted = null
  mock.restore()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

async function mountView(
  selectedId: string | null = 's1',
  options: { route?: string; items?: ChildSummary[]; loaded?: boolean } = {},
): Promise<MountedApp> {
  mounted = await mountWithApp(ExamDetailView, {
    routes: ROUTES,
    initialRoute: options.route ?? '/exams/e1',
    piniaInitialState: {
      parentChildren: { items: options.items ?? KIDS, loaded: options.loaded ?? true, selectedId },
    },
  })
  return mounted
}

type Wrapper = MountedApp['wrapper']

function button(w: Wrapper, label: string) {
  const found = w.findAll('button').find((b) => b.text().includes(label))
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

/** ?raw 原始碼 <style> 中某選擇器（行首，可縮排）的樣式區塊內容 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm').exec(source)
  expect(match, `找不到 ${selector} 區塊`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('ExamDetailView', () => {
  it('ExamDetailView loads exam for selected child', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail())

    const { wrapper } = await mountView('s1')

    expect(mock.history.get).toHaveLength(1)
    expect(mock.history.get[0]!.url).toBe('/parent/children/s1/exams/e1')
    expect(wrapper.text()).toContain('第一次段考')
    expect(wrapper.text()).toContain('備註：數學範圍第 1~3 單元')
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
    expect(wrapper.find('.skeleton').exists()).toBe(false)
  })

  it('ExamDetailView header card shows name, type tag and date with weekday', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail())

    const { wrapper } = await mountView('s1')

    expect(wrapper.get('.ed-head__name').text()).toBe('第一次段考')
    expect(wrapper.get('.ed-head__meta .exam-type').text()).toBe('段考')
    expect(wrapper.get('.ed-head__meta').text()).toContain('2026/10/14（三）')
    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    // 分數表在另一張 outlined 卡內，並顯示缺考與科目備註
    const table = wrapper.get('table')
    expect(table.text()).toContain('92.5')
    expect(table.text()).toContain('缺考')
    expect(table.text()).toContain('請病假')
  })

  it('ExamDetailView hides the note section when there is no note', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail({ note: null }))

    const { wrapper } = await mountView('s1')

    expect(wrapper.find('.ed-head__note').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('備註：')
    // 科目備註不受影響
    expect(wrapper.text()).toContain('請病假')
  })

  it('ExamDetailView keeps line breaks of a multi-line note', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail({ note: '閱讀理解為加考。\n作文由學校另行評分。' }))

    const { wrapper } = await mountView('s1')

    expect(wrapper.get('.ed-head__note').text()).toBe('備註：閱讀理解為加考。\n作文由學校另行評分。')
    expect(rule('.ed-head__note')).toMatch(/white-space:\s*pre-line/)
    expect(rule('.ed-head__name')).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('ExamDetailView shows the score table empty state when the exam has no subjects', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail({ subjects: [] }))

    const { wrapper } = await mountView('s1')

    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.text()).toContain('這次考試尚無科目成績')
  })

  it('ExamDetailView shows a card skeleton and four row skeletons while loading', async () => {
    const pending = deferredReply()
    mock.onGet(url('s1', 'e1')).reply(pending.reply)

    const { wrapper } = await mountView('s1')

    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(wrapper.find('.skeleton--card').exists()).toBe(true)
    expect(wrapper.findAll('.skeleton-row')).toHaveLength(4)
    expect(wrapper.find('table').exists()).toBe(false)

    pending.resolve([200, detail()])
    await flushPromises()

    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(wrapper.findAll('tbody tr')).toHaveLength(2)
  })

  it('ExamDetailView does not offer pull to refresh', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail())

    const { wrapper } = await mountView('s1')

    expect(wrapper.find('.ptr').exists()).toBe(false)
  })

  it('ExamDetailView not found state', async () => {
    mock.onGet(url('s1', 'e1')).reply(404, NOT_FOUND)

    const { wrapper, router } = await mountView('s1')

    expect(wrapper.text()).toContain('找不到這次考試的成績')
    expect(wrapper.text()).toContain('可能尚未公布或不屬於目前選擇的小孩')
    expect(wrapper.get('.empty-state__icon').text()).toBe('search_off')
    expect(wrapper.find('table').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('成績載入失敗')

    await button(wrapper, '回成績列表').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/exams')
  })

  it('ExamDetailView switching child returns to list', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail())
    const { wrapper, router } = await mountView('s1')
    expect(router.currentRoute.value.path).toBe('/exams/e1')

    await wrapper.get('.cch').trigger('click')
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('.cch-option'))
    options[1]!.click()
    await flushPromises()

    expect(useChildrenStore().selectedId).toBe('s2')
    expect(router.currentRoute.value.path).toBe('/exams')
    // 不會替新的小孩再打一次這份考試的明細
    expect(mock.history.get).toHaveLength(1)
  })

  it('ExamDetailView replaces the history entry when switching child', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail())
    const { router } = await mountView('s1', { route: '/exams/e1' })
    useChildrenStore().select('s2')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/exams')
    // replace：返回鍵不會回到不屬於新小孩的明細
    router.back()
    await flushPromises()
    expect(router.currentRoute.value.path).not.toBe('/exams/e1')
  })

  it('ExamDetailView error retry', async () => {
    mock.onGet(url('s1', 'e1')).replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')

    expect(wrapper.text()).toContain('成績載入失敗')
    expect(wrapper.text()).toContain('重試')
    expect(wrapper.text()).not.toContain('找不到這次考試的成績')
    expect(mock.history.get).toHaveLength(1)

    mock.onGet(url('s1', 'e1')).replyOnce(200, detail())
    await button(wrapper, '重試').trigger('click')
    await flushPromises()

    expect(mock.history.get).toHaveLength(2)
    expect(wrapper.text()).not.toContain('成績載入失敗')
    expect(wrapper.text()).toContain('第一次段考')
  })

  it('ExamDetailView treats other statuses as load errors and shows the skeleton while retrying', async () => {
    mock.onGet(url('s1', 'e1')).replyOnce(403, { error: { code: 'forbidden', message: '無權限', details: null } })
    const { wrapper } = await mountView('s1')
    expect(wrapper.text()).toContain('成績載入失敗')

    const again = deferredReply()
    mock.onGet(url('s1', 'e1')).replyOnce(again.reply)
    await button(wrapper, '重試').trigger('click')

    expect(wrapper.text()).not.toContain('成績載入失敗')
    expect(wrapper.find('.skeleton--card').exists()).toBe(true)
  })

  it('ExamDetailView encodes the exam id taken from the route', async () => {
    mock.onGet('/parent/children/s1/exams/e%2F1').reply(200, detail())

    const { wrapper } = await mountView('s1', { route: '/exams/e%2F1' })

    expect(mock.history.get[0]!.url).toBe('/parent/children/s1/exams/e%2F1')
    expect(wrapper.text()).toContain('第一次段考')
  })

  it('ExamDetailView reloads when the exam id in the route changes and ignores the older response', async () => {
    const first = deferredReply()
    mock.onGet(url('s1', 'e1')).reply(first.reply)
    mock.onGet(url('s1', 'e2')).reply(200, detail({ exam_id: 'e2', name: '數學單元測驗', note: null }))
    const { wrapper, router } = await mountView('s1')

    await router.push('/exams/e2')
    await flushPromises()
    expect(wrapper.get('.ed-head__name').text()).toBe('數學單元測驗')

    first.resolve([200, detail({ name: '第一次段考' })])
    await flushPromises()

    expect(wrapper.get('.ed-head__name').text()).toBe('數學單元測驗')
    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children/s1/exams/e1', '/parent/children/s1/exams/e2'])
  })

  it('ExamDetailView loads the child list and waits for a selection before requesting the exam', async () => {
    mock.onGet('/parent/children').reply(200, KIDS)
    mock.onGet(url('s1', 'e1')).reply(200, detail())

    const { wrapper, router } = await mountView(null, { items: [], loaded: false })

    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children', '/parent/children/s1/exams/e1'])
    expect(wrapper.get('.ed-head__name').text()).toBe('第一次段考')
    // 第一次選到小孩不算「切換小孩」
    expect(router.currentRoute.value.path).toBe('/exams/e1')
  })

  it('ExamDetailView stays on the exam when the reloaded child list keeps the selected child', async () => {
    mock.onGet('/parent/children').reply(200, KIDS)
    mock.onGet(url('s1', 'e1')).reply(200, detail())

    const { router } = await mountView('s1', { items: KIDS, loaded: false })

    expect(router.currentRoute.value.path).toBe('/exams/e1')
  })

  it('ExamDetailView returns to the list when the selected child disappears from the child list', async () => {
    mock.onGet(url('s1', 'e1')).reply(200, detail())
    const { router } = await mountView('s1')
    mock.onGet('/parent/children').reply(200, [KIDS[1]])

    await useChildrenStore().load(true)
    await flushPromises()

    expect(useChildrenStore().selectedId).toBe('s2')
    expect(router.currentRoute.value.path).toBe('/exams')
  })

  it('ExamDetailView shows not found without requesting when there is no child', async () => {
    const { wrapper } = await mountView(null, { items: [], loaded: true })

    expect(mock.history.get).toHaveLength(0)
    expect(wrapper.text()).toContain('找不到這次考試的成績')
  })

  it('ExamDetailView shows a load error when the child list cannot be loaded', async () => {
    mock.onGet('/parent/children').replyOnce(500, SERVER_ERROR)

    const { wrapper } = await mountView(null, { items: [], loaded: false })

    expect(wrapper.text()).toContain('成績載入失敗')
    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children'])

    mock.onGet('/parent/children').replyOnce(200, KIDS)
    mock.onGet(url('s1', 'e1')).reply(200, detail())
    await button(wrapper, '重試').trigger('click')
    await flushPromises()

    expect(wrapper.get('.ed-head__name').text()).toBe('第一次段考')
  })
})
