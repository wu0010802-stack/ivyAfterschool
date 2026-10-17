import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue'
import { adminHttp } from '@/api/http'
import type { PickupQueue, PickupRequest } from '@/api/pickupRequests'
import { createApiMock } from '@/test/helpers'
import { STAGING_DURATION_MS, useDismissalPosQueue, type PosQueueItem } from './useDismissalPosQueue'

const CREATE_URL = '/admin/pickup/requests'
const DATE = '2026-10-02'
const NOW = Date.parse('2026-10-02T09:00:00Z')

function makeRequest(overrides: Partial<PickupRequest> & { studentId?: string; studentName?: string } = {}): PickupRequest {
  const { studentId = 's1', studentName = '王小明', ...rest } = overrides
  return {
    id: 'r1',
    student: {
      id: studentId,
      student_no: 'S11301',
      name: studentName,
      grade_level: 1,
      class_id: 'c1',
      class_name: '低年級A班',
    },
    service_date: DATE,
    source: 'parent',
    requested_by_type: 'parent',
    requested_by_name: '王媽媽',
    expected_arrival_at: null,
    status: 'pending',
    homework_status_at_request: 'in_progress',
    current_homework_status: 'in_progress',
    current_ready_eta: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    replied_by_name: null,
    needs_reply: true,
    arrived_at: null,
    completed_at: null,
    completed_by_name: null,
    completion_method: null,
    picked_up_by_name: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-10-02T08:00:00Z',
    ...rest,
  }
}

function makeQueue(open: PickupRequest[] = [], closed: PickupRequest[] = []): PickupQueue {
  const counts = { pending: 0, acknowledged: 0, arrived: 0, needs_reply: 0 }
  for (const r of open) {
    if (r.status === 'pending' || r.status === 'acknowledged' || r.status === 'arrived') counts[r.status] += 1
    if (r.needs_reply) counts.needs_reply += 1
  }
  return { date: DATE, open, closed, counts, latest_expected_arrival: '19:00' }
}

const STUDENT = { id: 's1', name: '王小明', className: '低年級A班' }

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  )
}

type Queue = ReturnType<typeof useDismissalPosQueue>

let mock: MockAdapter
let scope: EffectScope

function setup(queue: Ref<PickupQueue | null>, options?: Parameters<typeof useDismissalPosQueue>[1]): Queue {
  scope = effectScope()
  const result = scope.run(() => useDismissalPosQueue(queue, options))
  if (!result) throw new Error('scope 未執行')
  return result
}

function itemOf(q: Queue, id: string): PosQueueItem {
  const item = q.items.value.find((i) => i.id === id)
  if (!item) throw new Error(`items 沒有 ${id}`)
  return item
}

