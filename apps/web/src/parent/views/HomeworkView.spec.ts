import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { ChildSummary } from '../api/children'
import type { HomeworkToday } from '../api/homework'
import { parentHttp } from '../api/http'
import PullToRefresh from '../components/PullToRefresh.vue'
import { useChildrenStore } from '../stores/children'
import { useParentWsStore } from '../stores/parentWs'
import { useSnackbarStore } from '../stores/snackbar'
import HomeworkView from './HomeworkView.vue'

// 最小假 WebSocket：只做 parentWs store 需要的 open / message
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  close(): void {
    this.readyState = 3
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverMessage(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

// 系統時間固定台北 2026-10-02 16:00（UTC 08:00）
const NOW = new Date('2026-10-02T08:00:00Z')
const TODAY = '2026-10-02'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }

function child(id: string, name: string, grade = 3): ChildSummary {
  return { id, name, grade_level: grade, class_name: '中年級 A 班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華', 1)]

function homework(studentId: string, overrides: Partial<HomeworkToday> = {}): HomeworkToday {
  return {
    student_id: studentId,
    date: TODAY,
    items: [
      { title: '生字練習第 5 課', subject_name: '國語', status: 'done' },
      { title: '習作 p.32–33', subject_name: '數學', status: 'correcting' },
      { title: '學校通知單簽名', subject_name: null, status: 'todo' },
    ],
    overall_status: 'in_progress',
    ready_eta: '17:30',
    note: '國語生字訂正',
    updated_at: '2026-10-02T08:05:00Z',
    ...overrides,
  }
}

const url = (childId: string) => `/parent/children/${childId}/homework`

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
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  mock = createApiMock(parentHttp)
})

