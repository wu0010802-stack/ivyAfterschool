// PARENT-190：家長端關鍵流程（LIFF 登入綁定 → 首頁 → 發起接送 → 收到回覆）在真實瀏覽器串得起來。
// 替身見 ./fixtures.ts（LIFF / API / WebSocket 全部攔截，不接真實後端）。
// 執行前先 just up 或 just web（vite dev）；production build 會忽略 LIFF 替身，不可對 vite preview 執行。
import type { Page } from '@playwright/test'
import { CHILD, ID_TOKEN, NOW, TODAY, apiError, expect, pickupRequest, test, type ParentApi } from './fixtures'

const HOME = /\/parent\/#\/$/
const BIND = /\/parent\/#\/bind(\?.*)?$/
const PICKUP = /\/parent\/#\/pickup$/

/** 今日狀態卡（PARENT-053）與接送頁的請求卡 */
const todayCard = (page: Page) => page.getByRole('region', { name: '今日狀態' })
const requestCard = (page: Page) => page.locator('.pk-req')

async function startLoggedIn(page: Page, api: ParentApi): Promise<void> {
  api.authed = true
  await page.goto('/parent/#/')
  await expect(page).toHaveURL(HOME)
  await expect(todayCard(page)).toContainText('作業進度 1/3')
}

/** 首頁「我要來接」→ 接送頁選「不指定」送出，回 pending 與自動回覆 */
async function requestPickup(page: Page, api: ParentApi): Promise<void> {
  api.createReply = () => ({
    status: 201,
    body: pickupRequest('r1', { reply_ready_eta: '17:30', reply_message: '預計 17:30 可接送', reply_source: 'auto', replied_at: NOW.toISOString() }),
  })
  await startLoggedIn(page, api)

  await todayCard(page).getByRole('button', { name: '我要來接' }).click()
  await expect(page).toHaveURL(PICKUP)
  await page.getByRole('button', { name: '不指定' }).click()
  await page.getByRole('button', { name: '通知安親班' }).click()

  await expect(requestCard(page)).toContainText('預計 17:30 可接送')
  await expect(page.getByRole('button', { name: '我到了' })).toBeVisible()
  expect(api.callsTo('POST', '/parent/pickup/requests').map((c) => c.body)).toEqual([{ student_id: CHILD.id }])
}

test.afterEach(({ api }) => {
  expect(api.unexpected, '替身沒有處理的 API 請求').toEqual([])
})

test('parent flow first bind lands on home', async ({ page, api }) => {
  await page.goto('/parent/#/')

  await expect(page).toHaveURL(BIND)
  await expect(page.getByText('您好，王媽媽')).toBeVisible()
  expect(api.callsTo('POST', '/parent/auth/liff-login').map((c) => c.body)).toEqual([{ id_token: ID_TOKEN }])
  expect((await api.liffCalls()).login).toEqual([])

  await page.getByRole('textbox', { name: '綁定碼' }).fill('abcd2345')
  await page.getByRole('button', { name: '綁定', exact: true }).click()

  await expect(page).toHaveURL(HOME)
  expect(api.callsTo('POST', '/parent/auth/bind').map((c) => c.body)).toEqual([{ code: 'ABCD2345' }])
  await expect(page.getByText(CHILD.name, { exact: true })).toBeVisible()
  await expect(todayCard(page)).toContainText('作業進度 1/3')
})

test('parent flow bind expired code shows guidance', async ({ page, api }) => {
  api.bindReply = apiError(400, 'binding_code_expired', '綁定碼已過期')
  await page.goto('/parent/#/')
  await expect(page).toHaveURL(BIND)

  await page.getByRole('textbox', { name: '綁定碼' }).fill('abcd2345')
  await page.getByRole('button', { name: '綁定', exact: true }).click()

  const notice = page.getByRole('alert')
  await expect(notice).toContainText('綁定碼已過期')
  await expect(notice).toContainText('請向安親班索取新的綁定碼')
  await expect(page).toHaveURL(BIND)
  expect(api.authed).toBe(false)
})

test('parent flow request pickup shows auto reply', async ({ page, api }) => {
  await requestPickup(page, api)

  expect(api.callsTo('POST', '/parent/auth/liff-login')).toEqual([])
})

test('parent flow receives staff reply via websocket', async ({ page, api }) => {
  await requestPickup(page, api)
  // 頁面若重新整理，這個標記會消失
  await page.evaluate(() => Object.assign(globalThis, { __E2E_NO_RELOAD__: true }))
  const todayLoads = api.callsTo('GET', '/parent/pickup/requests/today').length

  await api.push(
    'pickup.request_updated',
    pickupRequest('r1', {
      student_id: CHILD.id,
      service_date: TODAY,
      status: 'acknowledged',
      reply_ready_eta: '17:45',
      reply_message: '數學訂正完就可以接',
      reply_source: 'staff',
      replied_at: NOW.toISOString(),
      can_cancel: true,
      can_mark_arrived: true,
    }),
  )

  await expect(requestCard(page)).toContainText('預計 17:45 可接送')
  await expect(requestCard(page)).toContainText('數學訂正完就可以接')
  expect(await page.evaluate(() => (globalThis as unknown as { __E2E_NO_RELOAD__?: boolean }).__E2E_NO_RELOAD__)).toBe(true)
  expect(api.callsTo('GET', '/parent/pickup/requests/today')).toHaveLength(todayLoads)
})

test('parent flow arrive now from home', async ({ page, api }) => {
  api.createReply = () => ({
    status: 201,
    body: pickupRequest('r2', {
      status: 'arrived',
      reply_message: '作業已完成，可以接送',
      reply_source: 'auto',
      replied_at: NOW.toISOString(),
      arrived_at: NOW.toISOString(),
      can_mark_arrived: false,
    }),
  })
  await startLoggedIn(page, api)

  await todayCard(page).getByRole('button', { name: '我已經到了' }).click()
  const dialog = page.getByRole('alertdialog', { name: '確認已抵達安親班？' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '我到了' }).click()

  await expect(todayCard(page)).toContainText('作業已完成，可以接送')
  await expect(todayCard(page).getByRole('button', { name: '我已經到了' })).toHaveCount(0)
  expect(api.callsTo('POST', '/parent/pickup/requests').map((c) => c.body)).toEqual([{ student_id: CHILD.id, arrived: true }])
  await expect(page).toHaveURL(HOME)
})
