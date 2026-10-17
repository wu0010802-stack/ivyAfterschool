// FRONTEND-293：建立考試 → 成績輸入（自動儲存）→ 各科平均 → 發布後修改分數選擇是否重新通知。
// 接真實後端，種子 2 位學生（班級對象）由 ../support/admin.ts 經 API 建立；afterAll 先刪考試（已發布先取消發布），再清理學生。
// 考試 id 取自「建立」的 POST 回應，afterAll 另以名稱查詢補刪：建立後網址還沒換頁就失敗時也不留考試列。
// 登入有每 IP 5 分鐘 20 次的限流：整組共用一個以 UI 登入一次的 page（serial），不在每條測試重新登入。
import { expect, test, type APIRequestContext, type BrowserContext, type Locator, type Page } from '@playwright/test'

import { resolveBaseUrl } from '../guards/env'
import { adminApi, cleanup, loginAsAdmin, seedBasic, type AdminApi, type SeedResult } from '../support/admin'

interface ScoreGrid {
  exam: { status: 'draft' | 'published' }
  subjects: { subject_id: string; subject_name: string }[]
  cells: { student_id: string; subject_id: string; score: number | null; is_absent: boolean }[]
}

/** 建立考試時只保留國語、數學（成績格第 0 / 1 欄） */
const KEPT_SUBJECTS = ['國語', '數學']
const CHINESE = 0
const MATH = 1
const ALL_SAVED = '所有變更已儲存'
/** 建立後換到考試頁：dev server 冷快取時首次編譯考試頁可能超過預設 5 秒 */
const DETAIL_NAV_TIMEOUT_MS = 30_000
/** 第一條測試含建立考試與換頁等待，放寬整條測試的逾時 */
const CREATE_TEST_TIMEOUT_MS = 90_000

const TAIPEI_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' })

let context: APIRequestContext
let api: AdminApi
let seed: SeedResult
let browserContext: BrowserContext
let page: Page
let examId = ''

const row = (name: string): Locator => page.locator('.el-table__row').filter({ hasText: name })
const cell = (name: string, col: number): Locator => row(name).locator(`.sg-cell[data-col="${col}"]`)
const scoreInput = (name: string, col: number): Locator => cell(name, col).locator('.score-cell__input input')
const toolbar = (): Locator => page.locator('.grid-toolbar')

async function typeScore(name: string, col: number, value: string): Promise<void> {
  await scoreInput(name, col).fill(value)
  await scoreInput(name, col).press('Enter')
}

/** 後端目前的成績格，排序後的「學生序號:科目:分數 / 缺」 */
async function savedCells(): Promise<string[]> {
  const g = await grid()
  const names = new Map(g.subjects.map((s) => [s.subject_id, s.subject_name]))
  return g.cells
    .filter((c) => c.score !== null || c.is_absent)
    .map((c) => `${seed.studentIds.indexOf(c.student_id)}:${names.get(c.subject_id)}:${c.is_absent ? '缺' : c.score}`)
    .sort()
}

/** 開啟表單欄位 label 的 el-select 並點選項：給 text 時選含該文字的項目，否則選第一個 */
async function pickOption(dialog: Locator, label: string, text?: string): Promise<void> {
  await dialog.locator('.el-form-item').filter({ has: page.getByText(label, { exact: true }) }).locator('.el-select').click()
  const options = page.locator('.el-select-dropdown__item:visible')
  await (text === undefined ? options.first() : options.filter({ hasText: text })).click()
}

async function grid(): Promise<ScoreGrid> {
  return api.get<ScoreGrid>(`/api/admin/exams/${examId}/scores`)
}

const examName = (): string => `E2E 段考-${seed.runId}`

/** 本次建立的考試：POST 回應取得的 id，加上以名稱查到的同名考試（補 id 沒取到的情況） */
async function createdExams(): Promise<{ id: string; status: string }[]> {
  const found = new Map<string, string>()
  const list = await api.get<{ items: { id: string; name: string; status: string }[] }>(
    `/api/admin/exams?q=${encodeURIComponent(examName())}`,
  )
  for (const e of list.items) if (e.name === examName()) found.set(e.id, e.status)
  if (examId && !found.has(examId)) found.set(examId, (await grid()).exam.status)
  return [...found].map(([id, status]) => ({ id, status }))
}

