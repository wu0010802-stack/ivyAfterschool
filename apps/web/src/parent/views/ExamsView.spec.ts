import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ChildSummary } from '../api/children'
import type { ParentExamSummary } from '../api/exams'
import { parentHttp } from '../api/http'
import PullToRefresh from '../components/PullToRefresh.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'
import ExamsView from './ExamsView.vue'

const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級 A 班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

function exam(n: number, overrides: Partial<ParentExamSummary> = {}): ParentExamSummary {
  return {
    exam_id: `e${n}`,
    name: `第 ${n} 次考試`,
    exam_type_name: '小考',
    exam_date: '2026-10-14',
    published_at: '2026-10-16T08:00:00Z',
    subject_count: 1,
    ...overrides,
  }
}

function exams(from: number, to: number): ParentExamSummary[] {
  return Array.from({ length: to - from + 1 }, (_, i) => exam(from + i))
}

const url = (childId: string) => `/parent/children/${childId}/exams`

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
  state: { items?: ChildSummary[]; loaded?: boolean } = {},
): Promise<MountedApp> {
  mounted = await mountWithApp(ExamsView, {
    piniaInitialState: {
      parentChildren: { items: state.items ?? KIDS, loaded: state.loaded ?? true, selectedId },
    },
  })
  return mounted
}

type Wrapper = MountedApp['wrapper']

const rows = (w: Wrapper) => w.findAll('li.exam-item')
const names = (w: Wrapper) => rows(w).map((r) => r.get('.exam-item__name').text())

