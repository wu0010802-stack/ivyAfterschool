import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/shared/types/api'
import { createApiMock } from '@/test/helpers'
import { adminHttp } from './http'
import {
  confirmVisualMatch,
  listPickupAuthorizations,
  overrideCompleteAuthorization,
  verifyPickupCode,
  type StaffAuthorization,
  type VerifyResult,
} from './pickupAuthorizations'
import type { PickupRequest } from './pickupRequests'

const AUTH: StaffAuthorization = {
  id: 'pa1',
  student: { id: 's1', student_no: 'S1001', name: '王小明', grade_level: 3, class_id: 'c1', class_name: '低年級A班' },
  student_id: 's1',
  service_date: '2026-10-02',
  pickup_person_id: null,
  proxy_name: '陳阿姨',
  proxy_phone: '0912-000-123',
  code_last4: '4821',
  status: 'active',
  effective_status: 'active',
  verified_at: null,
  verification_method: null,
  created_at: '2026-10-01T08:00:00Z',
  photo_url: null,
  code_attempts: 1,
  locked: false,
  verified_by_name: null,
}

const REQUEST = {
  id: 'r1',
  student: AUTH.student,
  service_date: '2026-10-02',
  source: 'proxy',
  status: 'completed',
  completion_method: 'code',
} as PickupRequest

function completed(method: 'code' | 'visual_match' | 'override'): VerifyResult {
  return {
    authorization: { ...AUTH, status: 'completed', effective_status: 'completed', verification_method: method },
    request: { ...REQUEST, completion_method: method },
  }
}

function bodyOf(data: unknown): unknown {
  return JSON.parse(data as string)
}

describe('pickupAuthorizationsApi', () => {
  let mock: MockAdapter

  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
  })

  it('pickupAuthorizationsApi lists by date', async () => {
    mock.onGet('/admin/pickup/authorizations').reply(200, [AUTH])

    const list = await listPickupAuthorizations({ date: '2026-10-02' })

    expect(list[0]?.code_last4).toBe('4821')
    expect(list[0]?.effective_status).toBe('active')
    expect(list[0]?.locked).toBe(false)
    expect(mock.history.get[0]?.params).toEqual({ date: '2026-10-02' })
  })

  it('pickupAuthorizationsApi lists by status filter', async () => {
    mock.onGet('/admin/pickup/authorizations').reply(200, [])

    await listPickupAuthorizations({ date: '2026-10-02', status: 'completed' })

    expect(mock.history.get[0]?.params).toEqual({ date: '2026-10-02', status: 'completed' })
  })

  it('pickupAuthorizationsApi verify normalizes code', async () => {
    mock.onPost('/admin/pickup/authorizations/pa1/verify').replyOnce(200, completed('code'))
    mock.onPost('/admin/pickup/authorizations/pa1/verify').replyOnce(400, {
      error: { code: 'pickup_code_mismatch', message: '接送碼錯誤', details: { remaining_attempts: 3 } },
    })

    const ok = await verifyPickupCode('pa1', ' 123-456 ')
    const err = await verifyPickupCode('pa1', '000000').catch((e: unknown) => e)

    expect(bodyOf(mock.history.post[0]?.data)).toEqual({ code: '123456' })
    expect(ok.request.completion_method).toBe('code')
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(400)
    expect((err as ApiError).code).toBe('pickup_code_mismatch')
    expect((err as ApiError).details).toEqual({ remaining_attempts: 3 })
  })

  it('pickupAuthorizationsApi verify surfaces lock and state conflicts', async () => {
    const conflict = (code: string, message: string) => ({ error: { code, message, details: null } })
    mock.onPost('/admin/pickup/authorizations/pa1/verify').replyOnce(409, conflict('pickup_code_locked', '接送碼已鎖定'))
    mock.onPost('/admin/pickup/authorizations/pa1/verify').replyOnce(409, conflict('authorization_not_active', '授權已失效'))
    mock.onPost('/admin/pickup/authorizations/pa1/verify').replyOnce(409, conflict('authorization_not_today', '非今日授權'))

    const codes: string[] = []
    for (let i = 0; i < 3; i++) {
      const err = await verifyPickupCode('pa1', '123456').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(409)
      codes.push((err as ApiError).code)
    }

    expect(codes).toEqual(['pickup_code_locked', 'authorization_not_active', 'authorization_not_today'])
  })

  it('pickupAuthorizationsApi visual match and override', async () => {
    mock.onPost('/admin/pickup/authorizations/pa1/confirm-visual-match').replyOnce(200, completed('visual_match'))
    mock.onPost('/admin/pickup/authorizations/pa1/confirm-visual-match').replyOnce(200, completed('visual_match'))
    mock.onPost('/admin/pickup/authorizations/pa1/override-complete').reply(200, {
      ...completed('override'),
      request: { ...REQUEST, status: 'completed', completion_method: 'override' },
    })

    await confirmVisualMatch('pa1')
    await confirmVisualMatch('pa1', '已核對身分證')
    const overridden = await overrideCompleteAuthorization('pa1', '已電話向家長確認')

    expect(mock.history.post[0]?.data).toBe('{}')
    expect(bodyOf(mock.history.post[1]?.data)).toEqual({ note: '已核對身分證' })
    expect(bodyOf(mock.history.post[2]?.data)).toEqual({ note: '已電話向家長確認' })
    expect(overridden.request.status).toBe('completed')
    expect(overridden.authorization.verification_method).toBe('override')
  })

  it('pickupAuthorizationsApi encodes authorization id in path', async () => {
    mock.onPost('/admin/pickup/authorizations/a%2Fb/verify').reply(200, completed('code'))
    mock.onPost('/admin/pickup/authorizations/a%2Fb/confirm-visual-match').reply(200, completed('visual_match'))
    mock.onPost('/admin/pickup/authorizations/a%2Fb/override-complete').reply(200, completed('override'))

    await verifyPickupCode('a/b', '123456')
    await confirmVisualMatch('a/b')
    await overrideCompleteAuthorization('a/b', '主管確認')

    expect(mock.history.post).toHaveLength(3)
  })
})
