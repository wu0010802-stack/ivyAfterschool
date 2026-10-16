// FRONTEND-290：後台 e2e 共用工具（FRONTEND-291~293）。接真實後端（本機 just up），種子資料一律經 API 建立：
// - loginAsAdmin：走 UI 登入（/#/login），帳密讀 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD。
// - adminApi：以 API 登入，cookie 留在傳入的 APIRequestContext，之後的呼叫都帶員工 cookie。
// - seedBasic / cleanup：建立「E2E班-{runId}」與學生、監護人；結束後依序封存監護人、學生、班級（失敗只記 log）。
// 型別在這裡自行宣告最小欄位（e2e 走 tsconfig.node，不引用 src 的 @/ 路徑）。
import type { APIRequestContext, APIResponse, Page } from '@playwright/test'

const MISSING_CREDENTIALS = '缺少 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD'
const LOGIN_PATH = '/api/admin/auth/login'
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

function credentials(): { username: string; password: string } {
  const username = process.env.E2E_ADMIN_USERNAME?.trim()
  const password = process.env.E2E_ADMIN_PASSWORD
  if (!username || !password) throw new Error(MISSING_CREDENTIALS)
  return { username, password }
}

/** 非 2xx 一律 throw，訊息帶 method / path / status / body，方便從報告看出哪一步失敗 */
async function unwrap<T>(method: string, path: string, response: APIResponse): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${method} ${path} → ${response.status()}：${await response.text()}`)
  }
  if (response.status() === 204) return undefined as T
  return (await response.json()) as T
}

export async function loginAsAdmin(page: Page): Promise<void> {
  const { username, password } = credentials()
  await page.goto('/#/login')
  await page.getByPlaceholder('請輸入帳號').fill(username)
  await page.getByPlaceholder('請輸入密碼').fill(password)
  await page.getByRole('button', { name: '登入' }).click()
  // 登入失敗（帳密錯、限流 429）時登入頁顯示 alert：立即以其文字失敗，不等到測試逾時
  const alert = page.getByRole('alert')
  await Promise.race([
    page.waitForURL((url) => !url.hash.startsWith('#/login')),
    alert.waitFor().then(async () => {
      throw new Error(`登入失敗：${await alert.innerText()}`)
    }),
  ])
}

export async function adminApi(request: APIRequestContext): Promise<AdminApi> {
  await unwrap('POST', LOGIN_PATH, await request.post(LOGIN_PATH, { data: credentials() }))
  return {
    request,
    get: async <T>(path: string) => unwrap<T>('GET', path, await request.get(path)),
    post: async <T>(path: string, body?: unknown) =>
      unwrap<T>('POST', path, await request.post(path, body === undefined ? {} : { data: body })),
    patch: async <T>(path: string, body: unknown) => unwrap<T>('PATCH', path, await request.patch(path, { data: body })),
    delete: async (path: string) => unwrap<void>('DELETE', path, await request.delete(path)),
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