function button(w: Wrapper, label: string) {
  const found = w.findAll('button').find((b) => b.text().includes(label))
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

function queryParams(index: number): unknown {
  return mock.history.get[index]?.params
}

describe('ExamsView', () => {
  it('ExamsView lists exams for selected child', async () => {
    mock.onGet(url('s2')).reply(200, { items: [exam(1, { name: '第一次段考' }), exam(2, { name: '數學小考' })], total: 2 })

    const { wrapper } = await mountView('s2')

    expect(mock.history.get).toHaveLength(1)
    expect(mock.history.get[0]!.url).toBe('/parent/children/s2/exams')
    expect(queryParams(0)).toEqual({ page: 1, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(2)
    expect(names(wrapper)).toEqual(['第一次段考', '數學小考'])
    expect(wrapper.get('ul[aria-label="已公布的考試"]').attributes('role')).toBe('list')
    expect(rows(wrapper)[0]!.get('a').attributes('href')).toBe('/exams/e1')
    // 載入完成後沒有骨架、沒有「載入更多」、沒有錯誤
    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('載入更多')
    expect(wrapper.text()).not.toContain('成績載入失敗')
  })

  it('ExamsView shows the child header and a row skeleton while the first page loads', async () => {
    const first = deferredReply()
    mock.onGet(url('s1')).reply(first.reply)

    const { wrapper } = await mountView('s1')

    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(wrapper.get('.skeleton--row').attributes('aria-busy')).toBe('true')
    expect(wrapper.findAll('.skeleton-row')).toHaveLength(4)
    expect(rows(wrapper)).toHaveLength(0)
    // 載入中停用下拉重新整理
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)

    first.resolve([200, { items: [exam(1)], total: 1 }])
    await flushPromises()

    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(false)
  })

  it('ExamsView skeleton rows match list item height', async () => {
    const first = deferredReply()
    mock.onGet(url('s1')).reply(first.reply)

    const { wrapper } = await mountView('s1')

    const skeletonRows = wrapper.findAll('.skeleton-row')
    expect(skeletonRows).toHaveLength(4)
    for (const row of skeletonRows) {
      const style = (row.element as HTMLElement).style
      expect(style.height).toBe('76px')
      expect(style.minHeight).toBe('76px')
    }
  })

  it('ExamsView skeleton disappears after load', async () => {
    const first = deferredReply()
    mock.onGet(url('s1')).reply(first.reply)

    const { wrapper } = await mountView('s1')
    expect(wrapper.findAll('.skeleton-row')).toHaveLength(4)

    first.resolve([200, { items: exams(1, 3), total: 3 }])
    await flushPromises()

    expect(wrapper.findAll('.skeleton-row')).toHaveLength(0)
    expect(rows(wrapper)).toHaveLength(3)
  })

  it('ExamsView switch child reloads', async () => {
    const s1 = deferredReply()
    mock.onGet(url('s1')).reply(s1.reply)
    mock.onGet(url('s2')).reply(200, { items: [exam(21, { name: '王小華的考試' })], total: 1 })
    const { wrapper } = await mountView('s1')
    expect(mock.history.get).toHaveLength(1)

    useChildrenStore().select('s2')
    await flushPromises()

    expect(mock.history.get).toHaveLength(2)
    expect(mock.history.get[1]!.url).toBe('/parent/children/s2/exams')
    expect(names(wrapper)).toEqual(['王小華的考試'])

    // s1 晚到的回應不覆蓋畫面
    s1.resolve([200, { items: [exam(1, { name: '王小明的考試' })], total: 1 }])
    await flushPromises()

    expect(names(wrapper)).toEqual(['王小華的考試'])
    expect(wrapper.text()).not.toContain('王小明的考試')
  })

  it('ExamsView switch child from the header resets pagination and shows the skeleton', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).reply(200, { items: exams(1, 20), total: 23 })
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(200, { items: exams(21, 23), total: 23 })
    const s2 = deferredReply()
    mock.onGet(url('s2')).replyOnce(s2.reply)
    const { wrapper } = await mountView('s1')
    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(23)

    await wrapper.get('.cch').trigger('click')
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('.cch-option'))
    options[1]!.click()
    await flushPromises()

    expect(useChildrenStore().selectedId).toBe('s2')
    expect(queryParams(2)).toEqual({ page: 1, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.find('.skeleton--row').exists()).toBe(true)

    s2.resolve([200, { items: [exam(31)], total: 25 }])
    await flushPromises()

    // 分頁已重置：下一頁從第 2 頁開始
    mock.onGet(url('s2'), { params: { page: 2, page_size: 20 } }).reply(200, { items: [exam(32)], total: 25 })
    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()
    expect(queryParams(3)).toEqual({ page: 2, page_size: 20 })
  })

  it('ExamsView load more', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).reply(200, { items: exams(1, 20), total: 23 })
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(200, { items: exams(21, 23), total: 23 })
    const { wrapper } = await mountView('s1')
    expect(rows(wrapper)).toHaveLength(20)

    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()

    expect(mock.history.get).toHaveLength(2)
    expect(queryParams(1)).toEqual({ page: 2, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(23)
    expect(names(wrapper)[22]).toBe('第 23 次考試')
    expect(wrapper.text()).not.toContain('載入更多')
  })

  it('ExamsView load more shows progress and ignores a second click while loading', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).reply(200, { items: exams(1, 20), total: 40 })
    const more = deferredReply()
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(more.reply)
    const { wrapper } = await mountView('s1')

    await button(wrapper, '載入更多').trigger('click')
    expect(button(wrapper, '載入更多').attributes('aria-busy')).toBe('true')
    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()
    expect(mock.history.get).toHaveLength(2)

    more.resolve([200, { items: exams(21, 40), total: 40 }])
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(40)
    expect(mock.history.get).toHaveLength(2)
  })

  it('ExamsView load more dedupes by exam_id', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).reply(200, { items: exams(1, 20), total: 23 })
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(200, { items: [exam(20), ...exams(21, 23)], total: 23 })
    const { wrapper } = await mountView('s1')

    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(23)
    const ids = rows(wrapper).map((r) => r.get('a').attributes('href'))
    expect(new Set(ids).size).toBe(23)
    expect(wrapper.text()).not.toContain('載入更多')
  })

  it('ExamsView load more failure keeps list', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).reply(200, { items: exams(1, 20), total: 23 })
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')

    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(20)
    expect(button(wrapper, '載入更多').attributes('aria-busy')).toBeUndefined()
    expect(wrapper.text()).not.toContain('成績載入失敗')
    expect(useSnackbarStore().items.map((i) => [i.message, i.tone])).toEqual([['載入更多失敗，請稍後再試', 'error']])

    // 按鈕保留可重按，成功後補齊
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(200, { items: exams(21, 23), total: 23 })
    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(23)
  })

  it('ExamsView load more ignores a late page after switching child', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).reply(200, { items: exams(1, 20), total: 40 })
    const more = deferredReply()
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(more.reply)
    mock.onGet(url('s2')).reply(200, { items: [exam(31, { name: '王小華的考試' })], total: 1 })
    const { wrapper } = await mountView('s1')
    await button(wrapper, '載入更多').trigger('click')

    useChildrenStore().select('s2')
    await flushPromises()
    more.resolve([200, { items: exams(21, 40), total: 40 }])
    await flushPromises()

    expect(names(wrapper)).toEqual(['王小華的考試'])
  })

  it('ExamsView load more stops when the next page is empty', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).reply(200, { items: exams(1, 20), total: 22 })
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).reply(200, { items: [], total: 22 })
    const { wrapper } = await mountView('s1')

    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(20)
    expect(wrapper.text()).not.toContain('載入更多')
  })

  it('ExamsView empty and error', async () => {
    mock.onGet(url('s1')).replyOnce(200, { items: [], total: 0 })
    const { wrapper } = await mountView('s1')

    expect(wrapper.text()).toContain('目前沒有已公布的成績')
    expect(wrapper.text()).toContain('安親班公布考試成績後會通知您')
    expect(wrapper.get('.empty-state__icon').text()).toBe('grading')
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.find('button.m3-button').exists()).toBe(false)
    wrapper.unmount()
    mounted = null

    mock.onGet(url('s1')).replyOnce(500, SERVER_ERROR)
    const failed = await mountView('s1')

    expect(failed.wrapper.text()).toContain('成績載入失敗')
    expect(failed.wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(mock.history.get).toHaveLength(2)

    mock.onGet(url('s1')).replyOnce(200, { items: [exam(1)], total: 1 })
    await button(failed.wrapper, '重試').trigger('click')
    await flushPromises()

    expect(mock.history.get).toHaveLength(3)
    expect(rows(failed.wrapper)).toHaveLength(1)
    expect(failed.wrapper.text()).not.toContain('成績載入失敗')
  })

  it('ExamsView retry shows the skeleton again while reloading', async () => {
    mock.onGet(url('s1')).replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')
    const again = deferredReply()
    mock.onGet(url('s1')).reply(again.reply)

    await button(wrapper, '重試').trigger('click')

    expect(wrapper.text()).not.toContain('成績載入失敗')
    expect(wrapper.find('.skeleton--row').exists()).toBe(true)
  })

  it('ExamsView pull refresh failure keeps list', async () => {
    mock.onGet(url('s1')).replyOnce(200, { items: [exam(1), exam(2)], total: 2 })
    const { wrapper } = await mountView('s1')
    expect(rows(wrapper)).toHaveLength(2)
    mock.onGet(url('s1')).reply(500, SERVER_ERROR)

    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(2)
    expect(wrapper.text()).not.toContain('成績載入失敗')
    expect(useSnackbarStore().items.map((i) => [i.message, i.tone])).toEqual([['更新失敗，請稍後再試', 'error']])
  })

  it('ExamsView pull refresh replaces the list with the first page and resets pagination', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).replyOnce(200, { items: exams(1, 20), total: 23 })
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).replyOnce(200, { items: exams(21, 23), total: 23 })
    const { wrapper } = await mountView('s1')
    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(23)

    const refreshed = deferredReply()
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).replyOnce(refreshed.reply)
    const pending = wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()
    // 重新整理期間保留既有內容，不退回骨架
    expect(rows(wrapper)).toHaveLength(23)
    expect(wrapper.find('.skeleton').exists()).toBe(false)

    refreshed.resolve([200, { items: [exam(99, { name: '最新公布的考試' }), ...exams(1, 19)], total: 21 }])
    await pending
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(20)
    expect(names(wrapper)[0]).toBe('最新公布的考試')
    expect(wrapper.text()).toContain('載入更多')
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).replyOnce(200, { items: [exam(100)], total: 21 })
    await button(wrapper, '載入更多').trigger('click')
    await flushPromises()
    expect(queryParams(mock.history.get.length - 1)).toEqual({ page: 2, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(21)
  })

  it('ExamsView pull refresh while a load more is in flight discards that page and clears its progress', async () => {
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).replyOnce(200, { items: exams(1, 20), total: 40 })
    const more = deferredReply()
    mock.onGet(url('s1'), { params: { page: 2, page_size: 20 } }).replyOnce(more.reply)
    const { wrapper } = await mountView('s1')
    await button(wrapper, '載入更多').trigger('click')
    expect(button(wrapper, '載入更多').attributes('aria-busy')).toBe('true')
    mock.onGet(url('s1'), { params: { page: 1, page_size: 20 } }).replyOnce(200, { items: exams(1, 20), total: 40 })

    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()
    more.resolve([200, { items: exams(21, 40), total: 40 }])
    await flushPromises()

    // 舊的第 2 頁被丟棄，按鈕不再轉圈、仍可載入下一頁
    expect(rows(wrapper)).toHaveLength(20)
    expect(button(wrapper, '載入更多').attributes('aria-busy')).toBeUndefined()
  })

  it('ExamsView pull refresh failing after the child was switched shows no error', async () => {
    mock.onGet(url('s1')).replyOnce(200, { items: [exam(1)], total: 1 })
    const { wrapper } = await mountView('s1')
    const refreshing = deferredReply()
    mock.onGet(url('s1')).replyOnce(refreshing.reply)
    mock.onGet(url('s2')).reply(200, { items: [exam(21)], total: 1 })
    const pending = wrapper.getComponent(PullToRefresh).props('onRefresh')()

    useChildrenStore().select('s2')
    await flushPromises()
    refreshing.resolve([500, SERVER_ERROR])
    await pending
    await flushPromises()

    expect(useSnackbarStore().items).toEqual([])
    expect(names(wrapper)).toEqual(['第 21 次考試'])
  })

  it('ExamsView pull refresh recovers from the error state', async () => {
    mock.onGet(url('s1')).replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')
    expect(wrapper.text()).toContain('成績載入失敗')
    mock.onGet(url('s1')).replyOnce(200, { items: [exam(1)], total: 1 })

    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.text()).not.toContain('成績載入失敗')
  })

  it('ExamsView loads the child list on mount and waits for the selection before requesting exams', async () => {
    mock.onGet('/parent/children').reply(200, KIDS)
    mock.onGet(url('s1')).reply(200, { items: [exam(1)], total: 1 })
    mounted = await mountWithApp(ExamsView, {
      piniaInitialState: { parentChildren: { items: [], loaded: false, selectedId: null } },
    })

    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children', '/parent/children/s1/exams'])
    expect(rows(mounted.wrapper)).toHaveLength(1)
    expect(mounted.wrapper.get('.cch__name').text()).toBe('王小明')
  })

  it('ExamsView shows the empty state without requesting exams when there is no child', async () => {
    const { wrapper } = await mountView(null, { items: [], loaded: true })

    expect(mock.history.get).toHaveLength(0)
    expect(wrapper.text()).toContain('目前沒有已公布的成績')
  })

  it('ExamsView shows the error state when the child list cannot be loaded and retries it', async () => {
    mock.onGet('/parent/children').replyOnce(500, SERVER_ERROR)
    mounted = await mountWithApp(ExamsView, {
      piniaInitialState: { parentChildren: { items: [], loaded: false, selectedId: null } },
    })
    expect(mounted.wrapper.text()).toContain('成績載入失敗')

    mock.onGet('/parent/children').replyOnce(200, KIDS)
    mock.onGet(url('s1')).reply(200, { items: [exam(1)], total: 1 })
    await button(mounted.wrapper, '重試').trigger('click')
    await flushPromises()

    expect(rows(mounted.wrapper)).toHaveLength(1)
    expect(mounted.wrapper.text()).not.toContain('成績載入失敗')
  })
})
