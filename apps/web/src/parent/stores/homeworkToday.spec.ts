import type MockAdapter from 'axios-mock-adapter'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiMock } from '@/test/helpers'
import { FakeWebSocket, installFakeWebSocket } from '@/test/fakeWebSocket'
import type { HomeworkToday } from '../api/homework'
import { parentHttp } from '../api/http'
import { useHomeworkTodayStore } from './homeworkToday'
import { useParentWsStore } from './parentWs'

function lastSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1)
  if (!s) throw new Error('尚未建立 socket')
  return s
}

// 時間固定在台北 2026-10-02 16:00
const NOW = new Date('2026-10-02T08:00:00Z')
const TODAY = '2026-10-02'
const SERVER_ERROR = { error: { code: 'internal_error', message: '伺服器發生錯誤', details: null } }

function homework(studentId: string, overrides: Partial<HomeworkToday> = {}): HomeworkToday {
  return {
    student_id: studentId,
    date: TODAY,
    items: [{ title: '數學習作 p.12', subject_name: '數學', status: 'doing' }],
    overall_status: 'in_progress',
    ready_eta: '17:30',
    note: null,
    updated_at: '2026-10-02T07:30:00Z',
    ...overrides,
  }
}

const url = (id: string) => `/parent/children/${id}/homework`