test.describe('exams flow', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async ({ playwright, browser }) => {
    const baseURL = resolveBaseUrl(process.env)
    context = await playwright.request.newContext({ baseURL })
    api = await adminApi(context)
    seed = await seedBasic(api, { students: 2 })
    browserContext = await browser.newContext({ baseURL })
    page = await browserContext.newPage()
    await loginAsAdmin(page)
  })

  test.afterAll(async () => {
    await browserContext?.close()
    if (seed) {
      try {
        for (const exam of await createdExams()) {
          if (exam.status === 'published') await api.post(`/api/admin/exams/${exam.id}/unpublish`)
          await api.delete(`/api/admin/exams/${exam.id}`)
        }
      } catch (err) {
        console.warn(`[e2e cleanup] 刪除考試 ${examName()} 失敗：${String(err)}`)
      }
    }
    if (seed) await cleanup(api, seed)
    await context?.dispose()
  })

  test('exams flow scores autosave and persist', async () => {
    test.setTimeout(CREATE_TEST_TIMEOUT_MS)
    const [first, second] = seed.studentNames
    await page.goto('/#/exams')
    // 沒有考試時空狀態也有一顆「建立考試」，取頁首那顆
    await page.getByRole('button', { name: '建立考試' }).first().click()
    const dialog = page.getByRole('dialog', { name: '建立考試' })
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('例如：第一次段考').fill(examName())
    await pickOption(dialog, '考試類型')
    const datePicker = dialog.getByPlaceholder('選擇日期')
    await datePicker.fill(TAIPEI_DATE.format(new Date()).replaceAll('-', '/'))
    await datePicker.press('Enter')
    await pickOption(dialog, '班級', seed.className)
    const subjectBoxes = dialog.locator('.ef-subject')
    for (const name of await subjectBoxes.locator('.el-checkbox__label').allInnerTexts()) {
      if (!KEPT_SUBJECTS.includes(name.trim())) await subjectBoxes.filter({ hasText: name.trim() }).locator('.el-checkbox').click()
    }
    const createResponse = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/admin/exams',
    )
    await dialog.getByRole('button', { name: '建立', exact: true }).click()
    const created = await createResponse
    expect(created.status()).toBe(201)
    examId = ((await created.json()) as { id: string }).id

    await expect(page).toHaveURL(new RegExp(`#/exams/${examId}\\?tab=scores$`), { timeout: DETAIL_NAV_TIMEOUT_MS })
    await expect(row(first)).toBeVisible()

    await typeScore(first, CHINESE, '95')
    await typeScore(first, MATH, '88')
    await cell(second, CHINESE).locator('.score-cell__absent').click()
    // 自動儲存有 debounce：工具列在變更送出前也可能短暫顯示「所有變更已儲存」，先等後端真的寫入
    await expect.poll(savedCells).toEqual(['0:國語:95', '0:數學:88', '1:國語:缺'])
    await expect(toolbar()).toContainText(ALL_SAVED)

    await page.reload()
    await expect(scoreInput(first, CHINESE)).toHaveValue('95')
    await expect(scoreInput(first, MATH)).toHaveValue('88')
    await expect(cell(second, CHINESE).locator('.score-cell__absent input')).toBeChecked()
  })

  test('exams flow rejects out of range score client side', async () => {
    const second = seed.studentNames[1]
    await typeScore(second, MATH, '101')
    await expect(cell(second, MATH).locator('.score-cell')).toHaveAttribute('title', '需介於 0~100')

    const before = await grid()
    const mathId = before.subjects.find((s) => s.subject_name === '數學')!.subject_id
    const saved = before.cells.find((c) => c.student_id === seed.studentIds[1] && c.subject_id === mathId)
    expect(saved?.score).not.toBe(101)

    await typeScore(second, MATH, '100')
    await expect.poll(savedCells).toEqual(['0:國語:95', '0:數學:88', '1:國語:缺', '1:數學:100'])
    await expect(toolbar()).toContainText(ALL_SAVED)
  })

  test('exams flow summary averages', async () => {
    await page.getByRole('tab', { name: '各科平均' }).click()
    const summary = page.locator('#pane-summary')
    await expect(summary.locator('.el-table__row').filter({ hasText: '國語' })).toContainText('95.0')
    await expect(summary.locator('.el-table__row').filter({ hasText: '數學' })).toContainText('94.0')
  })

  test('exams flow publish then edit asks renotify', async () => {
    const first = seed.studentNames[0]
    await page.getByRole('tab', { name: '成績輸入' }).click()
    await page.getByRole('button', { name: '發布', exact: true }).click()
    await page.getByRole('dialog', { name: '發布成績' }).getByRole('button', { name: '發布', exact: true }).click()
    await expect(page.locator('.exam-meta')).toContainText('已發布')
    // 發布後成績格會重新載入；載入完成（工具列出現通知選擇）才修改，否則修改會被重新載入蓋掉提示
    await expect(toolbar()).toContainText('尚未選擇')

    await typeScore(first, CHINESE, '96')
    const renotify = page.getByRole('dialog').filter({ hasText: '是否在修改後通知家長分數已更新？' })
    await expect(renotify).toBeVisible()
    await renotify.getByRole('button', { name: '不通知' }).click()
    await expect.poll(savedCells).toContain('0:國語:96')
    await expect(toolbar()).toContainText(ALL_SAVED)
  })
})
