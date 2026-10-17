import { flushPromises } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import type { Notification } from '@/shared/types/api'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'
import type { ChildSummary } from '../api/children'
import { parentHttp } from '../api/http'
import PullToRefresh from '../components/PullToRefresh.vue'
import { useChildrenStore } from '../stores/children'
import { useParentWsStore } from '../stores/parentWs'
import { useSnackbarStore } from '../stores/snackbar'
import NotificationsView from './NotificationsView.vue'
import source from './NotificationsView.vue?raw'

const LIST_URL = '/parent/notifications'
const READ_ALL_URL = '/parent/notifications/read-all'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器發生錯誤', details: null } }

function child(id: string, name: string): ChildSummary {
  return { id, name, grade_level: 3, class_name: '中年級班', school_name: '某某國小', photo_url: null, status: 'active' }
}

const KIDS = [child('s1', '王小明'), child('s2', '王小華')]

function noti(id: string, overrides: Partial<Notification> = {}): Notification {
  return {
    id,
    event: 'pickup.replied',
    title: `接送回覆 ${id}`,
    body: '老師已回覆：預計 17:30 可接送',
    payload: { student_id: 's1' },
    read_at: null,
    created_at: '2026-10-02T09:05:00Z',
    deep_link: '/pickup',
    ...overrides,
  }
}

const READ_AT = '2026-10-02T09:10:00Z'

type Params = { page?: number; page_size?: number; unread_only?: boolean }
type Wrapper = MountedApp['wrapper']

