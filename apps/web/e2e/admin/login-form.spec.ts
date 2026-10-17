// FRONTEND-290 / INFRA-056：會送出 e2e admin 密碼的 e2e 都在本檔——走後台登入表單（密碼成為 fill 的 action 參數），
// 以及 teardown 後重新 globalSetup（以 API 登入，request body 含密碼）。所以整檔關閉 trace（trace 是 worker 層級選項，
// 只能在檔案頂層或設定檔 test.use）。其他 spec 以 storageState 登入，見 ../support/authState.ts。
import { existsSync, readFileSync } from 'node:fs'

import { expect, test, type Page } from '@playwright/test'

import { storageStatePath, type StorageState } from '../support/authState'
import globalSetup from '../support/global-setup'
import globalTeardown from '../support/global-teardown'
import { isStaffActive } from '../support/ownerDb'

test.use({ trace: 'off' })

/** 走登入表單（帳密讀 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD） */
async function loginViaForm(page: Page): Promise<void> {
  const username = process.env.E2E_ADMIN_USERNAME
  const password = process.env.E2E_ADMIN_PASSWORD
  if (!username || !password) throw new Error('缺少 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD')
  await page.goto('/#/login')
  await page.getByPlaceholder('請輸入帳號').fill(username)
  await page.getByPlaceholder('請輸入密碼').fill(password)
  await page.getByRole('button', { name: '登入' }).click()
  await page.waitForURL((url) => !url.hash.startsWith('#/login'))
}

function cookieHeader(state: StorageState): string {
  return state.cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

test.describe('e2e support credentials', () => {
  test('e2e support login lands on first allowed page', async ({ page }) => {
    await loginViaForm(page)

    expect(page.url()).toMatch(/#\/$/)
    await expect(page).toHaveTitle(/今日儀表板/)
  })

  test('e2e support teardown deactivates admin', async ({ request }) => {
    const username = process.env.E2E_ADMIN_USERNAME!
    const path = storageStatePath()
    const before = JSON.parse(readFileSync(path, 'utf8')) as StorageState
    expect(isStaffActive(username)).toBe(true)
    try {
      await globalTeardown()
      expect(isStaffActive(username)).toBe(false)
      expect(existsSync(path)).toBe(false)
      // 停用時 token_version + 1：先前存下的 cookie 立即失效
      const me = await request.get('/api/admin/auth/me', { headers: { Cookie: cookieHeader(before) } })
      expect(me.status()).toBe(401)
    } finally {
      await globalSetup()
    }
    expect(isStaffActive(username)).toBe(true)
    expect(existsSync(path)).toBe(true)
  })
})
