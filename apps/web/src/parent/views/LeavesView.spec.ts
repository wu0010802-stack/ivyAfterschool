import { DOMWrapper, flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import { _resetPublicConfigForTests } from '../api/config'
import type { ChildSummary } from '../api/children'
import { parentHttp } from '../api/http'
import type { LeaveAttachment, ParentLeave } from '../api/leaves'
import PullToRefresh from '../components/PullToRefresh.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'
import LeavesView from './LeavesView.vue'
import source from './LeavesView.vue?raw'

// 系統時間固定 2026-10-02 09:00 台北（UTC 01:00，週五）
const NOW = new Date('2026-10-02T01:00:00Z')
const KB = 1024

const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器錯誤', details: null } }
const err = (code: string, message = '錯誤', details: unknown = null) => ({ error: { code, message, details } })

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級 A 班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

function leave(id: string, overrides: Partial<ParentLeave> = {}): ParentLeave {
  return {
    id,
    student_id: 's1',
    leave_type: 'sick',
    leave_type_label: '病假',
    start_date: '2026-10-05',
    end_date: '2026-10-07',
    reason: null,
    status: 'active',
    created_by_type: 'parent',
    created_at: '2026-09-28T02:00:00Z',
    cancelled_at: null,
    can_cancel: false,
    attachments: [],
    ...overrides,
  }
}

function leaves(from: number, to: number): ParentLeave[] {
  return Array.from({ length: to - from + 1 }, (_, i) => leave(`l${from + i}`, { start_date: '2026-09-10', end_date: '2026-09-10' }))
}

function attachment(id: string, overrides: Partial<LeaveAttachment> = {}): LeaveAttachment {
  return {
    id,
    mime_type: 'image/jpeg',
    size_bytes: 2 * KB,
    created_at: '2026-10-02T01:00:00Z',
    url: `https://files.example.test/${id}.jpg`,
    ...overrides,
  }
}

const listUrl = (childId: string) => `/parent/children/${childId}/leaves`
const PAGE1 = { params: { page: 1, page_size: 20 } }
const PAGE2 = { params: { page: 2, page_size: 20 } }

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
  _resetPublicConfigForTests()
  mock = createApiMock(parentHttp)
})

afterEach(() => {
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
  mounted = await mountWithApp(LeavesView, {
    piniaInitialState: {
      parentChildren: { items: state.items ?? KIDS, loaded: state.loaded ?? true, selectedId },
    },
  })
  return mounted
}

type Wrapper = MountedApp['wrapper']

const rows = (w: Wrapper) => w.findAll('li.leave-item')
const body = () => document.body

function button(root: Wrapper | ParentNode, label: string): HTMLButtonElement {
  const scope: ParentNode = 'element' in root ? (root as Wrapper).element : root
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.includes(label))
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('找不到要點擊的元素')
  await new DOMWrapper(el).trigger('click')
}

function sheet(title: string): HTMLElement | null {
  return (
    Array.from(body().querySelectorAll<HTMLElement>('[role="dialog"]')).find(
      (s) => s.querySelector('h2')?.textContent?.trim() === title,
    ) ?? null
  )
}

function formSheet(): HTMLElement {
  const s = sheet('申請請假')
  if (!s) throw new Error('申請 sheet 沒有開啟')
  return s
}

const alertDialog = () => body().querySelector<HTMLElement>('[role="alertdialog"]')

async function openForm(w: Wrapper): Promise<HTMLElement> {
  await click(button(w, '申請請假'))
  await flushPromises()
  return formSheet()
}

