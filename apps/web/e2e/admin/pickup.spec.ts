// FRONTEND-292：接送請求（員工代建）→ 員工回覆預計時間並確認 → 完成交付，另一個 context 經 ws 即時看到確認。
// 接真實後端，種子 1 位學生由 ../support/admin.ts 經 API 建立並登記到班、afterAll 清理。
// e2e 只測員工代建流程；家長發起、「我到了」與「我已經到了」捷徑由元件測試與後端整合測試涵蓋。
// 測試日不是營業日時整組 skip（以 GET /api/admin/attendance/daily 的 is_service_day 判斷）。
// 登入有每 IP 5 分鐘 20 次的限流：整組共用一個以 UI 登入一次的 page（serial），不在每條測試重新登入。
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test'

import { resolveBaseUrl } from '../guards/env'
import { adminApi, cleanup, loginAsAdmin, seedBasic, type AdminApi, type SeedResult } from '../support/admin'

interface PickupRequest {
  id: string
  status: string
  reply_source: string | null
}

const MINUTE_MS = 60 * 1000
const EXPECTED_ARRIVAL_MINUTES = 30
const REALTIME_TIMEOUT_MS = 10_000
const REPLY_MESSAGE = '數學訂正中'

let context: APIRequestContext
let api: AdminApi
let seed: SeedResult | null = null
let requestId = ''
let isServiceDay = false
let observerContext: BrowserContext | null = null
let observer: Page | null = null
let staffContext: BrowserContext | null = null
let page: Page

const nowMs = (): number => Date.now()

const TAIPEI_HM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Taipei',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 台北時間「現在 + minutes」的 HH:MM */
function taipeiHm(minutes: number): string {
  return TAIPEI_HM.format(new Date(nowMs() + minutes * MINUTE_MS))
}

const queueCard = (p: Page, name: string) => p.locator('.qcard').filter({ hasText: name })

/** 進入（或重新載入）接送 POS 頁 */
async function openPos(p: Page): Promise<void> {
  if (p.url().endsWith('/#/pickup')) await p.reload()
  else await p.goto('/#/pickup')
  // ws 連上後才操作：連線建立時佇列可能重抓、重繪卡片
  await expect(page.locator('.pos-conn')).toHaveText('即時')
  await expect(queueCard(page, seed!.studentNames[0])).toBeVisible()
}

test.describe('pickup flow', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async ({ playwright, browser }) => {
    const baseURL = resolveBaseUrl(process.env)
    context = await playwright.request.newContext({ baseURL })
    api = await adminApi(context)
    isServiceDay = (await api.get<{ is_service_day: boolean }>('/api/admin/attendance/daily')).is_service_day
    if (!isServiceDay) return
    seed = await seedBasic(api, { students: 1 })
    const studentId = seed.studentIds[0]
    await api.post(`/api/admin/attendance/${studentId}/check-in`, {})
    const created = await api.post<PickupRequest>('/api/admin/pickup/requests', {
      student_id: studentId,
      expected_arrival_at: taipeiHm(EXPECTED_ARRIVAL_MINUTES),
    })
    requestId = created.id
    staffContext = await browser.newContext({ baseURL })
    page = await staffContext.newPage()
    await loginAsAdmin(page)
  })

  test.afterAll(async () => {
    await observerContext?.close()
    await staffContext?.close()
    if (seed) await cleanup(api, seed)
    await context?.dispose()
  })

  test.beforeEach(() => {
    test.skip(!isServiceDay, '今天不是營業日')
  })

  test('pickup flow staff created request appears in queue', async () => {
    await openPos(page)
    const card = queueCard(page, seed!.studentNames[0])

    await expect(card).toContainText('員工代建')
    await expect(card).toContainText('等待確認')
  })

  test('pickup flow reply and acknowledge', async ({ browser }) => {
    const name = seed!.studentNames[0]
    // 第二個 context 在回覆前就開著 /#/pickup，之後不重新整理（下一條測試檢查 ws 即時更新）
    observerContext = await browser.newContext({ baseURL: resolveBaseUrl(process.env) })
    observer = await observerContext.newPage()
    await loginAsAdmin(observer)
    await openPos(observer)
    await expect(queueCard(observer, name)).toContainText('等待確認')
    await observer.evaluate(() => {
      ;(globalThis as unknown as { __e2eNoReload?: boolean }).__e2eNoReload = true
    })

    await openPos(page)
    const card = queueCard(page, name)
    await card.getByRole('button', { name: '回覆時間' }).click()
    const dialog = page.getByRole('dialog', { name: /回覆預計可接送時間/ })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '+20 分' }).click()
    await dialog.locator('textarea').fill(REPLY_MESSAGE)
    await expect(dialog.getByRole('checkbox', { name: '同時確認此請求' })).toBeChecked()
    await dialog.getByRole('button', { name: '回覆並確認' }).click()

    await expect(card).toContainText('已確認')
    await expect(card).toContainText(REPLY_MESSAGE)
    const queue = await api.get<{ open: PickupRequest[] }>('/api/admin/pickup/queue')
    const request = queue.open.find((r) => r.id === requestId)
    expect(request?.reply_source).toBe('staff')
    expect(request?.status).toBe('acknowledged')
  })

  test('pickup flow realtime update in second context', async () => {
    const page = observer!
    await expect(queueCard(page, seed!.studentNames[0])).toContainText('已確認', { timeout: REALTIME_TIMEOUT_MS })
    // 期間沒有重新整理：回覆前設下的標記仍在
    expect(await page.evaluate(() => (globalThis as unknown as { __e2eNoReload?: boolean }).__e2eNoReload)).toBe(true)
  })

  test('pickup flow complete with guardian', async () => {
    const s = seed!
    const name = s.studentNames[0]
    await openPos(page)

    await queueCard(page, name).getByRole('button', { name: '完成交付' }).click()
    const dialog = page.getByRole('dialog', { name: /完成交付：/ })
    await expect(dialog).toBeVisible()
    await dialog.getByText(`E2E家長1-${s.runId}`).click()
    await dialog.getByRole('button', { name: '完成交付' }).click()
    await expect(dialog).toBeHidden()

    await page.getByRole('button', { name: /今日已結束/ }).click()
    const closed = page.locator('[data-test="queue-closed"]')
    await expect(closed).toContainText(name)
    await expect(closed.locator('.qcard').filter({ hasText: name })).toContainText('監護人接送')
    await expect(page.locator('.scard').filter({ hasText: name })).toContainText('已離班')
  })
})
