import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import type { Exam, ExamSummary } from '@/api/exams'
import { adminHttp } from '@/api/http'
import ExamFormDialog from '@/components/exams/ExamFormDialog.vue'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { createApiMock, mountWithApp } from '@/test/helpers'
import ExamDetailView from './ExamDetailView.vue'

/** ScoreGrid stub：flush 後的 hasUnsaved / failedCount 由測試決定，記錄呼叫次數 */
const grid = vi.hoisted(() => ({
  hasUnsaved: false,
  failedCount: 0,
  afterFlush: { hasUnsaved: false, failedCount: 0 },
  flushCalls: 0,
  reloadCalls: 0,
  mounts: 0,
  examIds: [] as string[],
  /** 目前掛載的 stub 的狀態，測試可直接改 */
  instance: null as null | { hasUnsaved: { value: boolean }; failedCount: { value: number } },
}))

vi.mock('@/components/exams/ScoreGrid.vue', async () => {
  const { defineComponent: define, h: render, ref } = await import('vue')
  return {
    default: define({
      name: 'ScoreGrid',
      props: { examId: { type: String, required: true }, canWrite: Boolean },
      setup(props, { expose }) {
        grid.mounts += 1
        grid.examIds.push(props.examId)
        const hasUnsaved = ref(grid.hasUnsaved)
        const failedCount = ref(grid.failedCount)
        grid.instance = { hasUnsaved, failedCount }
        expose({
          hasUnsaved,
          failedCount,
          flush: async () => {
            grid.flushCalls += 1
            hasUnsaved.value = grid.afterFlush.hasUnsaved
            failedCount.value = grid.afterFlush.failedCount
          },
          reload: async () => {
            grid.reloadCalls += 1
          },
        })
        return () => render('div', { class: 'score-grid-stub', 'data-exam': props.examId })
      },
    }),
  }
})

const EXAM_URL = '/admin/exams/e1'
const SUMMARY_URL = '/admin/exams/e1/summary'
const ALL = ['exams:read', 'exams:write', 'exams:publish']

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
  note: '範圍：國語第 1~4 課',
  subjects: [
    { subject_id: 'sub1', subject_name: '國語', full_score: 100, sort_order: 1 },
    { subject_id: 'sub2', subject_name: '數學', full_score: 100, sort_order: 2 },
  ],
  roster_count: 32,
  created_at: '2026-09-20T02:00:00Z',
}

const PUBLISHED: Exam = {
  ...DRAFT,
  status: 'published',
  published_at: '2026-10-05T09:00:00Z',
  published_by_name: '張主任',
}

