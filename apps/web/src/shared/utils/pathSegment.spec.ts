import { describe, expect, it } from 'vitest'
import { ApiError } from '@/shared/types/api'
import { encodePathSegment } from './pathSegment'

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('encodePathSegment', () => {
  it('encodePathSegment rejects dot segments', () => {
    for (const value of ['.', '..', '']) {
      const err = thrown(() => encodePathSegment(value))
      expect(err, JSON.stringify(value)).toBeInstanceOf(ApiError)
      expect((err as ApiError).code, JSON.stringify(value)).toBe('invalid_path_segment')
      expect((err as ApiError).status, JSON.stringify(value)).toBe(0)
    }
    expect(encodePathSegment('a/b')).toBe('a%2Fb')
    expect(encodePathSegment('..a')).toBe('..a')
  })

  it('encodePathSegment keeps uuid and encodes reserved characters', () => {
    expect(encodePathSegment('3f2b8c1e-5a4d-4c7e-9b0a-1d2e3f4a5b6c')).toBe('3f2b8c1e-5a4d-4c7e-9b0a-1d2e3f4a5b6c')
    expect(encodePathSegment('../me?x=1#y')).toBe('..%2Fme%3Fx%3D1%23y')
  })
})
