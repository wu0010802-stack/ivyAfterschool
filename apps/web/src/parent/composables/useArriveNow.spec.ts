import type MockAdapter from 'axios-mock-adapter'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { createApiMock, mountWithApp, type MountedApp } from '@/test/helpers'
import { parentHttp } from '../api/http'
import type { ParentPickupRequest } from '../api/pickupRequests'
import { useSnackbarStore } from '../stores/snackbar'
import { useArriveNow } from './useArriveNow'

const SKIP_KEY = 'parent_pickup_arrive_skip_confirm'
const CREATE_URL = '/parent/pickup/requests'
const TODAY_URL = '/parent/pickup/requests/today'
const arrivedUrl = (id: string) => `/parent/pickup/requests/${id}/arrived`

// 時間固定在台北 2026-10-02 16:00
const NOW = new Date('2026-10-02T08:00:00Z')

function apiError(code: string, message = '錯誤', details: unknown = null) {
  return { error: { code, message, details } }
}

function request(id: string, overrides: Partial<ParentPickupRequest> = {}): ParentPickupRequest {
  return {
    id,
    student_id: 's1',
    student_name: '王小明',
    service_date: '2026-10-02',
    status: 'arrived',
    expected_arrival_at: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: 'auto',
    replied_at: null,
    arrived_at: '2026-10-02T08:00:00Z',
    completed_at: null,
    picked_up_by_name: null,
    cancelled_at: null,
    created_at: '2026-10-02T08:00:00Z',
    can_cancel: true,
    can_mark_arrived: false,
    ...overrides,
  }
}

/** 可手動決定何時回應的 reply */
function deferredReply() {
  let resolve!: (value: [number, unknown]) => void
  const promise = new Promise<[number, unknown]>((r) => {
    resolve = r
  })
  return { reply: () => promise, resolve }
}

type ArriveNow = ReturnType<typeof useArriveNow>

let mock: MockAdapter
let mounted: MountedApp | null = null

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  localStorage.removeItem(SKIP_KEY)
  mock = createApiMock(parentHttp)
})

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted = null
  mock.restore()
  vi.restoreAllMocks()
  vi.useRealTimers()
  localStorage.removeItem(SKIP_KEY)
})

async function setup(options?: Parameters<typeof useArriveNow>[0]): Promise<ArriveNow> {
  let api: ArriveNow | null = null
  const Host = defineComponent({
    setup() {
      api = options ? useArriveNow(options) : useArriveNow()
      return () => h('div')
    },
  })
  mounted = await mountWithApp(Host)
  if (!api) throw new Error('composable 未建立')
  return api
}

function snackbarItems(): [string, string][] {
  return useSnackbarStore().items.map((i) => [i.message, i.tone])
}

function posts(): string[] {
  return mock.history.post.map((r) => r.url ?? '')
}

