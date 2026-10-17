// FRONTEND-290：後台 e2e 共用工具（FRONTEND-291~293）。接真實後端（本機 just up），種子資料一律經 API 建立：
// - loginAsAdmin / adminApi：用 globalSetup 存下的 storageState cookie（./authState.ts），不碰帳密，trace 不會出現密碼；
//   會送出密碼的測試（走登入表單等）只在整檔關閉 trace 的 e2e/admin/login-form.spec.ts。
// - seedBasic / cleanup：建立「E2E班-{runId}」與學生、監護人；結束後依序封存監護人、學生、班級（失敗只記 log）。
// 型別在這裡自行宣告最小欄位（e2e 走 tsconfig.node，不引用 src 的 @/ 路徑）。
import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test'

import { readStorageState } from './authState'

/** 學年度以台北時間 8/1 切換（同 src/utils/academicYear.ts::currentAcademicYear） */
const ACADEMIC_YEAR_START_MONTH = 8
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000
const E2E_GRADE_LEVEL = 3

export interface AdminApi {
  readonly request: APIRequestContext
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body: unknown): Promise<T>
  delete(path: string): Promise<void>
}

export interface SeedResult {
  runId: string
  classId: string
  className: string
  studentIds: string[]
  studentNames: string[]
  guardianIds: string[]
}

interface IdOut {
  id: string
}

/** 非 2xx 一律 throw，訊息帶 method / path / status / body，方便從報告看出哪一步失敗 */
async function unwrap<T>(method: string, path: string, response: APIResponse): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${method} ${path} → ${response.status()}：${await response.text()}`)
  }
  if (response.status() === 204) return undefined as T
  return (await response.json()) as T
}

/** 以 storageState 的 cookie 進後台首頁；路由守衛把人導回登入頁（cookie 失效、帳號停用）時立即失敗 */
export async function loginAsAdmin(page: Page): Promise<void> {
  const state = readStorageState()
  await page.context().addCookies(state.cookies)
  await page.goto('/#/')
  // 路由 afterEach 設好標題（「<頁名> - 安親班管理系統」）才代表守衛已決定落點
  await expect.poll(() => page.title()).toContain(' - ')
  if (new URL(page.url()).hash.startsWith('#/login')) {
    throw new Error('登入失敗：storageState 的登入狀態無效（帳號停用或 token 過期）')
  }
}

/** 呼叫後台 API 的小包裝：每個請求帶 storageState 的員工 cookie（不送帳密） */
export async function adminApi(request: APIRequestContext): Promise<AdminApi> {
  const headers = { Cookie: readStorageState().cookies.map((c) => `${c.name}=${c.value}`).join('; ') }
  return {
    request,
    get: async <T>(path: string) => unwrap<T>('GET', path, await request.get(path, { headers })),
    post: async <T>(path: string, body?: unknown) =>
      unwrap<T>('POST', path, await request.post(path, body === undefined ? { headers } : { headers, data: body })),
    patch: async <T>(path: string, body: unknown) =>
      unwrap<T>('PATCH', path, await request.patch(path, { headers, data: body })),
    delete: async (path: string) => unwrap<void>('DELETE', path, await request.delete(path, { headers })),
  }
}

export function currentAcademicYear(now: Date = new Date()): number {
  const taipei = new Date(now.getTime() + TAIPEI_OFFSET_MS)
  const year = taipei.getUTCFullYear()
  return taipei.getUTCMonth() + 1 >= ACADEMIC_YEAR_START_MONTH ? year - 1911 : year - 1912
}

export async function seedBasic(api: AdminApi, opts: { students?: number } = {}): Promise<SeedResult> {
  const count = opts.students ?? 1
  const runId = Date.now().toString(36)
  const className = `E2E班-${runId}`
  const klass = await api.post<IdOut>('/api/admin/classes', {
    name: className,
    grade_levels: [E2E_GRADE_LEVEL],
    academic_year: currentAcademicYear(),
  })
  const seed: SeedResult = { runId, classId: klass.id, className, studentIds: [], studentNames: [], guardianIds: [] }
  for (let n = 1; n <= count; n += 1) {
    const name = `E2E生${n}-${runId}`
    const student = await api.post<IdOut>('/api/admin/students', {
      student_no: `E2E${runId}${n}`,
      name,
      grade_level: E2E_GRADE_LEVEL,
      class_id: klass.id,
    })
    seed.studentIds.push(student.id)
    seed.studentNames.push(name)
    const guardian = await api.post<IdOut>(`/api/admin/students/${student.id}/guardians`, {
      name: `E2E家長${n}-${runId}`,
      relation: 'mother',
      phone: '0912-000-123',
      is_primary: true,
      can_pickup: true,
      receives_notifications: true,
    })
    seed.guardianIds.push(guardian.id)
  }
  return seed
}

/** 依序封存監護人、學生、班級；任何一步失敗只記 log，不讓 afterAll 蓋掉測試本身的結果 */
export async function cleanup(api: AdminApi, seed: SeedResult): Promise<void> {
  for (const id of seed.guardianIds) {
    try {
      await api.delete(`/api/admin/guardians/${id}`)
    } catch (err) {
      console.warn(`[e2e cleanup] 封存監護人 ${id} 失敗：${String(err)}`)
    }
  }
  for (const id of seed.studentIds) {
    try {
      await api.post(`/api/admin/students/${id}/archive`)
    } catch (err) {
      console.warn(`[e2e cleanup] 封存學生 ${id} 失敗：${String(err)}`)
    }
  }
  try {
    await api.post(`/api/admin/classes/${seed.classId}/archive`)
  } catch (err) {
    console.warn(`[e2e cleanup] 封存班級 ${seed.classId} 失敗：${String(err)}`)
  }
}
