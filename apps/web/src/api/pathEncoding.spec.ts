import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/shared/types/api'
import { createApiMock } from '@/test/helpers'
import { adminHttp } from './http'
import { getStudent } from './students'

/**
 * 找出 api client 原始碼中不安全的路徑插值：template literal 的每個 `${...}` 都必須是
 * encodePathSegment(...) 或 *Path(...)（把 id 編碼後組路徑的小函式）。先去掉註解，避免註解裡的反引號干擾。
 *
 * 已知限制（比照 PARENT-192）：只看 template literal；用 '+' 串接字串、或插值內是組合運算式
 * （例如 `${a ? encodePathSegment(b) : c}`、巢狀 template）不會被正確判斷，新增 client 時不要用這些寫法組路徑。
 */
function unsafeInterpolations(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  const offenders: string[] = []
  for (const literal of code.matchAll(/`([^`]*)`/g)) {
    for (const expression of (literal[1] ?? '').matchAll(/\$\{([^}]*)\}/g)) {
      const text = (expression[1] ?? '').trim()
      if (!/^(encodePathSegment|\w+Path)\(.+\)$/.test(text)) offenders.push(text)
    }
  }
  return offenders
}

const sources = import.meta.glob<string>('./*.ts', { query: '?raw', import: 'default', eager: true })

describe('admin api path encoding', () => {
  let mock: MockAdapter

  beforeEach(() => {
    mock = createApiMock(adminHttp)
    mock.onAny().reply(200, {})
  })

  afterEach(() => {
    mock.restore()
  })

  it('admin api path encoding rejects dot ids', async () => {
    for (const id of ['..', '.', '']) {
      const err = await getStudent(id).catch((e: unknown) => e)
      expect(err, JSON.stringify(id)).toBeInstanceOf(ApiError)
      expect((err as ApiError).code, JSON.stringify(id)).toBe('invalid_path_segment')
    }
    expect(mock.history.get).toEqual([])
  })

  it('admin api path encoding keeps normal uuid urls unchanged', async () => {
    const uuid = '3f2b8c1e-5a4d-4c7e-9b0a-1d2e3f4a5b6c'
    await getStudent(uuid)
    expect(mock.history.get!.map((r) => r.url)).toEqual([`/admin/students/${uuid}`])
  })

  it('admin api path encoding static scan', () => {
    const clientFiles = Object.entries(sources).filter(([file]) => !file.endsWith('.spec.ts'))

    // 確認掃描真的讀到各個 client（避免 glob 失效造成空轉）
    const names = clientFiles.map(([file]) => file.replace('./', ''))
    const expected = [
      'attendance.ts',
      'classes.ts',
      'exams.ts',
      'guardians.ts',
      'homework.ts',
      'leaves.ts',
      'notifications.ts',
      'pickupAuthorizations.ts',
      'pickupRequests.ts',
      'referenceData.ts',
      'roles.ts',
      'settings.ts',
      'staffUsers.ts',
      'students.ts',
    ]
    for (const name of expected) expect(names).toContain(name)
    const offenders = clientFiles.flatMap(([file, source]) => unsafeInterpolations(source).map((e) => `${file}: ${e}`))
    expect(offenders).toEqual([])
  })

  it('admin api path encoding static scan checker flags raw interpolation', () => {
    expect(unsafeInterpolations('const p = `/admin/x/${id}`')).toEqual(['id'])
    expect(unsafeInterpolations('const p = `/admin/x/${encodeURIComponent(id)}`')).toEqual(['encodeURIComponent(id)'])
    expect(unsafeInterpolations('const p = `/admin/x/${encodePathSegment(a)}/${b}`')).toEqual(['b'])
    expect(unsafeInterpolations('const p = `${leavePath(id)}/cancel`')).toEqual([])
    expect(unsafeInterpolations('/** 例如 `${raw}` */\n// `${raw2}`\nconst a = 1')).toEqual([])
  })
})