function makeFile(name: string, type: string, size = KB): File {
  const file = new File([''], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

async function pickFile(file: File): Promise<void> {
  const input = formSheet().querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('找不到新增附件 input')
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await new DOMWrapper(input).trigger('change')
}

async function submitForm(): Promise<void> {
  const submit = formSheet().querySelector<HTMLButtonElement>('button[type="submit"]')
  if (!submit) throw new Error('找不到送出鈕')
  submit.click()
  await flushPromises()
}

function snackbarItems() {
  return useSnackbarStore().items.map((i) => [i.message, i.tone])
}

function postBody(index: number): Record<string, unknown> {
  return JSON.parse(mock.history.post[index]!.data as string) as Record<string, unknown>
}

function queryParams(index: number): unknown {
  return mock.history.get[index]?.params
}

describe('LeavesView', () => {
  it('LeavesView lists leaves for selected child', async () => {
    mock.onGet(listUrl('s2')).reply(200, { items: [leave('l1'), leave('l2', { leave_type: 'personal', leave_type_label: '事假' })], total: 2 })

    const { wrapper } = await mountView('s2')

    const listCalls = mock.history.get.filter((r) => r.url === '/parent/children/s2/leaves')
    expect(listCalls).toHaveLength(1)
    expect(listCalls[0]!.params).toEqual({ page: 1, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(2)
    expect(wrapper.text()).not.toContain('載入更多')
    expect(wrapper.get('ul[aria-label="請假紀錄"]').attributes('role')).toBe('list')
    expect(wrapper.get('.lv-section__title').text()).toBe('請假紀錄')
    expect(wrapper.get('.lv-section__count').text()).toBe('共 2 筆')
    expect(wrapper.get('.cch__name').text()).toBe('王小華')
    expect(wrapper.find('.skeleton').exists()).toBe(false)
  })

  it('LeavesView shows a row skeleton while the first page loads and disables pull to refresh', async () => {
    const first = deferredReply()
    mock.onGet(listUrl('s1')).reply(first.reply)

    const { wrapper } = await mountView('s1')

    expect(wrapper.get('.skeleton--row').attributes('aria-busy')).toBe('true')
    expect(wrapper.findAll('.skeleton-row')).toHaveLength(3)
    expect(wrapper.getComponent(PullToRefresh).props('disabled')).toBe(true)
    // 「申請請假」在載入中照常可用
    expect(button(wrapper, '申請請假').disabled).toBe(false)

    first.resolve([200, { items: [leave('l1')], total: 1 }])
    await flushPromises()

    expect(wrapper.find('.skeleton').exists()).toBe(false)
    expect(rows(wrapper)).toHaveLength(1)
  })

  it('LeavesView load more appends', async () => {
    mock.onGet(listUrl('s1'), PAGE1).reply(200, { items: leaves(1, 20), total: 25 })
    mock.onGet(listUrl('s1'), PAGE2).reply(200, { items: leaves(21, 25), total: 25 })
    const { wrapper } = await mountView('s1')
    expect(rows(wrapper)).toHaveLength(20)

    await click(button(wrapper, '載入更多'))
    await flushPromises()

    const listCalls = mock.history.get.filter((r) => r.url === '/parent/children/s1/leaves')
    expect(listCalls).toHaveLength(2)
    expect(listCalls[1]!.params).toEqual({ page: 2, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(25)
    expect(wrapper.text()).not.toContain('載入更多')
  })

  it('LeavesView load more dedupes by id', async () => {
    mock.onGet(listUrl('s1'), PAGE1).reply(200, { items: leaves(1, 20), total: 25 })
    mock.onGet(listUrl('s1'), PAGE2).reply(200, { items: [leave('l20'), ...leaves(21, 25)], total: 25 })
    const { wrapper } = await mountView('s1')

    await click(button(wrapper, '載入更多'))
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(25)
    expect(wrapper.text()).not.toContain('載入更多')
  })

  it('LeavesView load more failure keeps list', async () => {
    mock.onGet(listUrl('s1'), PAGE1).reply(200, { items: leaves(1, 20), total: 25 })
    mock.onGet(listUrl('s1'), PAGE2).reply(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')

    await click(button(wrapper, '載入更多'))
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(20)
    expect(button(wrapper, '載入更多').getAttribute('aria-busy')).toBeNull()
    expect(snackbarItems()).toEqual([['載入更多失敗，請稍後再試', 'error']])

    mock.onGet(listUrl('s1'), PAGE2).reply(200, { items: leaves(21, 25), total: 25 })
    await click(button(wrapper, '載入更多'))
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(25)
  })

  it('LeavesView load more ignores a late page after switching child', async () => {
    mock.onGet(listUrl('s1'), PAGE1).reply(200, { items: leaves(1, 20), total: 40 })
    const more = deferredReply()
    mock.onGet(listUrl('s1'), PAGE2).reply(more.reply)
    mock.onGet(listUrl('s2')).reply(200, { items: [leave('s2-1', { student_id: 's2', leave_type_label: '其他', leave_type: 'other' })], total: 1 })
    const { wrapper } = await mountView('s1')
    await click(button(wrapper, '載入更多'))

    useChildrenStore().select('s2')
    await flushPromises()
    more.resolve([200, { items: leaves(21, 40), total: 40 }])
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.get('.lv-section__count').text()).toBe('共 1 筆')
  })

  it('LeavesView empty and error states', async () => {
    mock.onGet(listUrl('s1')).replyOnce(200, { items: [], total: 0 })
    const { wrapper } = await mountView('s1')

    expect(wrapper.text()).toContain('還沒有請假紀錄')
    expect(wrapper.text()).toContain('需要請假時按「申請請假」')
    expect(wrapper.get('.empty-state__icon').text()).toBe('event_busy')
    expect(wrapper.find('.lv-section__count').exists()).toBe(false)
    wrapper.unmount()
    mounted = null

    mock.onGet(listUrl('s1')).replyOnce(500, SERVER_ERROR)
    const failed = await mountView('s1')

    expect(failed.wrapper.text()).toContain('請假紀錄載入失敗')
    expect(failed.wrapper.text()).toContain('重試')
    expect(failed.wrapper.find('.lv-section').exists()).toBe(false)
    // 載入失敗時「申請請假」照常可用
    expect(button(failed.wrapper, '申請請假').disabled).toBe(false)

    mock.onGet(listUrl('s1')).replyOnce(200, { items: [leave('l1')], total: 1 })
    await click(button(failed.wrapper, '重試'))
    await flushPromises()
    expect(rows(failed.wrapper)).toHaveLength(1)
    expect(failed.wrapper.text()).not.toContain('請假紀錄載入失敗')
  })

  it('LeavesView pull refresh failure keeps list', async () => {
    mock.onGet(listUrl('s1')).replyOnce(200, { items: [leave('l1'), leave('l2')], total: 2 })
    const { wrapper } = await mountView('s1')
    mock.onGet(listUrl('s1')).reply(500, SERVER_ERROR)

    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(2)
    expect(wrapper.text()).not.toContain('請假紀錄載入失敗')
    expect(snackbarItems()).toEqual([['更新失敗，請稍後再試', 'error']])
  })

  it('LeavesView pull refresh replaces the list and resets pagination', async () => {
    mock.onGet(listUrl('s1'), PAGE1).replyOnce(200, { items: leaves(1, 20), total: 25 })
    mock.onGet(listUrl('s1'), PAGE2).replyOnce(200, { items: leaves(21, 25), total: 25 })
    const { wrapper } = await mountView('s1')
    await click(button(wrapper, '載入更多'))
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(25)

    mock.onGet(listUrl('s1'), PAGE1).replyOnce(200, { items: leaves(1, 20), total: 22 })
    await wrapper.getComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(20)
    expect(wrapper.get('.lv-section__count').text()).toBe('共 22 筆')
    mock.onGet(listUrl('s1'), PAGE2).replyOnce(200, { items: leaves(21, 22), total: 22 })
    await click(button(wrapper, '載入更多'))
    await flushPromises()
    expect(queryParams(mock.history.get.length - 1)).toEqual({ page: 2, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(22)
  })

  it('LeavesView switch child reloads, closes the detail and drops the stale response', async () => {
    const s1 = deferredReply()
    mock.onGet(listUrl('s1')).reply(s1.reply)
    mock.onGet(listUrl('s2')).reply(200, { items: [leave('s2-1', { student_id: 's2', leave_type: 'other', leave_type_label: '其他' })], total: 1 })
    const { wrapper } = await mountView('s1')

    useChildrenStore().select('s2')
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(1)
    expect(rows(wrapper)[0]!.text()).toContain('其他')

    s1.resolve([200, { items: [leave('l1'), leave('l2')], total: 2 }])
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.get('.cch__name').text()).toBe('王小華')
  })

  it('LeavesView closes the open detail when the child changes', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [leave('l1')], total: 1 })
    mock.onGet(listUrl('s2')).reply(200, { items: [], total: 0 })
    const { wrapper } = await mountView('s1')
    await click(rows(wrapper)[0]!.get('.leave-item__main').element)
    expect(sheet('請假詳情')).not.toBeNull()

    useChildrenStore().select('s2')
    await flushPromises()

    await vi.waitFor(() => expect(sheet('請假詳情')).toBeNull())
  })

  it('LeavesView form shows child and locks while submitting', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    const pending = deferredReply()
    mock.onPost('/parent/leaves').reply(pending.reply)
    const { wrapper } = await mountView('s1')

    const form = await openForm(wrapper)
    expect(form.textContent).toContain('為 王小明 申請請假')
    expect(form.querySelector('button[aria-label="關閉"]')).not.toBeNull()

    await submitForm()

    expect(mock.history.post).toHaveLength(1)
    expect(sheet('申請請假')?.querySelector('button[aria-label="關閉"]')).toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(sheet('申請請假')).not.toBeNull()
    await click(document.body.querySelector('.sheet-scrim'))
    expect(sheet('申請請假')).not.toBeNull()

    pending.resolve([201, leave('l9', { start_date: '2026-10-02', end_date: '2026-10-02' })])
    await flushPromises()
    await vi.waitFor(() => expect(sheet('申請請假')).toBeNull())
  })

  it('LeavesView create sends the selected child and fields and adds the leave to the list', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onPost('/parent/leaves').reply(201, leave('l9', { start_date: '2026-10-02', end_date: '2026-10-02', reason: '回診', can_cancel: true }))
    const { wrapper } = await mountView('s1')
    expect(wrapper.text()).toContain('還沒有請假紀錄')

    const form = await openForm(wrapper)
    const reason = form.querySelector('textarea')!
    await new DOMWrapper(reason).setValue(' 回診 ')
    await submitForm()

    expect(mock.history.post).toHaveLength(1)
    expect(mock.history.post[0]!.url).toBe('/parent/leaves')
    expect(postBody(0)).toEqual({
      student_id: 's1',
      leave_type: 'sick',
      start_date: '2026-10-02',
      end_date: '2026-10-02',
      reason: '回診',
    })
    await vi.waitFor(() => expect(sheet('申請請假')).toBeNull())
    expect(snackbarItems()).toEqual([['請假已送出', 'info']])
    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.get('.lv-section__count').text()).toBe('共 1 筆')
    expect(wrapper.text()).not.toContain('還沒有請假紀錄')
  })

  it('LeavesView create with attachments partial failure', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [leave('l1')], total: 1 })
    mock.onPost('/parent/leaves').reply(201, leave('l9', { start_date: '2026-10-02', end_date: '2026-10-02' }))
    mock.onPost('/parent/leaves/l9/attachments').replyOnce(201, attachment('u1')).onPost('/parent/leaves/l9/attachments').replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')

    await openForm(wrapper)
    await pickFile(makeFile('IMG_2031.jpg', 'image/jpeg', 2 * KB))
    await pickFile(makeFile('診斷證明.pdf', 'application/pdf', 5 * KB))
    await submitForm()

    expect(mock.history.post.map((r) => r.url)).toEqual(['/parent/leaves', '/parent/leaves/l9/attachments', '/parent/leaves/l9/attachments'])
    expect(postBody(0).student_id).toBe('s1')
    const store = useSnackbarStore()
    expect(store.items).toHaveLength(1)
    expect(store.items[0]!.message).toBe('請假已送出，但有 1 個附件上傳失敗，可在請假詳情重新上傳')
    expect(store.items[0]!.tone).toBe('error')
    expect(store.items[0]!.action?.label).toBe('查看')
    await vi.waitFor(() => expect(sheet('申請請假')).toBeNull())
    // 新請假在最前面，且只含上傳成功的附件
    expect(rows(wrapper)).toHaveLength(2)
    expect(rows(wrapper)[0]!.find('.leave-item__attach').text()).toContain('1')
    expect(rows(wrapper)[1]!.find('.leave-item__attach').exists()).toBe(false)

    store.items[0]!.action?.onClick()
    await flushPromises()

    const detail = sheet('請假詳情')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('2026/09/28')
    expect(detail!.querySelectorAll('a.att-tile')).toHaveLength(1)
  })

  it('LeavesView uploads attachments one at a time in order', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onPost('/parent/leaves').reply(201, leave('l9', { start_date: '2026-10-02', end_date: '2026-10-02' }))
    const first = deferredReply()
    mock.onPost('/parent/leaves/l9/attachments').replyOnce(first.reply).onPost('/parent/leaves/l9/attachments').replyOnce(201, attachment('u2'))
    const { wrapper } = await mountView('s1')
    await openForm(wrapper)
    await pickFile(makeFile('a.jpg', 'image/jpeg'))
    await pickFile(makeFile('b.pdf', 'application/pdf'))

    await submitForm()
    // 第一個還沒回應時不會送第二個
    expect(mock.history.post).toHaveLength(2)

    first.resolve([201, attachment('u1')])
    await flushPromises()

    expect(mock.history.post).toHaveLength(3)
    await vi.waitFor(() => expect(sheet('申請請假')).toBeNull())
    expect(snackbarItems()).toEqual([['請假已送出', 'info']])
    expect(rows(wrapper)[0]!.find('.leave-item__attach').text()).toContain('2')
  })

  it('LeavesView shows upload progress', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onPost('/parent/leaves').reply(201, leave('l9', { start_date: '2026-10-02', end_date: '2026-10-02' }))
    const first = deferredReply()
    mock.onPost('/parent/leaves/l9/attachments').replyOnce(first.reply).onPost('/parent/leaves/l9/attachments').replyOnce(201, attachment('u2'))
    const { wrapper } = await mountView('s1')
    await openForm(wrapper)
    await pickFile(makeFile('a.jpg', 'image/jpeg'))
    await pickFile(makeFile('b.pdf', 'application/pdf'))

    await submitForm()

    const progress = formSheet().querySelector('[role="status"]')
    expect(progress?.textContent).toContain('請假已建立，正在上傳附件（1/2）…')
    expect(formSheet().querySelector('button[aria-label="關閉"]')).toBeNull()

    first.resolve([201, attachment('u1')])
    await flushPromises()
    await vi.waitFor(() => expect(sheet('申請請假')).toBeNull())
  })

  it('LeavesView create overlap error keeps form', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onPost('/parent/leaves').reply(409, err('leave_overlap', '這段期間已經有請假', { leave_id: 'l1', start_date: '2026-10-05', end_date: '2026-10-07' }))
    const { wrapper } = await mountView('s1')
    await openForm(wrapper)
    await new DOMWrapper(formSheet().querySelector('textarea')!).setValue('回診')

    await submitForm()

    const form = formSheet()
    const alert = form.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('這段期間已有請假（2026-10-05～2026-10-07）')
    // 表單與已填內容保留，可再次送出
    expect(form.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('回診')
    expect(form.querySelector('button[aria-label="關閉"]')).not.toBeNull()
    expect(rows(wrapper)).toHaveLength(0)
    expect(snackbarItems()).toEqual([])
  })

  it('LeavesView create error messages follow the error code and configured limits', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onGet('/parent/config').reply(200, {
      liff_id: 'x',
      org_name: '某某安親班',
      org_phone: null,
      logo_url: null,
      add_friend_url: null,
      limits: { leave_past_days: 7, leave_future_days: 90, leave_max_attachments: 3, leave_max_attachment_mb: 10, authorization_max_days_ahead: 14, persons_max: 10 },
    })
    const { wrapper } = await mountView('s1')
    await openForm(wrapper)

    const alertText = async (status: number, body: unknown) => {
      mock.onPost('/parent/leaves').replyOnce(status, body)
      await submitForm()
      return formSheet().querySelector('[role="alert"]')?.textContent ?? ''
    }

    expect(await alertText(422, err('leave_date_out_of_window', '日期超出範圍', { past_days: 7, future_days: 90 }))).toContain('請假日期需在今天前 7 天到後 90 天內')
    expect(await alertText(422, err('no_service_days_in_range', '請假期間沒有營業日'))).toContain('選擇的日期都不是上課日')
    expect(await alertText(500, SERVER_ERROR)).toContain('伺服器錯誤')
    // 再次送出時先清除上一則
    mock.onPost('/parent/leaves').replyOnce(201, leave('l9', { start_date: '2026-10-02', end_date: '2026-10-02' }))
    await submitForm()
    await vi.waitFor(() => expect(sheet('申請請假')).toBeNull())
  })

  it('LeavesView create student_not_active shows backend message', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onPost('/parent/leaves').reply(409, err('student_not_active', '此學生目前暫停，無法進行此操作'))
    const { wrapper } = await mountView('s1')
    await openForm(wrapper)

    await submitForm()

    const form = formSheet()
    expect(form.textContent).toContain('此學生目前暫停，無法進行此操作')
    expect(form.querySelector('[role="alert"]')?.textContent).toContain('此學生目前暫停，無法進行此操作')
    // 不自動重試
    await flushPromises()
    expect(mock.history.post).toHaveLength(1)
  })

  it('LeavesView scrolls the form back to the top when creating fails', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onPost('/parent/leaves').reply(409, err('leave_overlap', '重疊', { start_date: '2026-10-05', end_date: '2026-10-07' }))
    const { wrapper } = await mountView('s1')
    const form = await openForm(wrapper)
    const scroller = form.querySelector<HTMLElement>('.sheet__body')!
    scroller.scrollTop = 180

    await submitForm()

    expect(scroller.scrollTop).toBe(0)
  })

  it('LeavesView clears the previous error and starts a fresh form on reopen', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onPost('/parent/leaves').reply(409, err('leave_overlap', '重疊', { start_date: '2026-10-05', end_date: '2026-10-07' }))
    const { wrapper } = await mountView('s1')
    await openForm(wrapper)
    await new DOMWrapper(formSheet().querySelector('textarea')!).setValue('回診')
    await submitForm()
    expect(formSheet().querySelector('[role="alert"]')).not.toBeNull()

    await click(button(formSheet(), '取消'))
    await vi.waitFor(() => expect(sheet('申請請假')).toBeNull())
    await openForm(wrapper)

    expect(formSheet().querySelector('[role="alert"]')).toBeNull()
    expect(formSheet().querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('')
  })

  it('LeavesView passes configured limits', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onGet('/parent/config').reply(200, {
      liff_id: 'x',
      org_name: '某某安親班',
      org_phone: null,
      logo_url: null,
      add_friend_url: null,
      limits: { leave_past_days: 30, leave_future_days: 90, leave_max_attachments: 1, leave_max_attachment_mb: 10, authorization_max_days_ahead: 14, persons_max: 10 },
    })
    const { wrapper } = await mountView('s1')

    const form = await openForm(wrapper)

    const dates = form.querySelectorAll<HTMLInputElement>('input[type="date"]')
    expect(dates[1]!.getAttribute('max')).toBe('2026-12-31')
    expect(dates[0]!.getAttribute('min')).toBe('2026-09-02')
    await pickFile(makeFile('a.jpg', 'image/jpeg'))
    expect(formSheet().querySelector('input[type="file"]')).toBeNull()
    expect(formSheet().textContent).toContain('已達 1 個附件上限')
  })

  it('LeavesView falls back to default limits when the config cannot be loaded', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    mock.onGet('/parent/config').reply(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')

    const form = await openForm(wrapper)

    const dates = form.querySelectorAll<HTMLInputElement>('input[type="date"]')
    expect(dates[1]!.getAttribute('max')).toBe('2026-12-01')
  })

  it('LeavesView cancel remaining days', async () => {
    const ongoing = leave('l1', { leave_type: 'personal', leave_type_label: '事假', start_date: '2026-09-30', end_date: '2026-10-03', can_cancel: true })
    mock.onGet(listUrl('s1')).reply(200, { items: [ongoing], total: 1 })
    mock.onPost('/parent/leaves/l1/cancel').reply(200, { ...ongoing, end_date: '2026-10-01', can_cancel: false })
    const { wrapper } = await mountView('s1')
    expect(rows(wrapper)[0]!.text()).toContain('請假中')

    await click(button(rows(wrapper)[0]!.element, '取消剩餘日子'))
    await flushPromises()

    const dialog = alertDialog()
    expect(dialog?.querySelector('h2')?.textContent?.trim()).toBe('取消剩餘日子？')
    expect(dialog?.textContent).toContain('今天起的請假會取消，之前的日子保留')
    expect(dialog?.textContent).toContain('王小明 · 事假 09/30（三）～10/03（六）')
    await click(button(dialog!, '先不要'))
    expect(mock.history.post).toHaveLength(0)
    await vi.waitFor(() => expect(alertDialog()).toBeNull())

    await click(button(rows(wrapper)[0]!.element, '取消剩餘日子'))
    await flushPromises()
    await click(button(alertDialog()!, '取消剩餘日子'))
    await flushPromises()

    expect(mock.history.post).toHaveLength(1)
    expect(mock.history.post[0]!.url).toBe('/parent/leaves/l1/cancel')
    expect(rows(wrapper)[0]!.text()).toContain('已結束')
    expect(rows(wrapper)[0]!.find('button:not(.leave-item__main)').exists()).toBe(false)
    expect(snackbarItems()).toEqual([['已取消請假', 'info']])
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
  })

  it('LeavesView cancel whole leave copy and loading state', async () => {
    const future = leave('l1', { reason: '回診', can_cancel: true })
    mock.onGet(listUrl('s1')).reply(200, { items: [future], total: 1 })
    const pending = deferredReply()
    mock.onPost('/parent/leaves/l1/cancel').reply(pending.reply)
    const { wrapper } = await mountView('s1')

    await click(button(rows(wrapper)[0]!.element, '取消請假'))
    await flushPromises()

    const dialog = alertDialog()!
    expect(dialog.querySelector('h2')?.textContent?.trim()).toBe('取消這筆請假？')
    expect(dialog.textContent).toContain('整筆請假將取消，出勤恢復為預計到班')
    expect(dialog.textContent).toContain('王小明 · 病假 10/05（一）～10/07（三）')

    await click(button(dialog, '取消請假'))
    expect(button(alertDialog()!, '取消請假').getAttribute('aria-busy')).toBe('true')
    expect(button(alertDialog()!, '先不要').disabled).toBe(true)

    pending.resolve([200, { ...future, status: 'cancelled', cancelled_at: '2026-10-02T01:05:00Z', can_cancel: false }])
    await flushPromises()

    expect(rows(wrapper)[0]!.text()).toContain('已取消')
    expect(snackbarItems()).toEqual([['已取消請假', 'info']])
  })

  it('LeavesView cancel conflict refreshes', async () => {
    const ongoing = leave('l1', { start_date: '2026-09-30', end_date: '2026-10-03', can_cancel: true })
    mock.onGet(listUrl('s1')).replyOnce(200, { items: [ongoing], total: 1 })
    mock.onPost('/parent/leaves/l1/cancel').reply(409, err('leave_already_ended', '這筆請假的日子都已過去，沒有可取消的日子'))
    const { wrapper } = await mountView('s1')
    mock.onGet(listUrl('s1')).replyOnce(200, { items: [{ ...ongoing, end_date: '2026-10-01', can_cancel: false }], total: 1 })
    const listCalls = () => mock.history.get.filter((r) => r.url === listUrl('s1'))
    expect(listCalls()).toHaveLength(1)

    await click(button(rows(wrapper)[0]!.element, '取消剩餘日子'))
    await flushPromises()
    await click(button(alertDialog()!, '取消剩餘日子'))
    await flushPromises()

    expect(snackbarItems()).toEqual([['這筆請假已無法取消', 'error']])
    expect(listCalls()).toHaveLength(2)
    expect(listCalls()[1]!.params).toEqual({ page: 1, page_size: 20 })
    expect(rows(wrapper)[0]!.text()).toContain('已結束')
    await vi.waitFor(() => expect(alertDialog()).toBeNull())
  })

  it('LeavesView cancel conflict leave_not_active also refreshes', async () => {
    const future = leave('l1', { can_cancel: true })
    mock.onGet(listUrl('s1')).replyOnce(200, { items: [future], total: 1 })
    mock.onPost('/parent/leaves/l1/cancel').reply(409, err('leave_not_active', '這筆請假已取消'))
    const { wrapper } = await mountView('s1')
    mock.onGet(listUrl('s1')).replyOnce(200, { items: [{ ...future, status: 'cancelled', can_cancel: false }], total: 1 })

    await click(button(rows(wrapper)[0]!.element, '取消請假'))
    await flushPromises()
    await click(button(alertDialog()!, '取消請假'))
    await flushPromises()

    expect(snackbarItems()).toEqual([['這筆請假已無法取消', 'error']])
    expect(rows(wrapper)[0]!.text()).toContain('已取消')
  })

  it('LeavesView cancel with another error keeps the dialog open so it can be retried', async () => {
    const future = leave('l1', { can_cancel: true })
    mock.onGet(listUrl('s1')).reply(200, { items: [future], total: 1 })
    mock.onPost('/parent/leaves/l1/cancel').replyOnce(500, SERVER_ERROR)
    const { wrapper } = await mountView('s1')

    await click(button(rows(wrapper)[0]!.element, '取消請假'))
    await flushPromises()
    await click(button(alertDialog()!, '取消請假'))
    await flushPromises()

    expect(snackbarItems()).toEqual([['取消失敗，請稍後再試', 'error']])
    expect(alertDialog()).not.toBeNull()
    expect(button(alertDialog()!, '取消請假').getAttribute('aria-busy')).toBeNull()
    // 沒有重抓列表
    expect(mock.history.get.filter((r) => r.url === listUrl('s1'))).toHaveLength(1)

    mock.onPost('/parent/leaves/l1/cancel').replyOnce(200, { ...future, status: 'cancelled', cancelled_at: '2026-10-02T01:05:00Z', can_cancel: false })
    await click(button(alertDialog()!, '取消請假'))
    await flushPromises()
    expect(rows(wrapper)[0]!.text()).toContain('已取消')
  })

  it('LeavesView cancel from detail keeps sheet open', async () => {
    const future = leave('l1', { reason: '回診', can_cancel: true })
    mock.onGet(listUrl('s1')).reply(200, { items: [future], total: 1 })
    mock.onPost('/parent/leaves/l1/cancel').reply(200, { ...future, status: 'cancelled', cancelled_at: '2026-10-02T01:05:00Z', can_cancel: false })
    const { wrapper } = await mountView('s1')

    await click(rows(wrapper)[0]!.get('.leave-item__main').element)
    await flushPromises()
    const detail = sheet('請假詳情')!
    expect(detail.textContent).toContain('王小明')
    await click(button(detail, '取消請假'))
    await flushPromises()

    const dialog = alertDialog()!
    expect(dialog.textContent).toContain('取消這筆請假？')
    expect(dialog.textContent).toContain('王小明 · 病假 10/05（一）～10/07（三）')
    expect(button(dialog, '取消請假')).toBeTruthy()
    expect(button(dialog, '先不要')).toBeTruthy()

    await click(button(dialog, '取消請假'))
    await flushPromises()

    await vi.waitFor(() => expect(alertDialog()).toBeNull())
    const after = sheet('請假詳情')
    expect(after).not.toBeNull()
    expect(after!.textContent).toContain('已取消')
    expect(after!.textContent).toContain('取消時間')
    expect(after!.querySelector('.sheet__footer')).toBeNull()
    expect(Array.from(after!.querySelectorAll('button')).some((b) => b.textContent?.includes('取消請假'))).toBe(false)
  })

  it('LeavesView shows staff cancelled past leave', async () => {
    mock.onGet(listUrl('s1')).reply(200, {
      items: [
        leave('l1', {
          status: 'cancelled',
          created_by_type: 'parent',
          start_date: '2026-09-20',
          end_date: '2026-09-22',
          cancelled_at: '2026-10-01T02:00:00Z',
          can_cancel: false,
        }),
      ],
      total: 1,
    })
    const { wrapper } = await mountView('s1')

    expect(rows(wrapper)[0]!.text()).toContain('已取消')
    expect(rows(wrapper)[0]!.text()).not.toContain('已結束')
    expect(rows(wrapper)[0]!.find('button:not(.leave-item__main)').exists()).toBe(false)

    await click(rows(wrapper)[0]!.get('.leave-item__main').element)
    await flushPromises()

    const detail = sheet('請假詳情')!
    expect(detail.textContent).toContain('取消時間')
    expect(detail.textContent).toContain('2026/10/01 10:00')
  })

  it('LeavesView detail upload adds the attachment to the leave and the list count', async () => {
    const l = leave('l1', { attachments: [attachment('a1')] })
    mock.onGet(listUrl('s1')).reply(200, { items: [l], total: 1 })
    const pending = deferredReply()
    mock.onPost('/parent/leaves/l1/attachments').reply(pending.reply)
    const { wrapper } = await mountView('s1')
    await click(rows(wrapper)[0]!.get('.leave-item__main').element)
    await flushPromises()

    const input = sheet('請假詳情')!.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { value: [makeFile('藥袋.png', 'image/png', 4 * KB)], configurable: true })
    await new DOMWrapper(input).trigger('change')

    expect(mock.history.post).toHaveLength(1)
    expect(sheet('請假詳情')!.querySelector('.att-tile--add')?.getAttribute('aria-busy')).toBe('true')

    pending.resolve([201, attachment('a2', { mime_type: 'image/png' })])
    await flushPromises()

    expect(sheet('請假詳情')!.querySelectorAll('a.att-tile')).toHaveLength(2)
    expect(sheet('請假詳情')!.querySelector('.att-tile--add')?.getAttribute('aria-busy')).toBeNull()
    expect(rows(wrapper)[0]!.find('.leave-item__attach').text()).toContain('2')
    expect(snackbarItems()).toEqual([])
  })

  it('LeavesView detail upload errors show the configured messages', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [leave('l1')], total: 1 })
    mock.onGet('/parent/config').reply(200, {
      liff_id: 'x',
      org_name: '某某安親班',
      org_phone: null,
      logo_url: null,
      add_friend_url: null,
      limits: { leave_past_days: 30, leave_future_days: 60, leave_max_attachments: 4, leave_max_attachment_mb: 8, authorization_max_days_ahead: 14, persons_max: 10 },
    })
    const { wrapper } = await mountView('s1')
    await click(rows(wrapper)[0]!.get('.leave-item__main').element)
    await flushPromises()

    const upload = async (status: number, body: unknown) => {
      mock.onPost('/parent/leaves/l1/attachments').replyOnce(status, body)
      const input = sheet('請假詳情')!.querySelector<HTMLInputElement>('input[type="file"]')!
      Object.defineProperty(input, 'files', { value: [makeFile('a.jpg', 'image/jpeg')], configurable: true })
      await new DOMWrapper(input).trigger('change')
      await flushPromises()
      const last = useSnackbarStore().items.at(-1)
      return [last?.message, last?.tone]
    }

    expect(await upload(413, err('file_too_large', '檔案超過 10 MB'))).toEqual(['檔案超過 8 MB', 'error'])
    expect(await upload(415, err('unsupported_file_type', '不支援的檔案格式'))).toEqual(['檔案格式不支援', 'error'])
    expect(await upload(409, err('attachment_limit_reached', '附件已達上限'))).toEqual(['每筆請假最多 4 個附件', 'error'])
    expect(await upload(500, SERVER_ERROR)).toEqual(['附件上傳失敗，請稍後再試', 'error'])
    // 失敗時清單的附件數不變，新增磚恢復可用
    expect(rows(wrapper)[0]!.find('.leave-item__attach').exists()).toBe(false)
    expect(sheet('請假詳情')!.querySelector('.att-tile--add')?.getAttribute('aria-busy')).toBeNull()
  })

  it('LeavesView disables the apply button and shows the empty state when there is no child', async () => {
    const { wrapper } = await mountView(null, { items: [], loaded: true })

    // 沒有選中的小孩時不打列表 API（只有掛載時取 limits 的 /parent/config）
    expect(mock.history.get.filter((r) => r.url !== '/parent/config')).toHaveLength(0)
    expect(button(wrapper, '申請請假').disabled).toBe(true)
    expect(wrapper.text()).toContain('還沒有請假紀錄')
  })

  it('LeavesView loads the child list on mount and waits for the selection', async () => {
    mock.onGet('/parent/children').reply(200, KIDS)
    mock.onGet(listUrl('s1')).reply(200, { items: [leave('l1')], total: 1 })
    mounted = await mountWithApp(LeavesView, {
      piniaInitialState: { parentChildren: { items: [], loaded: false, selectedId: null } },
    })

    expect(mock.history.get.map((r) => r.url).filter((u) => u !== '/parent/config')).toEqual(['/parent/children', '/parent/children/s1/leaves'])
    expect(rows(mounted.wrapper)).toHaveLength(1)
    expect(mounted.wrapper.get('.cch__name').text()).toBe('王小明')
  })

  it('LeavesView shows the error state when the child list cannot be loaded and retries it', async () => {
    mock.onGet('/parent/children').replyOnce(500, SERVER_ERROR)
    mounted = await mountWithApp(LeavesView, {
      piniaInitialState: { parentChildren: { items: [], loaded: false, selectedId: null } },
    })
    expect(mounted.wrapper.text()).toContain('請假紀錄載入失敗')

    mock.onGet('/parent/children').replyOnce(200, KIDS)
    mock.onGet(listUrl('s1')).reply(200, { items: [leave('l1')], total: 1 })
    await click(button(mounted.wrapper, '重試'))
    await flushPromises()

    expect(rows(mounted.wrapper)).toHaveLength(1)
  })

  it('LeavesView pins the form buttons to the bottom of the sheet with a sticky wrapper', async () => {
    mock.onGet(listUrl('s1')).reply(200, { items: [], total: 0 })
    const { wrapper } = await mountView('s1')

    const form = await openForm(wrapper)

    // happy-dom 不計算版面：結構與 ?raw 樣式規則斷言，真實版面在 Chromium 實測
    const wrap = form.querySelector('.lv-form-wrap')
    expect(wrap).not.toBeNull()
    expect(wrap!.querySelector('.lf-actions')).not.toBeNull()
    const rule = /\.lv-form-wrap :deep\(\.lf-actions\) \{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(rule).toMatch(/position:\s*sticky/)
    expect(rule).toMatch(/bottom:\s*0/)
    expect(rule).toMatch(/border-top:\s*1px solid var\(--m3-outline-variant\)/)
    expect(rule).toMatch(/background:\s*var\(--m3-surface-container-low\)/)
    expect(rule).toMatch(/env\(safe-area-inset-bottom\)/)
  })
})
