import { describe, expect, it } from 'vitest'
import { ApiError } from '@/shared/types/api'
import { cannotGrantMessage } from './cannotGrantMessage'

const LABELS: ReadonlyMap<string, string> = new Map([['students:write', '學生資料編輯']])

describe('cannotGrantMessage', () => {
  it('cannotGrantMessage joins permission labels', () => {
    const err = new ApiError(403, 'cannot_grant_permissions', '權限不足', {
      permissions: ['students:write', 'x:unknown', 3],
    })
    expect(cannotGrantMessage(err, LABELS)).toBe('你沒有以下權限，無法授出：學生資料編輯、x:unknown')
  })

  it('cannotGrantMessage falls back without list', () => {
    expect(cannotGrantMessage(new ApiError(403, 'cannot_grant_permissions', '權限不足', null), LABELS)).toBe('權限不足')
    expect(
      cannotGrantMessage(new ApiError(403, 'cannot_grant_permissions', '權限不足', { permissions: [1, null] }), LABELS),
    ).toBe('權限不足')
    expect(cannotGrantMessage(new Error('boom'), LABELS)).toBe('你沒有部分權限，無法授出')
  })
})