describe('NotificationsView', () => {
  let mock: MockAdapter
  let mounted: MountedApp | null = null

  beforeEach(() => {
    FakeWebSocket.instances.length = 0
    installFakeWebSocket()
    mock = createApiMock(parentHttp)
  })

  afterEach(() => {
    if (mounted) useParentWsStore(mounted.pinia).disconnect()
    mounted?.wrapper.unmount()
    mounted = null
    mock.restore()
  })

  async function mountView(): Promise<MountedApp> {
    mounted = await mountWithApp(NotificationsView, {
      initialRoute: '/notifications',
      piniaInitialState: { parentChildren: { items: KIDS, loaded: true, selectedId: 's1' } },
    })
    await flushPromises()
    return mounted
  }

  /** 每次 GET 依序回下一個結果；未提供時重複最後一個 */
  function listReplies(...replies: ([number, unknown] | (() => Promise<[number, unknown]>))[]): void {
    let i = 0
    mock.onGet(LIST_URL).reply(() => {
      const r = replies[Math.min(i, replies.length - 1)]!
      i += 1
      return typeof r === 'function' ? r() : r
    })
  }

  const page = (items: Notification[], total = items.length, unread = items.filter((n) => !n.read_at).length) =>
    [200, { items, total, unread_count: unread }] as [number, unknown]

  const listGets = (): Params[] => mock.history.get.filter((r) => r.url === LIST_URL).map((r) => r.params as Params)
  const rows = (w: Wrapper) => w.findAll('li.noti-item')
  const button = (w: Wrapper, label: string) => w.findAll('button').find((b) => b.text().endsWith(label))
  const segment = (w: Wrapper, index: number) => w.findAll('[role="radio"]')[index]!

  it('NotificationsView opens deep link and marks read', async () => {
    listReplies(page([noti('n1', { payload: { student_id: 's2' } })]))
    mock.onPost('/parent/notifications/n1/read').reply(200, noti('n1', { read_at: READ_AT }))
    const { wrapper, router, pinia } = await mountView()

    await rows(wrapper)[0]!.get('button').trigger('click')
    await flushPromises()

    expect(mock.history.post.map((r) => r.url)).toEqual(['/parent/notifications/n1/read'])
    expect(useChildrenStore(pinia).selectedId).toBe('s2')
    expect(router.currentRoute.value.path).toBe('/pickup')
  })

  it('NotificationsView navigates even when mark read fails', async () => {
    listReplies(page([noti('n1', { payload: { student_id: 's2' } })]))
    mock.onPost('/parent/notifications/n1/read').reply(500, SERVER_ERROR)
    const { wrapper, router } = await mountView()

    await rows(wrapper)[0]!.get('button').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/pickup')
  })

  it('NotificationsView ignores unsafe deep link', async () => {
    listReplies(
      page([
        noti('n1', { read_at: READ_AT, deep_link: 'https://evil.com' }),
        noti('n2', { read_at: READ_AT, deep_link: '/login' }),
        noti('n3', { read_at: READ_AT, deep_link: null }),
        noti('n4', { read_at: READ_AT, deep_link: '//evil.com/x' }),
      ]),
    )
    const { wrapper, router } = await mountView()
    expect(rows(wrapper)).toHaveLength(4)

    for (const row of rows(wrapper)) {
      await row.get('button').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.path).toBe('/notifications')
    }
    // 已讀的不再標已讀；也不提示
    expect(mock.history.post).toHaveLength(0)
    expect(useSnackbarStore(mounted!.pinia).items).toHaveLength(0)
  })

  it('NotificationsView open unread item without link stays and marks read', async () => {
    listReplies(page([noti('n1', { deep_link: null, payload: { student_id: 's9' } })]))
    mock.onPost('/parent/notifications/n1/read').reply(200, noti('n1', { read_at: READ_AT, deep_link: null }))
    const { wrapper, router, pinia } = await mountView()

    await rows(wrapper)[0]!.get('button').trigger('click')
    await flushPromises()

    expect(mock.history.post).toHaveLength(1)
    expect(router.currentRoute.value.path).toBe('/notifications')
    // payload.student_id 不在小孩清單：不切換
    expect(useChildrenStore(pinia).selectedId).toBe('s1')
    expect(rows(wrapper)[0]!.classes()).not.toContain('is-unread')
  })

  it('NotificationsView unread filter', async () => {
    listReplies(page([noti('n1'), noti('n2'), noti('n3'), noti('n4', { read_at: READ_AT })], 4, 3), page([], 0, 0))
    const { wrapper } = await mountView()

    expect(segment(wrapper, 0).text()).toContain('全部')
    expect(segment(wrapper, 0).attributes('aria-checked')).toBe('true')
    expect(segment(wrapper, 1).get('.m3-segment__label').text()).toBe('未讀 3')
    expect(wrapper.get('[role="radiogroup"]').attributes('aria-label')).toBe('通知篩選')
    expect(wrapper.get('ul[role="list"]').attributes('aria-label')).toBe('通知')

    await segment(wrapper, 1).trigger('click')
    await flushPromises()

    expect(listGets().at(-1)).toEqual({ unread_only: true, page: 1, page_size: 20 })
    expect(segment(wrapper, 1).attributes('aria-checked')).toBe('true')
    expect(wrapper.text()).toContain('沒有未讀通知')
    expect(wrapper.text()).toContain('新的到班、作業、接送與成績通知會出現在這裡')
    expect(wrapper.get('.empty-state__icon').text()).toBe('done_all')
  })

  it('NotificationsView reselecting current filter does not reload', async () => {
    listReplies(page([noti('n1')]))
    const { wrapper } = await mountView()

    await segment(wrapper, 0).trigger('click')
    await flushPromises()

    expect(listGets()).toHaveLength(1)
    expect(rows(wrapper)).toHaveLength(1)
  })

  it('NotificationsView unread label caps at 99+', async () => {
    listReplies(page([noti('n1')], 1, 120))
    const { wrapper } = await mountView()

    expect(segment(wrapper, 1).get('.m3-segment__label').text()).toBe('未讀 99+')
  })

  it('NotificationsView unread label without count', async () => {
    listReplies(page([noti('n1', { read_at: READ_AT })], 1, 0))
    const { wrapper } = await mountView()

    expect(segment(wrapper, 1).get('.m3-segment__label').text()).toBe('未讀')
    expect(button(wrapper, '全部標為已讀')?.attributes('disabled')).toBeDefined()
  })

  it('NotificationsView shows skeleton while switching filter', async () => {
    let release!: () => void
    listReplies(page([noti('n1'), noti('n2')]), () => new Promise((resolve) => { release = () => resolve(page([noti('n1')])) }))
    const { wrapper } = await mountView()

    await segment(wrapper, 1).trigger('click')
    await flushPromises()

    expect(wrapper.find('.noti-card [aria-busy="true"]').exists()).toBe(true)
    expect(rows(wrapper)).toHaveLength(0)
    // 篩選與工具列保留
    expect(button(wrapper, '通知設定')).toBeDefined()

    release()
    await flushPromises()
    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.get('ul[role="list"]').attributes('aria-label')).toBe('未讀通知')
    expect(wrapper.find('.noti-card [aria-busy="true"]').exists()).toBe(false)
  })

  it('NotificationsView shows skeleton on first load', async () => {
    listReplies(() => new Promise(() => undefined))
    const { wrapper } = await mountView()

    expect(wrapper.find('.noti-card [aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('目前沒有通知')
    expect(wrapper.findComponent(PullToRefresh).props('disabled')).toBe(true)
  })

  it('NotificationsView mark all read', async () => {
    listReplies(page([noti('n1'), noti('n2'), noti('n3', { read_at: READ_AT })], 3, 2))
    mock.onPost(READ_ALL_URL).reply(200, { updated: 2 })
    const { wrapper, pinia } = await mountView()

    const markAll = button(wrapper, '全部標為已讀')!
    expect(markAll.attributes('disabled')).toBeUndefined()

    await markAll.trigger('click')
    await flushPromises()

    expect(mock.history.post.map((r) => r.url)).toEqual([READ_ALL_URL])
    expect(button(wrapper, '全部標為已讀')?.attributes('disabled')).toBeDefined()
    expect(useSnackbarStore(pinia).items[0]?.message).toBe('已全部標為已讀')
    expect(rows(wrapper).filter((r) => r.classes().includes('is-unread'))).toHaveLength(0)
    expect(segment(wrapper, 1).get('.m3-segment__label').text()).toBe('未讀')
    // 「全部」篩選下不重新載入
    expect(listGets()).toHaveLength(1)
  })

  it('NotificationsView mark all read blocks double click', async () => {
    listReplies(page([noti('n1')], 1, 1))
    mock.onPost(READ_ALL_URL).reply(() => new Promise(() => undefined))
    const { wrapper } = await mountView()

    await button(wrapper, '全部標為已讀')!.trigger('click')
    await flushPromises()
    expect(button(wrapper, '全部標為已讀')?.attributes('aria-busy')).toBe('true')
    await button(wrapper, '全部標為已讀')!.trigger('click')
    await flushPromises()

    expect(mock.history.post).toHaveLength(1)
  })

  it('NotificationsView mark all read in unread filter reloads', async () => {
    listReplies(page([noti('n1'), noti('n2')], 2, 2), page([noti('n1'), noti('n2')], 2, 2), page([], 0, 0))
    mock.onPost(READ_ALL_URL).reply(200, { updated: 2 })
    const { wrapper } = await mountView()
    await segment(wrapper, 1).trigger('click')
    await flushPromises()
    expect(listGets()).toHaveLength(2)

    await button(wrapper, '全部標為已讀')!.trigger('click')
    await flushPromises()

    expect(listGets()).toHaveLength(3)
    expect(listGets()[2]).toEqual({ unread_only: true, page: 1, page_size: 20 })
    expect(wrapper.text()).toContain('沒有未讀通知')
    expect(rows(wrapper)).toHaveLength(0)
  })

  it('NotificationsView mark all read failure', async () => {
    listReplies(page([noti('n1'), noti('n2')], 2, 2))
    mock.onPost(READ_ALL_URL).reply(500, SERVER_ERROR)
    const { wrapper, pinia } = await mountView()

    await button(wrapper, '全部標為已讀')!.trigger('click')
    await flushPromises()

    const item = useSnackbarStore(pinia).items[0]
    expect(item?.tone).toBe('error')
    expect(item?.message).toBe('全部標為已讀失敗，請稍後再試')
    const markAll = button(wrapper, '全部標為已讀')!
    expect(markAll.attributes('disabled')).toBeUndefined()
    expect(markAll.attributes('aria-busy')).toBeUndefined()
    expect(rows(wrapper).filter((r) => r.classes().includes('is-unread'))).toHaveLength(2)
  })

  it('NotificationsView preferences link', async () => {
    listReplies(page([]))
    const { wrapper, router } = await mountView()

    await button(wrapper, '通知設定')!.trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/notifications/preferences')
  })

  it('NotificationsView load more', async () => {
    const first = Array.from({ length: 20 }, (_, i) => noti(`n${i + 1}`, { read_at: READ_AT }))
    const second = Array.from({ length: 5 }, (_, i) => noti(`n${i + 21}`, { read_at: READ_AT }))
    mock.onGet(LIST_URL).reply((config) => {
      const params = config.params as Params
      return page(params.page === 2 ? second : first, 25, 0)
    })
    const { wrapper } = await mountView()

    expect(rows(wrapper)).toHaveLength(20)
    expect(button(wrapper, '載入更多')).toBeDefined()

    await button(wrapper, '載入更多')!.trigger('click')
    await flushPromises()

    expect(listGets()[1]?.page).toBe(2)
    expect(rows(wrapper)).toHaveLength(25)
    expect(button(wrapper, '載入更多')).toBeUndefined()
  })

  it('NotificationsView load more shows loading', async () => {
    const first = Array.from({ length: 20 }, (_, i) => noti(`n${i + 1}`, { read_at: READ_AT }))
    listReplies(page(first, 25, 0), () => new Promise(() => undefined))
    const { wrapper } = await mountView()

    await button(wrapper, '載入更多')!.trigger('click')
    await flushPromises()

    expect(button(wrapper, '載入更多')?.attributes('aria-busy')).toBe('true')
    await button(wrapper, '載入更多')!.trigger('click')
    await flushPromises()
    expect(listGets()).toHaveLength(2)
  })

  it('NotificationsView load more failure keeps button', async () => {
    const first = Array.from({ length: 20 }, (_, i) => noti(`n${i + 1}`, { read_at: READ_AT }))
    listReplies(page(first, 25, 0), [500, SERVER_ERROR])
    const { wrapper, pinia } = await mountView()

    await button(wrapper, '載入更多')!.trigger('click')
    await flushPromises()

    const item = useSnackbarStore(pinia).items[0]
    expect(item?.tone).toBe('error')
    expect(item?.message).toBe('載入更多失敗，請稍後再試')
    expect(rows(wrapper)).toHaveLength(20)
    expect(button(wrapper, '載入更多')?.attributes('aria-busy')).toBeUndefined()
    expect(wrapper.text()).not.toContain('通知載入失敗')
  })

  it('NotificationsView empty and error', async () => {
    listReplies(page([], 0, 0))
    const empty = await mountView()
    expect(empty.wrapper.text()).toContain('目前沒有通知')
    expect(empty.wrapper.text()).toContain('到班、作業、接送與成績的通知會出現在這裡')
    expect(empty.wrapper.get('.empty-state__icon').text()).toBe('notifications')
    empty.wrapper.unmount()
    mounted = null

    mock.reset()
    listReplies([500, SERVER_ERROR], page([noti('n1')]))
    const failed = await mountView()
    expect(failed.wrapper.text()).toContain('通知載入失敗')
    expect(failed.wrapper.text()).toContain('請檢查網路連線後再試一次')
    expect(failed.wrapper.find('.noti-card').exists()).toBe(false)
    // 篩選與工具列保留
    expect(failed.wrapper.find('[role="radiogroup"]').exists()).toBe(true)

    await button(failed.wrapper, '重試')!.trigger('click')
    await flushPromises()

    expect(rows(failed.wrapper)).toHaveLength(1)
    expect(failed.wrapper.text()).not.toContain('通知載入失敗')
  })

  it('NotificationsView retry keeps current filter', async () => {
    listReplies(page([noti('n1')]), [500, SERVER_ERROR], page([noti('n1')]))
    const { wrapper } = await mountView()
    await segment(wrapper, 1).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('通知載入失敗')

    await button(wrapper, '重試')!.trigger('click')
    await flushPromises()

    expect(listGets()[2]).toEqual({ unread_only: true, page: 1, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(1)
  })

  it('NotificationsView keeps items on refresh error', async () => {
    listReplies(page([noti('n1'), noti('n2')]), [500, SERVER_ERROR])
    const { wrapper, pinia } = await mountView()
    expect(rows(wrapper)).toHaveLength(2)

    await wrapper.findComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(2)
    expect(listGets()).toHaveLength(2)
    const item = useSnackbarStore(pinia).items[0]
    expect(item?.tone).toBe('error')
    expect(item?.message).toBe('更新失敗，請稍後再試')
  })

  it('NotificationsView refresh error without content shows error state only', async () => {
    listReplies(page([], 0, 0), [500, SERVER_ERROR])
    const { wrapper, pinia } = await mountView()
    expect(wrapper.text()).toContain('目前沒有通知')

    await wrapper.findComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()

    // 沒有內容可保留：畫面直接是錯誤態，不再另外跳 snackbar
    expect(wrapper.text()).toContain('通知載入失敗')
    expect(useSnackbarStore(pinia).items).toHaveLength(0)
  })

  it('NotificationsView refresh keeps content and filter', async () => {
    let release!: () => void
    listReplies(
      page([noti('n1')]),
      page([noti('n1')]),
      () => new Promise((resolve) => { release = () => resolve(page([noti('n1'), noti('n2')])) }),
    )
    const { wrapper, pinia } = await mountView()
    await segment(wrapper, 1).trigger('click')
    await flushPromises()

    const refreshing = wrapper.findComponent(PullToRefresh).props('onRefresh')()
    await flushPromises()
    // 重抓期間保留現有內容，不顯示骨架
    expect(rows(wrapper)).toHaveLength(1)
    expect(wrapper.find('.noti-card [aria-busy="true"]').exists()).toBe(false)

    release()
    await refreshing
    await flushPromises()

    expect(listGets()[2]).toEqual({ unread_only: true, page: 1, page_size: 20 })
    expect(rows(wrapper)).toHaveLength(2)
    expect(useSnackbarStore(pinia).items).toHaveLength(0)
  })

  it('NotificationsView shows ws notification without refetch', async () => {
    listReplies(page([noti('n1', { read_at: READ_AT })]))
    const { wrapper, pinia } = await mountView()
    const ws = useParentWsStore(pinia)
    ws.connect()
    FakeWebSocket.instances.at(-1)!.open()

    FakeWebSocket.instances.at(-1)!.message({
      type: 'notification.created',
      data: noti('n9', { title: '作業已完成' }),
      sent_at: '2026-10-02T09:30:00Z',
    })
    await flushPromises()

    expect(rows(wrapper)).toHaveLength(2)
    expect(rows(wrapper)[0]!.text()).toContain('作業已完成')
    expect(listGets()).toHaveLength(1)
    expect(segment(wrapper, 1).get('.m3-segment__label').text()).toBe('未讀 1')
  })

  it('NotificationsView loads children on mount', async () => {
    listReplies(page([]))
    mock.onGet('/parent/children').reply(200, KIDS)
    mounted = await mountWithApp(NotificationsView, {
      initialRoute: '/notifications',
      piniaInitialState: { parentChildren: { items: [], loaded: false, selectedId: null } },
    })
    await flushPromises()

    // 點通知時要切換小孩，掛載時先載入小孩清單
    expect(mock.history.get.filter((r) => r.url === '/parent/children')).toHaveLength(1)
    expect(useChildrenStore(mounted.pinia).items.map((c) => c.id)).toEqual(['s1', 's2'])
    expect(listGets()[0]).toEqual({ page: 1, page_size: 20 })
  })

  it('NotificationsView style follows design decisions', () => {
    expect(source).toMatch(/\.ntv\s*\{[^}]*padding:\s*8px 16px 24px/)
    expect(source).toMatch(/\.ntv\s*\{[^}]*gap:\s*12px/)
    expect(source).toMatch(/\.noti-list\s*\{[^}]*list-style:\s*none/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