describe('homeworkToday', () => {
  let mock: MockAdapter

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    FakeWebSocket.instances.length = 0
    installFakeWebSocket()
    setActivePinia(createPinia())
    mock = createApiMock(parentHttp)
  })

  afterEach(() => {
    useParentWsStore().disconnect()
    mock.restore()
    vi.useRealTimers()
  })

  function requestsFor(id: string): number {
    return mock.history.get.filter((r) => r.url === url(id)).length
  }

  function connectWs(): FakeWebSocket {
    useParentWsStore().connect()
    lastSocket().open()
    return lastSocket()
  }

  it('homeworkToday load caches per child', async () => {
    mock.onGet(url('s1')).reply(200, homework('s1'))
    const store = useHomeworkTodayStore()
    expect(store.get('s1')).toBeNull()

    await store.load('s1')
    await store.load('s1')

    expect(requestsFor('s1')).toBe(1)
    expect(store.get('s1')?.overall_status).toBe('in_progress')
    expect(store.get('s1')?.ready_eta).toBe('17:30')
    expect(store.loadingByChild.s1).toBe(false)
    expect(store.errorByChild.s1).toBeNull()
  })

  it('homeworkToday concurrent loads share one request', async () => {
    mock.onGet(url('s1')).reply(200, homework('s1'))
    const store = useHomeworkTodayStore()

    const first = store.load('s1')
    const second = store.load('s1', { force: true })
    expect(store.loadingByChild.s1).toBe(true)
    await Promise.all([first, second])

    expect(requestsFor('s1')).toBe(1)
    expect(store.get('s1')?.student_id).toBe('s1')
    expect(store.loadingByChild.s1).toBe(false)
  })

  it('homeworkToday force reloads', async () => {
    mock
      .onGet(url('s1'))
      .replyOnce(200, homework('s1'))
      .onGet(url('s1'))
      .replyOnce(200, homework('s1', { overall_status: 'done', updated_at: '2026-10-02T09:00:00Z' }))
    const store = useHomeworkTodayStore()
    await store.load('s1')

    await store.load('s1', { force: true })

    expect(requestsFor('s1')).toBe(2)
    expect(store.get('s1')?.overall_status).toBe('done')
  })

  it('homeworkToday applies ws update for today', async () => {
    mock.onGet(url('s1')).reply(200, homework('s1'))
    const store = useHomeworkTodayStore()
    await store.load('s1')
    const socket = connectWs()

    socket.message({
      type: 'homework.progress_updated',
      data: { student_id: 's1', date: TODAY, items: [], overall_status: 'done', ready_eta: null, note: '今日無作業' },
      sent_at: '2026-10-02T08:00:00Z',
    })

    const today = store.get('s1')
    expect(today?.overall_status).toBe('done')
    expect(today?.note).toBe('今日無作業')
    expect(today?.items).toEqual([])
    expect(today?.ready_eta).toBeNull()
    expect(today?.updated_at).toBe('2026-10-02T08:00:00Z')
    expect(today?.date).toBe(TODAY)
    expect(requestsFor('s1')).toBe(1)
  })

  it('homeworkToday ws update fills a child not loaded yet', () => {
    const store = useHomeworkTodayStore()
    const socket = connectWs()

    socket.message({
      type: 'homework.progress_updated',
      data: {
        student_id: 's2',
        date: TODAY,
        items: [{ title: '國語生字', subject_name: '國語', status: 'done' }],
        overall_status: 'done',
        ready_eta: null,
        note: null,
      },
      sent_at: '2026-10-02T08:05:00Z',
    })

    expect(store.get('s2')?.overall_status).toBe('done')
    expect(store.get('s2')?.items).toHaveLength(1)
    expect(store.get('s2')?.updated_at).toBe('2026-10-02T08:05:00Z')
  })

  it('homeworkToday ignores other day event', async () => {
    mock.onGet(url('s1')).reply(200, homework('s1'))
    const store = useHomeworkTodayStore()
    await store.load('s1')
    const socket = connectWs()

    socket.message({
      type: 'homework.progress_updated',
      data: { student_id: 's1', date: '2026-10-01', items: [], overall_status: 'done', ready_eta: null, note: '昨天' },
      sent_at: '2026-10-02T08:00:00Z',
    })

    expect(store.get('s1')?.overall_status).toBe('in_progress')
    expect(store.get('s1')?.note).toBeNull()
    expect(store.get('s1')?.updated_at).toBe('2026-10-02T07:30:00Z')
  })

  it('homeworkToday load error keeps old data', async () => {
    mock.onGet(url('s1')).replyOnce(200, homework('s1')).onGet(url('s1')).replyOnce(500, SERVER_ERROR)
    const store = useHomeworkTodayStore()
    await store.load('s1')

    await store.load('s1', { force: true })

    expect(store.errorByChild.s1).toBe('作業進度載入失敗')
    expect(store.get('s1')?.overall_status).toBe('in_progress')
    expect(store.loadingByChild.s1).toBe(false)
  })

  it('homeworkToday load clears previous error on retry', async () => {
    mock.onGet(url('s1')).replyOnce(500, SERVER_ERROR).onGet(url('s1')).replyOnce(200, homework('s1'))
    const store = useHomeworkTodayStore()
    await store.load('s1')
    expect(store.errorByChild.s1).toBe('作業進度載入失敗')
    expect(store.get('s1')).toBeNull()

    await store.load('s1', { force: true })

    expect(store.errorByChild.s1).toBeNull()
    expect(store.get('s1')?.overall_status).toBe('in_progress')
  })

  it('homeworkToday poller refreshes loaded children', async () => {
    mock.onGet(url('s1')).reply(200, homework('s1'))
    mock.onGet(url('s2')).reply(200, homework('s2', { overall_status: 'not_started' }))
    const store = useHomeworkTodayStore()
    await store.load('s1')
    await store.load('s2')
    expect(requestsFor('s1')).toBe(1)
    expect(requestsFor('s2')).toBe(1)

    useParentWsStore().pollNow()
    await flushPromises()

    expect(requestsFor('s1')).toBe(2)
    expect(requestsFor('s2')).toBe(2)
    expect(mock.history.get).toHaveLength(4)
  })

  it('homeworkToday clear drops everything including in-flight result', async () => {
    let release!: () => void
    mock.onGet(url('s1')).replyOnce(
      () =>
        new Promise<[number, unknown]>((resolve) => {
          release = () => resolve([200, homework('s1')])
        }),
    )
    mock.onGet(url('s2')).reply(200, homework('s2'))
    const store = useHomeworkTodayStore()
    await store.load('s2')
    const pending = store.load('s1')

    store.clear()
    release()
    await pending
    await flushPromises()

    expect(store.byChild).toEqual({})
    expect(store.get('s1')).toBeNull()
    expect(store.get('s2')).toBeNull()
    expect(store.loadingByChild).toEqual({})
    expect(store.errorByChild).toEqual({})
  })
})