function summary(missing: number[]): ExamSummary {
  return {
    exam_id: 'e1',
    roster_count: 32,
    subjects: missing.map((m, i) => ({
      subject_id: `sub${i + 1}`,
      subject_name: i === 0 ? '國語' : '數學',
      full_score: 100,
      scored_count: 30 - m,
      absent_count: 2,
      missing_count: m,
      average: 80,
      max: 100,
      min: 40,
    })),
  }
}

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [
  { path: '/exams', component: Stub },
  { path: '/exams/:id', component: ExamDetailView, props: true },
]
const Host = defineComponent({ render: () => h(RouterView) })

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountView(permissions: string[] = ALL, initialRoute = '/exams/e1') {
  const mounted = await mountWithApp(Host, {
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
  return { wrapper: mounted.wrapper as VueWrapper, router: mounted.router }
}

function getCount(url: string): number {
  return mock.history.get.filter((c) => c.url === url).length
}

function header(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find('.page-header')
}

function headerButtons(wrapper: VueWrapper): string[] {
  return header(wrapper)
    .findAll('button')
    .map((b) => b.text())
}

async function clickHeader(wrapper: VueWrapper, text: string): Promise<void> {
  const btn = header(wrapper)
    .findAll('button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  await btn.trigger('click')
  await settle()
  await settle()
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

async function clickTab(wrapper: VueWrapper, label: string): Promise<void> {
  const tab = wrapper.findAll('.el-tabs__item').find((t) => t.text() === label)
  if (!tab) throw new Error(`找不到分頁 ${label}`)
  await tab.trigger('click')
  await settle()
  await settle()
}

// 每個案例都掛整頁（PageHeader、el-tabs、確認框，部分再切分頁或導頁）；共用 CPU 高負載時單一案例可能超過預設 5 秒
describe('ExamDetailView', { timeout: 60000 }, () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
    Object.assign(grid, {
      hasUnsaved: false,
      failedCount: 0,
      afterFlush: { hasUnsaved: false, failedCount: 0 },
      flushCalls: 0,
      reloadCalls: 0,
      mounts: 0,
      examIds: [],
      instance: null,
    })
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('ExamDetailView renders header and status line', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    const { wrapper } = await mountView()

    expect(wrapper.find('h1').text()).toBe('第一次段考')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe('段考・10/15（四）・三年級・應考 32 人')
    const meta = wrapper.find('.exam-meta')
    expect(meta.find('.el-tag').text()).toBe('草稿')
    expect(meta.text()).toContain('尚未發布，家長看不到這次成績')
    expect(meta.find('.exam-meta__note').text()).toBe('備註：範圍：國語第 1~4 課')
    expect(meta.find('.exam-meta__note').attributes('title')).toBe('範圍：國語第 1~4 課')
    expect(wrapper.find('.back-link').text()).toBe('考試列表')
    expect(headerButtons(wrapper)).toEqual(['刪除', '編輯資訊', '發布'])
    expect(wrapper.findAll('.el-tabs__item').map((t) => t.text())).toEqual(['成績輸入', '各科平均', '科目設定'])
    expect(wrapper.find('.score-grid-stub').attributes('data-exam')).toBe('e1')
    wrapper.unmount()
    document.body.innerHTML = ''

    mock.resetHandlers()
    mock.onGet(EXAM_URL).reply(200, { ...PUBLISHED, note: null })
    const published = await mountView()
    const pmeta = published.wrapper.find('.exam-meta')
    expect(pmeta.find('.el-tag').text()).toBe('已發布')
    expect(pmeta.text()).toContain('張主任 於 2026/10/05 17:00 發布・修改分數會記錄於稽核紀錄')
    expect(pmeta.find('.exam-meta__note').exists()).toBe(false)
    expect(headerButtons(published.wrapper)).toEqual(['編輯資訊', '取消發布'])
  })

  it('ExamDetailView publishes with missing count warning', async () => {
    mock.onGet(EXAM_URL).replyOnce(200, DRAFT).onGet(EXAM_URL).reply(200, PUBLISHED)
    mock.onGet(SUMMARY_URL).reply(200, summary([2, 1]))
    mock.onPost('/admin/exams/e1/publish').reply(200, PUBLISHED)
    const { wrapper } = await mountView()

    await clickHeader(wrapper, '發布')
    expect(grid.flushCalls).toBe(1)
    expect(getCount(SUMMARY_URL)).toBe(1)
    const box = lastMessageBox()
    expect(box?.querySelector('.el-message-box__title')?.textContent).toContain('發布成績')
    expect(box?.textContent).toContain(
      '發布後家長即可查看成績並收到通知。尚有 3 格未填，家長會看到「未登記」。確定發布嗎？',
    )
    expect(mock.history.post).toHaveLength(0)
    await answerMessageBox('發布')

    expect(mock.history.post.map((c) => c.url)).toEqual(['/admin/exams/e1/publish'])
    expect(document.body.textContent).toContain('已發布，家長會收到成績通知')
    expect(wrapper.find('.exam-meta .el-tag').text()).toBe('已發布')
    expect(getCount(EXAM_URL)).toBe(2)
    expect(grid.reloadCalls).toBe(1)
    expect(headerButtons(wrapper)).toEqual(['編輯資訊', '取消發布'])
  })

  it('ExamDetailView publish confirmation omits missing sentence when complete', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    mock.onGet(SUMMARY_URL).reply(200, summary([0, 0]))
    const { wrapper } = await mountView()

    await clickHeader(wrapper, '發布')
    expect(lastMessageBox()?.textContent).toContain('發布後家長即可查看成績並收到通知。確定發布嗎？')
    expect(lastMessageBox()?.textContent).not.toContain('尚有')
    await answerMessageBox('取消')
    expect(mock.history.post).toHaveLength(0)
  })

  it('ExamDetailView unpublish confirmation', async () => {
    mock.onGet(EXAM_URL).replyOnce(200, PUBLISHED).onGet(EXAM_URL).reply(200, DRAFT)
    mock.onPost('/admin/exams/e1/unpublish').reply(200, DRAFT)
    const { wrapper } = await mountView()

    await clickHeader(wrapper, '取消發布')
    const box = lastMessageBox()
    expect(box?.textContent).toContain('取消發布後家長將看不到此次成績，已送出的通知不會收回。')
    const buttons = Array.from(box?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim())
    expect(buttons).toContain('返回')
    await answerMessageBox('取消發布')

    expect(mock.history.post.map((c) => c.url)).toEqual(['/admin/exams/e1/unpublish'])
    expect(document.body.textContent).toContain('已取消發布')
    expect(wrapper.find('.exam-meta .el-tag').text()).toBe('草稿')
    expect(grid.reloadCalls).toBe(1)
  })

  it('ExamDetailView no subjects publish error switches tab', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    mock.onGet(SUMMARY_URL).reply(200, summary([0, 0]))
    mock.onGet('/admin/subjects').reply(200, [])
    mock.onPost('/admin/exams/e1/publish').reply(422, {
      error: { code: 'exam_has_no_subjects', message: '考試尚未設定科目', details: null },
    })
    const { wrapper, router } = await mountView()

    await clickHeader(wrapper, '發布')
    await answerMessageBox('發布')

    expect(document.body.textContent).toContain('請先設定科目')
    expect(router.currentRoute.value.query.tab).toBe('subjects')
    expect(router.currentRoute.value.path).toBe('/exams/e1')
    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('科目設定')
  })

  it('ExamDetailView permission based actions', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    const reader = await mountView(['exams:read'])
    expect(headerButtons(reader.wrapper)).toEqual([])
    expect(header(reader.wrapper).text()).toContain('你只有檢視權限')
    reader.wrapper.unmount()
    document.body.innerHTML = ''

    const tutor = await mountView(['exams:read', 'exams:write'])
    expect(headerButtons(tutor.wrapper)).toEqual(['刪除', '編輯資訊'])
    expect(header(tutor.wrapper).text()).not.toContain('你只有檢視權限')
    tutor.wrapper.unmount()
    document.body.innerHTML = ''

    const publisher = await mountView(['exams:read', 'exams:publish'])
    expect(headerButtons(publisher.wrapper)).toEqual(['發布'])
    expect(header(publisher.wrapper).text()).not.toContain('你只有檢視權限')
  })

  it('ExamDetailView not found', async () => {
    mock.onGet('/admin/exams/zz').reply(404, { error: { code: 'not_found', message: '找不到資料', details: null } })
    const { wrapper, router } = await mountView(ALL, '/exams/zz')

    expect(wrapper.text()).toContain('找不到此考試')
    expect(wrapper.text()).toContain('這場考試可能已被刪除，或網址不正確')
    expect(wrapper.find('.page-header').exists()).toBe(false)
    const back = wrapper.findAll('button').find((b) => b.text() === '回考試列表')
    expect(back).toBeDefined()
    await back!.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/exams')
  })

  it('ExamDetailView load error retries', async () => {
    mock
      .onGet(EXAM_URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
      .onGet(EXAM_URL)
      .reply(200, DRAFT)
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入考試')
    const retry = wrapper.findAll('button').find((b) => b.text() === '重試')
    await retry!.trigger('click')
    await settle()
    expect(getCount(EXAM_URL)).toBe(2)
    expect(wrapper.find('h1').text()).toBe('第一次段考')
  })

  it('ExamDetailView guards leaving with unsaved cells', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    grid.hasUnsaved = true
    grid.afterFlush = { hasUnsaved: true, failedCount: 1 }
    const { router } = await mountView()

    const nav = router.push('/exams')
    await settle()
    await settle()
    expect(grid.flushCalls).toBe(1)
    expect(lastMessageBox()?.textContent).toContain('尚未儲存的變更將會遺失，確定要放棄變更嗎？')
    await answerMessageBox('繼續編輯')
    await nav
    expect(router.currentRoute.value.path).toBe('/exams/e1')

    // 選「放棄變更」就離開
    const discard = router.push('/exams')
    await settle()
    await settle()
    await answerMessageBox('放棄變更')
    await discard
    expect(router.currentRoute.value.path).toBe('/exams')
    document.body.innerHTML = ''

    // flush 後沒有未儲存的格子：直接離開、不出現確認框
    grid.flushCalls = 0
    grid.hasUnsaved = true
    grid.afterFlush = { hasUnsaved: false, failedCount: 0 }
    const second = await mountView()
    await second.router.push('/exams')
    await settle()
    expect(grid.flushCalls).toBe(1)
    expect(second.router.currentRoute.value.path).toBe('/exams')
    expect(document.body.querySelector('.el-message-box')).toBeNull()
  })

  it('ExamDetailView reloads on status conflict', async () => {
    mock.onGet(EXAM_URL).replyOnce(200, PUBLISHED).onGet(EXAM_URL).reply(200, DRAFT)
    mock.onPost('/admin/exams/e1/unpublish').reply(409, {
      error: { code: 'exam_not_published', message: '考試尚未發布', details: null },
    })
    const { wrapper } = await mountView()
    expect(getCount(EXAM_URL)).toBe(1)

    await clickHeader(wrapper, '取消發布')
    await answerMessageBox('取消發布')

    expect(document.body.textContent).toContain('考試狀態已變更，已重新載入')
    expect(getCount(EXAM_URL)).toBe(2)
    expect(grid.reloadCalls).toBe(1)
    expect(wrapper.find('.exam-meta .el-tag').text()).toBe('草稿')
  })

  it('ExamDetailView blocks publish when cells failed', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    grid.hasUnsaved = true
    grid.afterFlush = { hasUnsaved: true, failedCount: 2 }
    const { wrapper } = await mountView()

    await clickHeader(wrapper, '發布')

    expect(grid.flushCalls).toBe(1)
    expect(document.body.textContent).toContain('有 2 格成績尚未儲存成功，請先重試後再發布')
    expect(getCount(SUMMARY_URL)).toBe(0)
    expect(mock.history.post).toHaveLength(0)
    expect(document.body.querySelector('.el-message-box')).toBeNull()
  })

  it('ExamDetailView reloads after editing info', async () => {
    const renamed = { ...DRAFT, name: '第一次段考（補）' }
    mock.onGet(EXAM_URL).replyOnce(200, DRAFT).onGet(EXAM_URL).reply(200, renamed)
    const { wrapper } = await mountView()
    expect(wrapper.findComponent(ExamFormDialog).props('modelValue')).toBe(false)
    await clickHeader(wrapper, '編輯資訊')
    expect(wrapper.findComponent(ExamFormDialog).props('modelValue')).toBe(true)
    expect(wrapper.findComponent(ExamFormDialog).props('exam')).toEqual(DRAFT)

    wrapper.findComponent(ExamFormDialog).vm.$emit('saved', renamed)
    await settle()
    await settle()

    expect(getCount(EXAM_URL)).toBe(2)
    expect(grid.reloadCalls).toBe(1)
    expect(wrapper.find('h1').text()).toBe('第一次段考（補）')

    // flush 後仍有未儲存的格子：確認放棄 → 重建成績格（丟棄未儲存的格子），不是只重新載入
    grid.hasUnsaved = true
    grid.afterFlush = { hasUnsaved: true, failedCount: 1 }
    grid.mounts = 0
    // 讓目前的 stub 也進入「仍有未儲存」狀態
    grid.instance!.hasUnsaved.value = true
    wrapper.findComponent(ExamFormDialog).vm.$emit('saved', renamed)
    await settle()
    await settle()
    expect(lastMessageBox()?.textContent).toContain('尚未儲存的變更將會遺失，確定要放棄變更嗎？')
    await answerMessageBox('放棄變更')
    expect(grid.reloadCalls).toBe(1)
    expect(grid.mounts).toBe(1)
  })

  it('ExamDetailView guards switching exam id with unsaved cells', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    mock.onGet('/admin/exams/e2').reply(200, { ...DRAFT, id: 'e2', name: '第二次段考' })
    grid.hasUnsaved = true
    grid.afterFlush = { hasUnsaved: true, failedCount: 0 }
    const { wrapper, router } = await mountView()

    const nav = router.push('/exams/e2')
    await settle()
    await settle()
    expect(grid.flushCalls).toBe(1)
    expect(lastMessageBox()?.textContent).toContain('尚未儲存的變更將會遺失，確定要放棄變更嗎？')
    await answerMessageBox('繼續編輯')
    await nav
    expect(router.currentRoute.value.path).toBe('/exams/e1')
    expect(getCount('/admin/exams/e2')).toBe(0)

    // 放棄變更：換到 e2，成績格以 e2 掛載
    const go = router.push('/exams/e2')
    await settle()
    await settle()
    await answerMessageBox('放棄變更')
    await go
    await settle()
    expect(router.currentRoute.value.path).toBe('/exams/e2')
    expect(getCount('/admin/exams/e2')).toBe(1)
    expect(wrapper.find('h1').text()).toBe('第二次段考')
    expect(wrapper.find('.score-grid-stub').attributes('data-exam')).toBe('e2')

    // 只換分頁（query）不觸發成績格的離開保護
    grid.flushCalls = 0
    await clickTab(wrapper, '各科平均')
    expect(grid.flushCalls).toBe(0)
  })

  it('ExamDetailView refreshes summary when switching to its tab', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    mock.onGet(SUMMARY_URL).reply(200, summary([1, 0]))
    const { wrapper, router } = await mountView()
    expect(getCount(SUMMARY_URL)).toBe(0)

    await clickTab(wrapper, '各科平均')
    expect(router.currentRoute.value.query.tab).toBe('summary')
    expect(getCount(SUMMARY_URL)).toBe(1)
    expect(wrapper.text()).toContain('應考 32 人')

    await clickTab(wrapper, '成績輸入')
    await clickTab(wrapper, '各科平均')
    expect(getCount(SUMMARY_URL)).toBe(2)
    // 成績格切走不卸載
    expect(grid.mounts).toBe(1)
  })

  it('ExamDetailView deletes draft and leaves without guard', async () => {
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    mock.onDelete(EXAM_URL).reply(204)
    grid.hasUnsaved = true
    grid.afterFlush = { hasUnsaved: true, failedCount: 1 }
    const { wrapper, router } = await mountView()

    await clickHeader(wrapper, '刪除')
    expect(lastMessageBox()?.textContent).toContain('刪除後已輸入的成績會一併刪除，確定要刪除「第一次段考」嗎？')
    await answerMessageBox('刪除')
    await settle()

    expect(mock.history.delete.map((c) => c.url)).toEqual([EXAM_URL])
    expect(document.body.textContent).toContain('已刪除')
    expect(router.currentRoute.value.path).toBe('/exams')
    // 考試已刪除：不再送出成績格、也不詢問放棄變更
    expect(grid.flushCalls).toBe(0)
  })

  it('ExamDetailView unpublish flushes and confirms before rebuilding grid', async () => {
    // ScoreGrid stub 模擬「有一格送出失敗（PUT 500），flush 重送後仍失敗」
    mock.onGet(EXAM_URL).reply(200, PUBLISHED)
    mock.onPost('/admin/exams/e1/unpublish').reply(200, DRAFT)
    grid.hasUnsaved = true
    grid.failedCount = 1
    grid.afterFlush = { hasUnsaved: true, failedCount: 1 }
    const { wrapper } = await mountView()
    expect(grid.mounts).toBe(1)

    await clickHeader(wrapper, '取消發布')
    await answerMessageBox('取消發布')
    expect(grid.flushCalls).toBe(1)
    expect(lastMessageBox()?.textContent).toContain('尚未儲存的變更將會遺失，確定要放棄變更嗎？')
    await answerMessageBox('繼續編輯')
    expect(mock.history.post).toHaveLength(0)
    expect(grid.mounts).toBe(1)

    await clickHeader(wrapper, '取消發布')
    await answerMessageBox('取消發布')
    expect(grid.flushCalls).toBe(2)
    await answerMessageBox('放棄變更')
    expect(mock.history.post.map((c) => c.url)).toEqual(['/admin/exams/e1/unpublish'])
    // 以 key 重建成績格（丟棄未儲存的格子、回到伺服器值），不是只 reload
    expect(grid.mounts).toBe(2)
    expect(grid.reloadCalls).toBe(0)
  })

  it('ExamDetailView ignores stale scored counts', async () => {
    const E2 = { ...DRAFT, id: 'e2', name: '第二次段考' }
    mock.onGet(EXAM_URL).reply(200, DRAFT)
    mock.onGet('/admin/exams/e2').reply(200, E2)
    mock.onGet('/admin/subjects').reply(200, [])
    let releaseE1: (() => void) | undefined
    let e1Calls = 0
    mock.onGet(SUMMARY_URL).reply(() => {
      e1Calls += 1
      // e1 的 summary 回應延後到切到 e2、e2 已回應之後才送達
      return new Promise((resolve) => {
        releaseE1 = () => resolve([200, summary([5, 5])])
      })
    })
    mock.onGet('/admin/exams/e2/summary').reply(200, {
      ...summary([1, 2]),
      exam_id: 'e2',
    })
    const { wrapper, router } = await mountView(ALL, '/exams/e1?tab=subjects')
    expect(e1Calls).toBe(1)

    await router.push('/exams/e2?tab=subjects')
    await settle()
    await settle()
    const editor = wrapper.findComponent({ name: 'ExamSubjectsEditor' })
    expect(editor.props('scoredCounts')).toEqual({ sub1: 29, sub2: 28 })

    // e1 的回應晚到：不得覆蓋 e2 的筆數
    releaseE1!()
    await settle()
    await settle()
    expect(wrapper.findComponent({ name: 'ExamSubjectsEditor' }).props('scoredCounts')).toEqual({ sub1: 29, sub2: 28 })
  })

  it('ExamDetailView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.ExamDetailView()) as { default?: unknown }

    expect(loaded.default).toBe(ExamDetailView)
  })
})
