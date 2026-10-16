// FRONTEND-291：登入 → 今日出勤到班 / 離班 / 批次到班（docs/testing_conventions.md §3：少量關鍵流程）。
// 接真實後端，種子資料（2 位學生）由 ../support/admin.ts 經 API 建立、afterAll 清理。
// 測試日不是營業日（closed_days 或週日）時整組 skip（以 GET /api/admin/attendance/daily 的 is_service_day 判斷）。
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { resolveBaseUrl } from '../guards/env'
import { adminApi, cleanup, loginAsAdmin, seedBasic, type AdminApi, type SeedResult } from '../support/admin'

interface DailyAttendance {
  is_service_day: boolean
  items: { student_id: string; status: string }[]
}

let context: APIRequestContext
let api: AdminApi
let seed: SeedResult | null = null
let isServiceDay = false

const card = (page: Page, name: string) => page.locator('.acard').filter({ hasText: name })

async function openBoard(page: Page, s: SeedResult): Promise<void> {
  await loginAsAdmin(page)
  await page.goto(`/#/attendance?class_id=${s.classId}`)
  await expect(card(page, s.studentNames[0])).toBeVisible()
}

test.describe('attendance flow', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async ({ playwright }) => {
    context = await playwright.request.newContext({ baseURL: resolveBaseUrl(process.env) })
    api = await adminApi(context)
    isServiceDay = (await api.get<DailyAttendance>('/api/admin/attendance/daily')).is_service_day
    if (isServiceDay) seed = await seedBasic(api, { students: 2 })
  })

  test.afterAll(async () => {
    if (seed) await cleanup(api, seed)
    await context?.dispose()
  })

  test.beforeEach(() => {
    test.skip(!isServiceDay, '今天不是營業日')
  })

  test('attendance flow check-in persists after reload', async ({ page }) => {
    const s = seed!
    await openBoard(page, s)
    const first = card(page, s.studentNames[0])

    await first.getByRole('button', { name: '到班', exact: true }).click()
    await expect(first).toContainText('已到班')

    await page.reload()
    await expect(first).toContainText('已到班')
    await expect(first).toContainText(/到班 \d{2}:\d{2}/)
  })

  test('attendance flow check-out after check-in', async ({ page }) => {
    const s = seed!
    await openBoard(page, s)
    const first = card(page, s.studentNames[0])

    await first.getByRole('button', { name: '離班', exact: true }).click()
    await expect(first).toContainText('已離班')

    const daily = await api.get<DailyAttendance>(`/api/admin/attendance/daily?class_id=${s.classId}`)
    expect(daily.items.find((r) => r.student_id === s.studentIds[0])?.status).toBe('left')
  })

  test('attendance flow batch check-in', async ({ page }) => {
    const s = seed!
    await openBoard(page, s)
    const second = card(page, s.studentNames[1])

    await page.getByRole('button', { name: '批次到班' }).click()
    await second.click()
    await expect(second).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: '確認到班' }).click()

    await expect(page.getByText('已到班 1 位')).toBeVisible()
    await expect(second).toContainText('已到班')
  })
})
