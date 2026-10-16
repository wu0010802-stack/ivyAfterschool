import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/types/api'
import { createApiMock } from '@/test/helpers'
import { parentHttp, parentRefreshHttp } from './http'
import {
  type AuthorizationWithCode,
  type ParentAuthorization,
  cancelPickupAuthorization,
  createPickupAuthorization,
  listPickupAuthorizations,
  regeneratePickupCode,
} from './pickupAuthorizations'

const UNAUTHORIZED = { error: { code: 'unauthenticated', message: '請重新登入', details: null } }

const ACTIVE: ParentAuthorization = {
  id: 'a1',
  student_id: 's1',
  service_date: '2026-10-03',
  pickup_person_id: 'pp1',
  proxy_name: '李阿姨',
  proxy_phone: '0912000123',
  code_last4: '3456',
  status: 'active',
  effective_status: 'active',
  verified_at: null,
  verification_method: null,
  created_at: '2026-10-02T01:00:00Z',
}

const EXPIRED: ParentAuthorization = {
  ...ACTIVE,
  id: 'a0',
  service_date: '2026-09-28',
  pickup_person_id: null,
  proxy_name: '陳叔叔',
  proxy_phone: '0922000456',
  code_last4: '7890',
  effective_status: 'expired',
}

const CREATED: AuthorizationWithCode = { authorization: ACTIVE, code: '123456' }

async function apiErrorOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    return e as ApiError
  }
  throw new Error('預期 reject 但 resolve 了')
}

/** 第 index 個 POST 實際送出的 JSON body（沒有 body 時為 undefined） */
function postBody(mock: MockAdapter, index: number): unknown {
  const data = mock.history.post[index]!.data
  return data === undefined ? undefined : JSON.parse(data as string)
}