describe('useArriveNow', () => {
  it('useArriveNow shortcut without open request', async () => {
    mock.onPost(CREATE_URL).reply(201, request('r8'))
    const api = await setup()

    api.request('s1', null)
    expect(api.confirmOpen.value).toBe(true)
    expect(mock.history.post).toHaveLength(0)

    const result = await api.confirm()

    expect(posts()).toEqual([CREATE_URL])
    expect(JSON.parse(mock.history.post[0]!.data as string)).toEqual({ student_id: 's1', arrived: true })
    expect(result?.id).toBe('r8')
    expect(api.lastResult.value?.id).toBe('r8')
    expect(api.confirmOpen.value).toBe(false)
    expect(snackbarItems()[0]).toEqual(['已通知老師您到了', 'info'])
  })

  it('useArriveNow uses existing open request', async () => {
    mock.onPost(arrivedUrl('r1')).reply(200, request('r1'))
    const api = await setup()

    api.request('s1', 'r1')
    const result = await api.confirm()

    expect(posts()).toEqual([arrivedUrl('r1')])
    expect(mock.history.post.some((r) => r.url === CREATE_URL)).toBe(false)
    expect(result?.id).toBe('r1')
    expect(snackbarItems()[0]).toEqual(['已通知老師您到了', 'info'])
  })

  it('useArriveNow falls back to the existing request when the shortcut conflicts', async () => {
    mock.onPost(CREATE_URL).reply(409, apiError('pickup_request_exists', '已有進行中的接送請求', { request_id: 'r3' }))
    mock.onPost(arrivedUrl('r3')).reply(200, request('r3'))
    const api = await setup()

    api.request('s1', null)
    const result = await api.confirm()

    expect(posts()).toEqual([CREATE_URL, arrivedUrl('r3')])
    expect(result?.id).toBe('r3')
    expect(api.lastResult.value?.id).toBe('r3')
    expect(snackbarItems()).toEqual([['已通知老師您到了', 'info']])
  })

  it('useArriveNow remembers skip confirm', async () => {
    mock.onPost(CREATE_URL).reply(201, request('r8'))
    const api = await setup()

    api.request('s1', null)
    api.skipNextTime.value = true
    await api.confirm()

    expect(localStorage.getItem(SKIP_KEY)).toBe('1')

    api.request('s1', null)
    expect(api.confirmOpen.value).toBe(false)
    await flushPromises()

    expect(posts()).toEqual([CREATE_URL, CREATE_URL])
    expect(snackbarItems()).toEqual([
      ['已通知老師您到了', 'info'],
      ['已通知老師您到了', 'info'],
    ])
  })

  it('useArriveNow does not remember when skip is not checked and resets the checkbox on reopen', async () => {
    mock.onPost(CREATE_URL).reply(201, request('r8'))
    const api = await setup()

    api.request('s1', null)
    await api.confirm()
    expect(localStorage.getItem(SKIP_KEY)).toBeNull()

    api.skipNextTime.value = true
    api.dismiss()
    api.request('s1', null)

    expect(api.confirmOpen.value).toBe(true)
    expect(api.skipNextTime.value).toBe(false)
  })

  it('useArriveNow skips the dialog when the preference is already stored', async () => {
    localStorage.setItem(SKIP_KEY, '1')
    mock.onPost(arrivedUrl('r1')).reply(200, request('r1'))
    const api = await setup()

    api.request('s1', 'r1')
    expect(api.confirmOpen.value).toBe(false)
    await flushPromises()

    expect(posts()).toEqual([arrivedUrl('r1')])
    expect(api.lastResult.value?.id).toBe('r1')
  })

  it('useArriveNow ignores an unavailable storage', async () => {
    // happy-dom 的 localStorage 方法綁在實例上，spy 原型不會生效
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    mock.onPost(CREATE_URL).reply(201, request('r8'))
    const api = await setup()

    api.request('s1', null)
    expect(api.confirmOpen.value).toBe(true)
    api.skipNextTime.value = true
    const result = await api.confirm()

    expect(result?.id).toBe('r8')
    expect(snackbarItems()[0]).toEqual(['已通知老師您到了', 'info'])
    // 確認讀寫都真的走到了拋錯的 storage
    expect(getItem).toHaveBeenCalledWith('parent_pickup_arrive_skip_confirm')
    expect(setItem).toHaveBeenCalledWith('parent_pickup_arrive_skip_confirm', '1')
  })

  it('useArriveNow dismiss sends nothing', async () => {
    const api = await setup()

    api.request('s1', null)
    api.dismiss()
    await flushPromises()

    expect(api.confirmOpen.value).toBe(false)
    expect(mock.history.post.length).toBe(0)
    // 取消後直接呼叫 confirm 也不會送出
    expect(await api.confirm()).toBeNull()
    expect(mock.history.post.length).toBe(0)
  })

  it('useArriveNow error message', async () => {
    mock.onPost(CREATE_URL).reply(403, apiError('pickup_not_allowed', '沒有接送權限'))
    const api = await setup()

    api.request('s1', null)
    const result = await api.confirm()

    expect(result).toBeNull()
    expect(api.lastResult.value).toBeNull()
    expect(snackbarItems()[0]).toEqual(['您沒有這位小孩的接送權限', 'error'])
  })

  it('useArriveNow not found message', async () => {
    mock.onPost(arrivedUrl('r1')).reply(404, apiError('pickup_request_not_found', '找不到接送請求'))
    mock.onGet(TODAY_URL).reply(200, [])
    const api = await setup()

    api.request('s1', 'r1')
    const result = await api.confirm()

    expect(result).toBeNull()
    expect(snackbarItems()[0]).toEqual(['找不到這筆接送請求，已重新整理', 'error'])
    // 接送請求已重新整理
    expect(mock.history.get.filter((r) => r.url === TODAY_URL)).toHaveLength(1)
  })

  it('useArriveNow maps the remaining error codes', async () => {
    mock.onGet(TODAY_URL).reply(200, [])
    const api = await setup()
    const messageFor = async (status: number, body: unknown) => {
      mock.onPost(CREATE_URL).replyOnce(status, body)
      api.request('s1', null)
      expect(await api.confirm()).toBeNull()
      const items = useSnackbarStore().items
      return items[items.length - 1]?.message
    }

    expect(await messageFor(409, apiError('invalid_pickup_status', '狀態不允許'))).toBe('狀態已更新，請確認後再操作')
    useSnackbarStore().clear()
    expect(await messageFor(409, apiError('pickup_window_closed', '今天的接送時段已結束'))).toBe('今天的接送時段已結束')
    useSnackbarStore().clear()
    expect(await messageFor(409, apiError('student_not_available', '王小明今天請假'))).toBe('王小明今天請假')
    useSnackbarStore().clear()
    expect(await messageFor(422, apiError('not_service_day', '今天不是上課日'))).toBe('今天不是上課日')
    useSnackbarStore().clear()
    expect(await messageFor(409, apiError('student_not_active', '此學生目前暫停，無法進行此操作'))).toBe('此學生目前暫停，無法進行此操作')
    useSnackbarStore().clear()
    expect(await messageFor(500, apiError('internal_error', '伺服器發生錯誤'))).toBe('送出失敗，請稍後再試')
    useSnackbarStore().clear()
    mock.onPost(CREATE_URL).networkErrorOnce()
    api.request('s1', null)
    expect(await api.confirm()).toBeNull()
    expect(useSnackbarStore().items[0]?.message).toBe('送出失敗，請稍後再試')
  })

  it('useArriveNow ignores double confirm', async () => {
    const pending = deferredReply()
    mock.onPost(CREATE_URL).reply(pending.reply)
    const api = await setup()

    api.request('s1', null)
    const first = api.confirm()
    expect(api.busy.value).toBe(true)
    const second = await api.confirm()

    expect(second).toBeNull()
    pending.resolve([201, request('r8')])
    expect((await first)?.id).toBe('r8')
    expect(mock.history.post).toHaveLength(1)
    expect(api.busy.value).toBe(false)
    expect(snackbarItems()).toEqual([['已通知老師您到了', 'info']])
  })

  it('useArriveNow ignores request while busy', async () => {
    const pending = deferredReply()
    mock.onPost(CREATE_URL).reply(pending.reply)
    const api = await setup()
    api.request('s1', null)
    const first = api.confirm()

    api.request('s1', 'r1')
    expect(api.confirmOpen.value).toBe(false)
    // 不再提醒時 request 會直接送出，busy 期間同樣忽略
    localStorage.setItem(SKIP_KEY, '1')
    api.request('s1', null)
    await flushPromises()

    expect(mock.history.post).toHaveLength(1)
    pending.resolve([201, request('r8')])
    expect((await first)?.id).toBe('r8')
    expect(posts()).toEqual([CREATE_URL])
  })

  it('useArriveNow calls onStale only for stale errors', async () => {
    mock.onGet(TODAY_URL).reply(200, [])
    const onStale = vi.fn()
    const api = await setup({ onStale })
    const attempt = async (status: number, body: unknown) => {
      mock.onPost(arrivedUrl('r1')).replyOnce(status, body)
      api.request('s1', 'r1')
      return api.confirm()
    }

    expect(await attempt(409, apiError('invalid_pickup_status', '狀態不符'))).toBeNull()
    expect(onStale).toHaveBeenCalledTimes(1)
    expect(snackbarItems()[0]).toEqual(['狀態已更新，請確認後再操作', 'error'])

    expect(await attempt(403, apiError('pickup_not_allowed', '沒有接送權限'))).toBeNull()
    expect(onStale).toHaveBeenCalledTimes(1)

    expect((await attempt(200, request('r1')))?.id).toBe('r1')
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  it('useArriveNow calls onStale for a missing request and swallows its failure', async () => {
    mock.onGet(TODAY_URL).reply(200, [])
    mock.onPost(arrivedUrl('r1')).reply(404, apiError('pickup_request_not_found', '找不到接送請求'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onStale = vi.fn(() => Promise.reject(new Error('重抓失敗')))
    const api = await setup({ onStale })

    api.request('s1', 'r1')
    const result = await api.confirm()
    await flushPromises()

    expect(result).toBeNull()
    expect(onStale).toHaveBeenCalledTimes(1)
    expect(snackbarItems()[0]).toEqual(['找不到這筆接送請求，已重新整理', 'error'])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('useArriveNow without options ignores stale errors', async () => {
    mock.onGet(TODAY_URL).reply(200, [])
    mock.onPost(arrivedUrl('r1')).reply(409, apiError('invalid_pickup_status', '狀態不符'))
    const api = await setup()

    api.request('s1', 'r1')
    await expect(api.confirm()).resolves.toBeNull()
    expect(snackbarItems()[0]).toEqual(['狀態已更新，請確認後再操作', 'error'])
  })
})