afterEach(() => {
  if (mounted) useParentWsStore().disconnect()
  mounted?.wrapper.unmount()
  mounted = null
  mock.restore()
  vi.useRealTimers()
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

async function mountView(
  selectedId: string | null = 's1',
  state: { items?: ChildSummary[]; loaded?: boolean } = {},
): Promise<MountedApp> {
  mounted = await mountWithApp(HomeworkView, {
    piniaInitialState: {
      parentChildren: { items: state.items ?? KIDS, loaded: state.loaded ?? true, selectedId },
    },
  })
  return mounted
}

type Wrapper = MountedApp['wrapper']

const text = (w: Wrapper) => w.text()
const rows = (w: Wrapper) => w.findAll('ul[aria-label="今日作業項目"] > li')
const homeworkGets = (childId: string) => mock.history.get.filter((r) => r.url === url(childId)).length

function button(w: Wrapper, label: string) {
  const found = w.findAll('button').find((b) => b.text().includes(label))
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

describe('HomeworkView', () => {
  it('HomeworkView lists items with summary', async () => {
    mock.onGet(url('s1')).reply(200, homework('s1'))

    const { wrapper } = await mountView()

    expect(homeworkGets('s1')).toBe(1)
    expect(text(wrapper)).toContain('已完成 1/3 項')
    expect(wrapper.get('.hws-head .status-pill').text()).toBe('進行中')
    expect(text(wrapper)).toContain('預計 17:30 可接送')
    expect(wrapper.get('.hws-eta__time').text()).toBe('17:30')
    expect(text(wrapper)).toContain('老師說明：國語生字訂正')
    expect(text(wrapper)).toContain('最後更新 16:05')
    expect(rows(wrapper)).toHaveLength(3)
    expect(wrapper.get('ul[aria-label="今日作業項目"]').attributes('role')).toBe('list')
    // 小標：作業進度 + 日期；作業項目 + 共 N 項
    expect(text(wrapper)).toContain('作業進度')
    expect(text(wrapper)).toContain('10/02（五）')
    expect(text(wrapper)).toContain('共 3 項')
    // 進度條：1/3、裝飾
    const bar = wrapper.get('.hws-bar')
    expect(bar.attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('.hws-bar__fill').attributes('style')).toContain('width: 33.')
    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
  })

  it('HomeworkView keeps the backend item order and note line breaks', async () => {
    mock.onGet(url('s1')).reply(
      200,
      homework('s1', {
        note: '數學習作訂正中\n國語已完成',
        items: [
          { title: 'B 項', subject_name: '數學', status: 'todo' },
          { title: 'A 項', subject_name: '國語', status: 'done' },
        ],
      }),
    )

    const { wrapper } = await mountView()

    expect(rows(wrapper).map((r) => r.get('.hw-row__title').text())).toEqual(['B 項', 'A 項'])
    expect(wrapper.get('.hws-note').text()).toBe('老師說明：數學習作訂正中\n國語已完成')
  })

  it('HomeworkView shows eta fallback', async () => {
    mock.onGet(url('s1')).reply(
      200,
      homework('s1', {
        items: [
          { title: '生字練習第 5 課', subject_name: '國語', status: 'doing' },
          { title: '習作 p.32–33', subject_name: '數學', status: 'todo' },
        ],
        ready_eta: null,
        note: null,
        updated_at: null,
      }),
    )

    const { wrapper } = await mountView()

    expect(text(wrapper)).toContain('老師尚未提供預計時間')
    expect(wrapper.get('.hws-eta').classes()).toContain('is-muted')
    // 退回文案本身含「預計」二字：斷言的是沒有「預計 HH:MM 可接送」這一行
    expect(text(wrapper)).not.toMatch(/預計\s*\d{2}:\d{2}\s*可接送/)
    expect(wrapper.find('.hws-eta__time').exists()).toBe(false)
    expect(text(wrapper)).not.toContain('老師說明')
    expect(text(wrapper)).not.toContain('最後更新')
    expect(text(wrapper)).toContain('已完成 0/2 項')
  })

  it('HomeworkView done overall shows ready to pick up', async () => {
    mock.onGet(url('s1')).reply(
      200,
      homework('s1', {
        overall_status: 'done',
        ready_eta: '17:30',
        items: [
          { title: '生字練習第 5 課', subject_name: '國語', status: 'done' },
          { title: '習作 p.32–33', subject_name: '數學', status: 'done' },
        ],
      }),
    )

    const { wrapper } = await mountView()

    expect(text(wrapper)).toContain('作業已完成，可以來接送了')
    expect(wrapper.get('.hws-eta').classes()).toContain('is-done')
    expect(text(wrapper)).not.toContain('預計 17:30 可接送')
    expect(wrapper.get('.hws-head .status-pill').text()).toBe('已完成')
    expect(wrapper.get('.hws-bar__fill').attributes('style')).toContain('width: 100%')
  })

  it('HomeworkView loads children on mount', async () => {
    const kids = deferredReply()
    mock.onGet('/parent/children').reply(kids.reply)
    mock.onGet(url('s1')).reply(200, homework('s1'))

    const { wrapper } = await mountView(null, { items: [], loaded: false })

    // 小孩清單載入中：身分卡位置骨架，尚未打作業 API
    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children'])
    expect(wrapper.find('.hwv-cch-skeleton').exists()).toBe(true)
    expect(wrapper.find('.cch').exists()).toBe(false)

    kids.resolve([200, [{ ...child('s1', '王小明'), grade_level: 3 }]])
    await flushPromises()

    expect(mock.history.get.filter((r) => r.url === '/parent/children')).toHaveLength(1)
    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children', '/parent/children/s1/homework'])
    expect(wrapper.find('.hwv-cch-skeleton').exists()).toBe(false)
    expect(wrapper.get('.cch__name').text()).toBe('王小明')
    expect(text(wrapper)).toContain('已完成 1/3 項')
  })

  it('HomeworkView switching child requests new id', async () => {
    mock.onGet(url('s1')).reply(200, homework('s1'))
    mock.onGet(url('s2')).reply(
      200,
      homework('s2', { items: [{ title: '注音練習', subject_name: '國語', status: 'done' }], overall_status: 'done', note: null }),
    )
    const { wrapper } = await mountView('s1')
    expect(text(wrapper)).toContain('已完成 1/3 項')

    await wrapper.get('.cch').trigger('click')
    const options = Array.from(document.body.querySelectorAll<HTMLElement>('.cch-option'))
    options[1]!.click()
    await flushPromises()

    expect(useChildrenStore().selectedId).toBe('s2')
    expect(homeworkGets('s2')).toBe(1)
    expect(text(wrapper)).toContain('已完成 1/1 項')
    expect(text(wrapper)).toContain('作業已完成，可以來接送了')
    expect(rows(wrapper).map((r) => r.get('.hw-row__title').text())).toEqual(['注音練習'])
    expect(wrapper.get('.cch__name').text()).toBe('王小華')
  })

  it('HomeworkView shows cached child without skeleton', async () => {
    mock.onGet(url('s1')).replyOnce(200, homework('s1'))
    mock.onGet(url('s2')).replyOnce(200, homework('s2', { items: [], overall_status: 'not_started', note: null }))
    const { wrapper } = await mountView('s1')
    useChildrenStore().select('s2')
    await flushPromises()
    expect(text(wrapper)).toContain('今天還沒有作業項目')

    const again = deferredReply()
    mock.onGet(url('s1')).replyOnce(again.reply)
    useChildrenStore().select('s1')
    await flushPromises()

    // 第二次 GET s1 尚未回應：立刻顯示快取，背景重抓
    expect(homeworkGets('s1')).toBe(2)
    expect(text(wrapper)).toContain('已完成 1/3 項')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(false)

    again.resolve([200, homework('s1', { items: [{ title: '生字練習第 5 課', subject_name: '國語', status: 'done' }] })])
    await flushPromises()
    expect(text(wrapper)).toContain('已完成 1/1 項')
  })

  it('HomeworkView first load shows skeleton', async () => {
    const first = deferredReply()
    mock.onGet(url('s1')).reply(first.reply)

    const { wrapper } = await mountView()

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.find('.skeleton--card').exists()).toBe(true)
    expect(wrapper.findAll('.skeleton-row')).toHaveLength(3)
    expect(text(wrapper)).not.toContain('已完成')
    expect(text(wrapper)).not.toContain('作業進度載入失敗')
    // 尚無資料：日期與「共 N 項」不顯示；載入中停用下拉
    expect(text(wrapper)).not.toContain('10/02')
    expect(text(wrapper)).not.toContain('共 ')
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)

    first.resolve([200, homework('s1')])
    await flushPromises()
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(false)
  })

  it('HomeworkView empty state', async () => {
    mock.onGet(url('s1')).replyOnce(200, homework('s1', { items: [], overall_status: 'not_started', ready_eta: null, note: null }))
    const empty = await mountView()

    expect(text(empty.wrapper)).toContain('今天還沒有作業項目')
    expect(text(empty.wrapper)).toContain('老師登記作業後會顯示在這裡')
    expect(text(empty.wrapper)).toContain('今日作業')
    expect(text(empty.wrapper)).not.toContain('已完成 0/0 項')
    expect(empty.wrapper.find('.hws-bar').exists()).toBe(false)
    expect(empty.wrapper.get('.empty-state .m3-icon').text()).toBe('assignment')
    expect(text(empty.wrapper)).not.toContain('共 0 項')
    expect(rows(empty.wrapper)).toHaveLength(0)
    useParentWsStore().disconnect()
    empty.wrapper.unmount()
    mounted = null

    mock.onGet(url('s1')).replyOnce(
      200,
      homework('s1', { items: [], overall_status: 'done', ready_eta: null, note: '今天學校校外教學，沒有回家作業' }),
    )
    const doneEmpty = await mountView()

    expect(text(doneEmpty.wrapper)).toContain('老師已標記今日作業完成')
    expect(text(doneEmpty.wrapper)).toContain('作業已完成，可以來接送了')
    expect(text(doneEmpty.wrapper)).toContain('老師說明：今天學校校外教學，沒有回家作業')
    expect(doneEmpty.wrapper.get('.empty-state .m3-icon').text()).toBe('done_all')
    expect(text(doneEmpty.wrapper)).not.toContain('今天還沒有作業項目')
  })

  it('HomeworkView error with retry', async () => {
    mock.onGet(url('s1')).replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView()

    expect(text(wrapper)).toContain('作業進度載入失敗')
    expect(text(wrapper)).toContain('請檢查網路連線後再試一次')
    expect(wrapper.get('.empty-state').attributes('role')).toBe('alert')
    expect(wrapper.find('.hws').exists()).toBe(false)
    expect(wrapper.find('.hwv-error').exists()).toBe(false)

    const again = deferredReply()
    mock.onGet(url('s1')).replyOnce(again.reply)
    await button(wrapper, '重試').trigger('click')
    await flushPromises()

    expect(homeworkGets('s1')).toBe(2)
    // 重試期間回到骨架
    expect(wrapper.find('.skeleton--card').exists()).toBe(true)
    expect(text(wrapper)).not.toContain('作業進度載入失敗')

    again.resolve([200, homework('s1')])
    await flushPromises()
    expect(text(wrapper)).toContain('已完成 1/3 項')
  })

  it('HomeworkView keeps stale data on refresh error', async () => {
    mock.onGet(url('s1')).replyOnce(200, homework('s1'))
    const { wrapper } = await mountView()
    mock.onGet(url('s1')).replyOnce(500, SERVER_ERROR)

    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(text(wrapper)).toContain('已完成 1/3 項')
    const alert = wrapper.get('.hwv-error')
    expect(alert.attributes('role')).toBe('alert')
    expect(alert.text()).toContain('作業進度載入失敗')
    expect(alert.get('.m3-icon').text()).toBe('error')
    const retry = alert.get('button')
    expect(retry.text()).toBe('重試')
    expect(retry.attributes('type')).toBe('button')
    // 下拉重新整理失敗只顯示錯誤列，不另跳 snackbar；錯誤列在摘要卡之前
    expect(useSnackbarStore().items).toHaveLength(0)
    const html = wrapper.html()
    expect(html.indexOf('hwv-error')).toBeLessThan(html.indexOf('class="m3-card m3-card--elevated'))

    mock.onGet(url('s1')).replyOnce(200, homework('s1', { note: '已更新' }))
    await retry.trigger('click')
    await flushPromises()
    expect(homeworkGets('s1')).toBe(3)
    expect(wrapper.find('.hwv-error').exists()).toBe(false)
    expect(text(wrapper)).toContain('老師說明：已更新')
  })

  it('HomeworkView pull to refresh reloads the selected child', async () => {
    mock.onGet(url('s1')).replyOnce(200, homework('s1'))
    const { wrapper } = await mountView()
    const refreshed = deferredReply()
    mock.onGet(url('s1')).replyOnce(refreshed.reply)

    const pending = wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()
    // 重新整理期間保留內容、不閃骨架
    expect(text(wrapper)).toContain('已完成 1/3 項')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)

    refreshed.resolve([200, homework('s1', { ready_eta: '18:00' })])
    await pending
    await flushPromises()
    expect(homeworkGets('s1')).toBe(2)
    expect(text(wrapper)).toContain('預計 18:00 可接送')
  })

  it('HomeworkView reflects ws update', async () => {
    mock.onGet(url('s1')).replyOnce(200, homework('s1'))
    const { wrapper } = await mountView()
    const ws = useParentWsStore()
    ws.connect()
    const socket = FakeWebSocket.instances.at(-1)!
    socket.serverOpen()

    socket.serverMessage({
      type: 'homework.progress_updated',
      data: {
        student_id: 's1',
        date: TODAY,
        items: [
          { title: '生字練習第 5 課', subject_name: '國語', status: 'done' },
          { title: '習作 p.32–33', subject_name: '數學', status: 'done' },
          { title: '學校通知單簽名', subject_name: null, status: 'done' },
        ],
        overall_status: 'done',
        ready_eta: '17:30',
        note: '全部完成',
      },
      sent_at: '2026-10-02T08:20:00Z',
    })
    await flushPromises()

    expect(text(wrapper)).toContain('作業已完成，可以來接送了')
    expect(text(wrapper)).toContain('已完成 3/3 項')
    expect(text(wrapper)).toContain('老師說明：全部完成')
    expect(text(wrapper)).toContain('最後更新 16:20')
    // 不重新請求、不顯示骨架
    expect(homeworkGets('s1')).toBe(1)
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
  })

  it('HomeworkView children list error offers retry', async () => {
    mock.onGet('/parent/children').replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView(null, { items: [], loaded: false })
    await flushPromises()

    expect(text(wrapper)).toContain('作業進度載入失敗')
    expect(mock.history.get.filter((r) => (r.url ?? '').startsWith('/parent/children/'))).toHaveLength(0)

    mock.onGet('/parent/children').replyOnce(200, [child('s1', '王小明')])
    mock.onGet(url('s1')).reply(200, homework('s1'))
    await button(wrapper, '重試').trigger('click')
    await flushPromises()

    expect(mock.history.get.filter((r) => r.url === '/parent/children')).toHaveLength(2)
    expect(text(wrapper)).toContain('已完成 1/3 項')
  })

  it('HomeworkView shows an empty state when there are no children', async () => {
    const { wrapper } = await mountView(null, { items: [], loaded: true })
    await flushPromises()

    // 清單已載入（空）：不重抓小孩、不打作業 API
    expect(mock.history.get).toHaveLength(0)
    expect(text(wrapper)).toContain('今天還沒有作業項目')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    expect(text(wrapper)).not.toContain('作業進度載入失敗')
  })
})