describe('useDismissalPosQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    scope?.stop()
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('useDismissalPosQueue staging submits after 5 seconds', async () => {
    mock.onPost(CREATE_URL).reply(201, makeRequest({ id: 'r9', source: 'staff' }))
    const q = setup(ref(makeQueue()))

    expect(q.addToQueue(STUDENT)).toBe(true)
    expect(q.items.value[0]?.phase).toBe('staging')
    expect(q.items.value[0]?.studentId).toBe('s1')
    expect(q.items.value[0]?.studentName).toBe('王小明')
    expect(q.items.value[0]?.className).toBe('低年級A班')
    expect(q.items.value[0]?.countdown).toEqual({ startedAt: NOW, durationMs: STAGING_DURATION_MS })
    expect(q.stagingIds.value.has('s1')).toBe(true)

    await vi.advanceTimersByTimeAsync(4999)
    expect(mock.history.post).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(mock.history.post).toHaveLength(1)
    expect(mock.history.post[0]?.url).toBe(CREATE_URL)
    expect(JSON.parse(mock.history.post[0]?.data as string)).toEqual({ student_id: 's1' })
  })

  it('useDismissalPosQueue submits through injected create', async () => {
    const created = makeRequest({ id: 'r9', source: 'staff' })
    const create = vi.fn((body: { student_id: string }) => Promise.resolve(body.student_id === 's1' ? created : null))
    const q = setup(ref(makeQueue()), { create })

    q.addToQueue(STUDENT)
    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0]).toEqual({ student_id: 's1' })
    expect(mock.history.post).toHaveLength(0)
    expect(q.items.value.map((i) => [i.id, i.phase])).toEqual([['r9', 'active']])

    // 回 null：board 已提示並重新整理，不留本地卡片、不另外報錯，可再次發起
    q.addToQueue({ id: 's2', name: '陳小美', className: '低年級A班' })
    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)
    expect(create).toHaveBeenCalledTimes(2)
    expect(q.items.value.map((i) => i.id)).toEqual(['r9'])
    expect(q.stagingIds.value.size).toBe(0)
    expect(document.body.textContent).not.toContain('建立接送請求失敗')
    expect(q.addToQueue({ id: 's2', name: '陳小美', className: '低年級A班' })).toBe(true)
  })

  it('useDismissalPosQueue keeps local active until queue catches up', async () => {
    const created = makeRequest({ id: 'r9', source: 'staff', status: 'pending' })
    mock.onPost(CREATE_URL).reply(201, created)
    const queue = ref<PickupQueue | null>(makeQueue())
    const q = setup(queue)

    q.addToQueue(STUDENT)
    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)

    expect(q.items.value.some((i) => i.phase === 'staging')).toBe(false)
    expect(q.stagingIds.value.size).toBe(0)
    expect(itemOf(q, 'r9').phase).toBe('active')
    expect(itemOf(q, 'r9').request?.id).toBe('r9')
    expect(q.items.value).toHaveLength(1)

    queue.value = makeQueue([{ ...created, status: 'acknowledged' }])
    await nextTick()

    expect(q.items.value.filter((i) => i.id === 'r9')).toHaveLength(1)
    expect(itemOf(q, 'r9').request?.status).toBe('acknowledged')
  })

  it('useDismissalPosQueue drops local copy once queue catches up', async () => {
    const created = makeRequest({ id: 'r9', source: 'staff' })
    mock.onPost(CREATE_URL).reply(201, created)
    const queue = ref<PickupQueue | null>(makeQueue())
    const q = setup(queue)
    q.addToQueue(STUDENT)
    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)
    expect(itemOf(q, 'r9').phase).toBe('active')
    // 本地樂觀版本仍是進行中：擋住重複代建
    expect(q.addToQueue(STUDENT)).toBe(false)

    // ws 追上：外部清單出現 r9（進行中）
    queue.value = makeQueue([created])
    await nextTick()
    expect(q.addToQueue(STUDENT)).toBe(false)

    // 家長取消：r9 移到 closed → 本地樂觀版本已移除，不可再擋住該生代建
    queue.value = makeQueue([], [{ ...created, status: 'cancelled', cancelled_at: '2026-10-02T09:03:00Z' }])
    await nextTick()
    expect(q.items.value.map((i) => `${i.phase}:${i.id}`)).toEqual(['closed:r9'])
    expect(q.addToQueue(STUDENT)).toBe(true)
    // 倒數中：該生稍早已結束的 r9 讓位，只剩倒數卡
    expect(q.items.value.map((i) => i.id)).toEqual(['staging:s1'])
  })

  it('useDismissalPosQueue rejects duplicates', async () => {
    const queue = ref<PickupQueue | null>(makeQueue([makeRequest({ id: 'r2', studentId: 's2', studentName: '陳小美' })]))
    const q = setup(queue)

    expect(q.addToQueue({ id: 's2', name: '陳小美', className: '低年級A班' })).toBe(false)
    expect(q.stagingIds.value.size).toBe(0)

    expect(q.addToQueue(STUDENT)).toBe(true)
    expect(q.addToQueue(STUDENT)).toBe(false)
    expect(q.items.value.filter((i) => i.phase === 'staging')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS - 1)
    expect(mock.history.post).toHaveLength(0)
  })

  it('useDismissalPosQueue cancel staging does not call api', async () => {
    const q = setup(ref(makeQueue()))
    q.addToQueue(STUDENT)
    const item = q.items.value[0]
    if (!item) throw new Error('沒有 staging 項目')

    await expect(q.cancel(item)).resolves.toBe(true)
    expect(q.items.value).toHaveLength(0)
    expect(q.stagingIds.value.has('s1')).toBe(false)

    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)
    expect(mock.history.post).toHaveLength(0)
  })

  it('useDismissalPosQueue sorts active and hides superseded closed', async () => {
    const pending1730 = makeRequest({ id: 'rA', studentId: 'sA', expected_arrival_at: '17:30', created_at: '2026-10-02T08:00:00Z' })
    // 家長已到的兩筆：預計抵達都比 pending 晚（18:00 / 未填）、建立也較晚，只有「arrived 在前」能解釋它們排前面；
    // 兩筆之間只有 arrived_at 能解釋 rF（09:02 到）排在 rB（09:05 到）前
    const arrived = makeRequest({
      id: 'rB',
      studentId: 'sB',
      status: 'arrived',
      arrived_at: '2026-10-02T09:05:00Z',
      expected_arrival_at: '18:00',
      created_at: '2026-10-02T08:30:00Z',
    })
    const arrivedEarlier = makeRequest({
      id: 'rF',
      studentId: 'sF',
      status: 'arrived',
      arrived_at: '2026-10-02T09:02:00Z',
      expected_arrival_at: null,
      created_at: '2026-10-02T08:45:00Z',
    })
    const pendingNull = makeRequest({ id: 'rC', studentId: 'sC', expected_arrival_at: null, created_at: '2026-10-02T07:00:00Z' })
    const s1Completed = makeRequest({
      id: 'rD',
      studentId: 's1',
      status: 'completed',
      completed_at: '2026-10-02T08:40:00Z',
      created_at: '2026-10-02T07:30:00Z',
    })
    const s9Cancelled = makeRequest({
      id: 'rE',
      studentId: 's9',
      status: 'cancelled',
      cancelled_at: '2026-10-02T08:50:00Z',
      created_at: '2026-10-02T07:40:00Z',
    })
    const queue = ref<PickupQueue | null>(
      makeQueue([pending1730, arrived, pendingNull, arrivedEarlier], [s1Completed, s9Cancelled]),
    )
    const q = setup(queue)

    q.addToQueue(STUDENT)

    const ids = q.items.value.map((i) => i.id)
    expect(ids[0]).toBe('staging:s1')
    expect(q.items.value.filter((i) => i.phase === 'active').map((i) => i.id)).toEqual(['rF', 'rB', 'rA', 'rC'])
    expect(ids).not.toContain('rD')
    expect(q.items.value.filter((i) => i.phase === 'closed').map((i) => i.id)).toEqual(['rE'])

    // 倒數取消後，s1 已結束的紀錄重新出現，依結束時間新到舊
    await q.cancel(itemOf(q, 'staging:s1'))
    expect(q.items.value.filter((i) => i.phase === 'closed').map((i) => i.id)).toEqual(['rE', 'rD'])

    // 排序與外部清單的順序無關：每一種輸入順序都得到同樣結果（比較函式不一致時某些順序會排錯）
    const open = [pending1730, arrived, pendingNull, arrivedEarlier]
    for (const perm of permutations(open)) {
      queue.value = makeQueue(perm, [s1Completed, s9Cancelled])
      await nextTick()
      const order = q.items.value.filter((i) => i.phase === 'active').map((i) => i.id)
      expect(order, `輸入順序 ${perm.map((r) => r.id).join(',')}`).toEqual(['rF', 'rB', 'rA', 'rC'])
    }
  })

  it('useDismissalPosQueue handles conflict on submit', async () => {
    mock.onPost(CREATE_URL).reply(409, {
      error: {
        code: 'pickup_request_exists',
        message: '此學生今天已有進行中的接送請求',
        details: { request_id: 'r7', status: 'pending' },
      },
    })
    const q = setup(ref(makeQueue()))
    q.addToQueue(STUDENT)

    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)

    expect(mock.history.post).toHaveLength(1)
    expect(document.body.textContent).toContain('王小明 已有進行中的接送請求')
    expect(q.stagingIds.value.size).toBe(0)
    expect(q.items.value).toHaveLength(0)
  })

  it('useDismissalPosQueue shows backend message on other submit errors', async () => {
    mock.onPost(CREATE_URL).reply(409, {
      error: { code: 'student_not_available', message: '學生今天請假', details: null },
    })
    const q = setup(ref(makeQueue()))
    q.addToQueue(STUDENT)

    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)

    expect(document.body.textContent).toContain('學生今天請假')
    expect(document.body.textContent).not.toContain('已有進行中的接送請求')
    expect(q.stagingIds.value.size).toBe(0)
    // 失敗後可以再次發起
    expect(q.addToQueue(STUDENT)).toBe(true)
  })

  it('useDismissalPosQueue cancel active calls api and drops local copy', async () => {
    const created = makeRequest({ id: 'r9', source: 'staff' })
    mock.onPost(CREATE_URL).reply(201, created)
    mock.onPost('/admin/pickup/requests/r9/cancel').replyOnce(200, { ...created, status: 'cancelled' })
    const q = setup(ref(makeQueue()))
    q.addToQueue(STUDENT)
    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)
    expect(itemOf(q, 'r9').phase).toBe('active')

    await expect(q.cancel(itemOf(q, 'r9'), '家長改明天')).resolves.toBe(true)
    expect(JSON.parse(mock.history.post.at(-1)?.data as string)).toEqual({ reason: '家長改明天' })
    expect(q.items.value).toHaveLength(0)

    // 失敗：提示後端訊息、回 false；已結束的項目直接回 false 且不打 API
    const active = makeRequest({ id: 'r3', studentId: 's3' })
    const closed = makeRequest({ id: 'r4', studentId: 's4', status: 'completed', completed_at: '2026-10-02T08:40:00Z' })
    const q2 = setup(ref(makeQueue([active], [closed])))
    mock.onPost('/admin/pickup/requests/r3/cancel').replyOnce(409, {
      error: { code: 'invalid_pickup_status', message: '請求已完成', details: { current_status: 'completed' } },
    })
    const posts = mock.history.post.length
    await expect(q2.cancel(itemOf(q2, 'r3'))).resolves.toBe(false)
    expect(document.body.textContent).toContain('請求已完成')
    await expect(q2.cancel(itemOf(q2, 'r4'))).resolves.toBe(false)
    expect(mock.history.post).toHaveLength(posts + 1)
  })

  it('useDismissalPosQueue dedupes staging when ws arrives before http response', async () => {
    const created = makeRequest({ id: 'r9', source: 'staff' })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.onPost(CREATE_URL).reply(async () => {
      await gate
      return [201, created]
    })
    const queue = ref<PickupQueue | null>(makeQueue())
    const q = setup(queue)
    q.addToQueue(STUDENT)
    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)
    expect(mock.history.post).toHaveLength(1)
    expect(q.items.value.map((i) => i.phase)).toEqual(['staging'])

    // ws 先到：同一學生只顯示 active，不同時出現 staging 卡
    queue.value = makeQueue([created])
    await nextTick()
    expect(q.items.value.map((i) => `${i.phase}:${i.id}`)).toEqual(['active:r9'])
    expect(q.addToQueue(STUDENT)).toBe(false)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(q.items.value.map((i) => `${i.phase}:${i.id}`)).toEqual(['active:r9'])
    expect(q.stagingIds.value.size).toBe(0)
  })

  it('useDismissalPosQueue finally only removes its own staging entry', async () => {
    const created = makeRequest({ id: 'r9', source: 'staff' })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mock.onPost(CREATE_URL).replyOnce(async () => {
      await gate
      return [409, { error: { code: 'pickup_request_exists', message: '已有', details: null } }]
    })
    mock.onPost(CREATE_URL).replyOnce(201, created)
    const q = setup(ref(makeQueue()))
    q.addToQueue(STUDENT)
    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)
    expect(mock.history.post).toHaveLength(1)

    // 第一次送出等待回應期間使用者取消並重新加入：新的倒數不可被第一次的 finally 清掉
    await q.cancel(itemOf(q, 'staging:s1'))
    expect(q.addToQueue(STUDENT)).toBe(true)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(q.stagingIds.value.has('s1')).toBe(true)
    expect(q.items.value.map((i) => i.phase)).toEqual(['staging'])

    await vi.advanceTimersByTimeAsync(STAGING_DURATION_MS)
    expect(mock.history.post).toHaveLength(2)
    expect(itemOf(q, 'r9').phase).toBe('active')
  })

  it('useDismissalPosQueue clears timers on dispose', async () => {
    mock.onPost(CREATE_URL).reply(201, makeRequest({ id: 'r9' }))
    const q = setup(ref(makeQueue()))
    q.addToQueue(STUDENT)
    expect(q.stagingIds.value.has('s1')).toBe(true)

    scope.stop()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(mock.history.post).toHaveLength(0)
  })
})