describe('pickupAuthorizationsApi', () => {
  let mock: MockAdapter
  let refreshMock: MockAdapter

  beforeEach(() => {
    mock = createApiMock(parentHttp)
    refreshMock = createApiMock(parentRefreshHttp)
  })

  afterEach(() => {
    mock.restore()
    refreshMock.restore()
  })

  it('pickupAuthorizationsApi list path', async () => {
    mock.onGet('/parent/children/s1/pickup-authorizations').reply(200, [ACTIVE, EXPIRED])

    const list = await listPickupAuthorizations('s1')

    expect(list).toEqual([ACTIVE, EXPIRED])
    expect(list[1]!.effective_status).toBe('expired')
    expect(list[1]!.pickup_person_id).toBeNull()
    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children/s1/pickup-authorizations'])
  })

  it('pickupAuthorizationsApi list propagates 404 for a child that is not yours', async () => {
    mock.onGet('/parent/children/s9/pickup-authorizations').reply(404, {
      error: { code: 'student_not_found', message: '找不到這位學生', details: null },
    })

    const err = await apiErrorOf(listPickupAuthorizations('s9'))

    expect(err.status).toBe(404)
    expect(err.code).toBe('student_not_found')
  })

  it('pickupAuthorizationsApi create with person returns code', async () => {
    mock.onPost('/parent/children/s1/pickup-authorizations').reply(201, CREATED)

    const result = await createPickupAuthorization('s1', { service_date: '2026-10-03', pickup_person_id: 'pp1' })

    expect(result.code).toBe('123456')
    expect(result.authorization.id).toBe('a1')
    expect(result.authorization.code_last4).toBe('3456')
    expect(result).toEqual(CREATED)
    expect(mock.history.post).toHaveLength(1)
    expect(mock.history.post[0]!.url).toBe('/parent/children/s1/pickup-authorizations')
    // JSON body 深等於輸入，不多不少（proxy 欄位不可一起送，後端會 422）
    expect(postBody(mock, 0)).toEqual({ service_date: '2026-10-03', pickup_person_id: 'pp1' })
    expect(String(mock.history.post[0]!.headers?.['Content-Type'])).toContain('application/json')
  })

  it('pickupAuthorizationsApi create proxy body', async () => {
    mock.onPost('/parent/children/s1/pickup-authorizations').reply(409, {
      error: { code: 'authorization_limit_reached', message: '當日代理授權已達上限', details: null },
    })

    const err = await apiErrorOf(
      createPickupAuthorization('s1', { service_date: '2026-10-03', proxy_name: '陳叔叔', proxy_phone: '0922000456' }),
    )

    expect(err.status).toBe(409)
    expect(err.code).toBe('authorization_limit_reached')
    expect(err.message).toBe('當日代理授權已達上限')
    expect(postBody(mock, 0)).toEqual({ service_date: '2026-10-03', proxy_name: '陳叔叔', proxy_phone: '0922000456' })
  })

  it('pickupAuthorizationsApi create surfaces validation details', async () => {
    const details = [{ loc: ['body'], msg: '請指定常用接送人，或同時提供 proxy_name 與 proxy_phone', type: 'value_error' }]
    mock.onPost('/parent/children/s1/pickup-authorizations').reply(422, {
      error: { code: 'validation_error', message: '輸入資料格式錯誤', details },
    })

    const err = await apiErrorOf(createPickupAuthorization('s1', { service_date: '2026-10-03', pickup_person_id: '' }))

    expect(err.status).toBe(422)
    expect(err.code).toBe('validation_error')
    expect(err.details).toEqual(details)
  })

  it('pickupAuthorizationsApi create resends after session refresh', async () => {
    mock
      .onPost('/parent/children/s1/pickup-authorizations')
      .replyOnce(401, UNAUTHORIZED)
      .onPost('/parent/children/s1/pickup-authorizations')
      .replyOnce(201, CREATED)
    refreshMock.onPost('/parent/auth/refresh').reply(200, { parent: {} })

    const result = await createPickupAuthorization('s1', { service_date: '2026-10-03', pickup_person_id: 'pp1' })

    expect(result.code).toBe('123456')
    expect(refreshMock.history.post).toHaveLength(1)
    expect(mock.history.post).toHaveLength(2)
    expect(postBody(mock, 1)).toEqual({ service_date: '2026-10-03', pickup_person_id: 'pp1' })
  })

  it('pickupAuthorizationsApi regenerate path', async () => {
    mock.onPost('/parent/pickup-authorizations/a1/regenerate-code').reply(409, {
      error: { code: 'authorization_expired', message: '這筆授權已過期', details: null },
    })

    const err = await apiErrorOf(regeneratePickupCode('a1'))

    expect(err.status).toBe(409)
    expect(err.code).toBe('authorization_expired')
    expect(mock.history.post.map((r) => r.url)).toEqual(['/parent/pickup-authorizations/a1/regenerate-code'])
    // 無 body
    expect(postBody(mock, 0)).toBeUndefined()
  })

  it('pickupAuthorizationsApi regenerate returns the new code once', async () => {
    const regenerated: AuthorizationWithCode = { authorization: { ...ACTIVE, code_last4: '6543' }, code: '993456' }
    mock.onPost('/parent/pickup-authorizations/a1/regenerate-code').reply(200, regenerated)

    const result = await regeneratePickupCode('a1')

    expect(result).toEqual(regenerated)
    expect(result.code).toBe('993456')
    expect(result.authorization.code_last4).toBe('6543')
  })

  it('pickupAuthorizationsApi cancel path', async () => {
    const cancelled: ParentAuthorization = { ...ACTIVE, status: 'cancelled', effective_status: 'cancelled' }
    mock.onPost('/parent/pickup-authorizations/a1/cancel').reply(200, cancelled)

    const result = await cancelPickupAuthorization('a1')

    expect(result).toEqual(cancelled)
    expect(result.effective_status).toBe('cancelled')
    expect(mock.history.post.map((r) => r.url)).toEqual(['/parent/pickup-authorizations/a1/cancel'])
    expect(postBody(mock, 0)).toBeUndefined()
  })

  it('pickupAuthorizationsApi cancel propagates 409 and 404', async () => {
    mock.onPost('/parent/pickup-authorizations/a1/cancel').reply(409, {
      error: { code: 'authorization_not_active', message: '這筆授權已結束', details: null },
    })
    mock.onPost('/parent/pickup-authorizations/a9/cancel').reply(404, {
      error: { code: 'pickup_authorization_not_found', message: '找不到這筆授權', details: null },
    })

    const conflict = await apiErrorOf(cancelPickupAuthorization('a1'))
    expect(conflict.status).toBe(409)
    expect(conflict.code).toBe('authorization_not_active')

    const missing = await apiErrorOf(cancelPickupAuthorization('a9'))
    expect(missing.status).toBe(404)
    expect(missing.code).toBe('pickup_authorization_not_found')
  })

  it('pickupAuthorizationsApi encodes ids in paths', async () => {
    mock.onGet('/parent/children/s%2F1/pickup-authorizations').reply(200, [])
    mock.onPost('/parent/pickup-authorizations/a%2F1/cancel').reply(200, ACTIVE)
    mock.onPost('/parent/pickup-authorizations/a%3F1/regenerate-code').reply(200, CREATED)
    mock.onPost('/parent/children/s%2F1/pickup-authorizations').reply(201, CREATED)

    await listPickupAuthorizations('s/1')
    await cancelPickupAuthorization('a/1')
    await regeneratePickupCode('a?1')
    await createPickupAuthorization('s/1', { service_date: '2026-10-03', pickup_person_id: 'pp1' })

    expect(mock.history.get.map((r) => r.url)).toEqual(['/parent/children/s%2F1/pickup-authorizations'])
    expect(mock.history.post.map((r) => r.url)).toEqual([
      '/parent/pickup-authorizations/a%2F1/cancel',
      '/parent/pickup-authorizations/a%3F1/regenerate-code',
      '/parent/children/s%2F1/pickup-authorizations',
    ])
  })

  it('pickupAuthorizationsApi never logs the code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    mock.onPost('/parent/children/s1/pickup-authorizations').reply(201, CREATED)
    mock.onPost('/parent/pickup-authorizations/a1/regenerate-code').reply(200, CREATED)

    await createPickupAuthorization('s1', { service_date: '2026-10-03', pickup_person_id: 'pp1' })
    await regeneratePickupCode('a1')

    for (const spy of [log, info, debug]) {
      expect(spy).not.toHaveBeenCalled()
    }
  })
})
