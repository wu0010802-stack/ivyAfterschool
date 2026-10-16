// FRONTEND-290：後台 e2e 支援工具（../support/admin.ts）本身的驗收。接真實後端：
// 執行前 just up（或自行起 API + Web），並以 python -m app.cli create-admin 建立 e2e 專用 admin，
// 帳密放在 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD 環境變數（不 commit）。
// e2e.admin 只在 run 期間啟用：globalSetup 啟用、globalTeardown 停用（共用 DB 的整合測試要求沒有其他啟用員工）。
import { expect, test } from '@playwright/test'

import { resolveBaseUrl } from '../guards/env'
import { adminApi, cleanup, loginAsAdmin, seedBasic } from '../support/admin'
import globalSetup from '../support/global-setup'
import globalTeardown from '../support/global-teardown'
import { isStaffActive } from '../support/ownerDb'

test.describe('e2e support', () => {
  test('e2e support login lands on first allowed page', async ({ page }) => {
    await loginAsAdmin(page)

    expect(page.url()).toMatch(/#\/$/)
    await expect(page).toHaveTitle(/今日儀表板/)
  })

  test('e2e support seeds and cleans up', async ({ request }) => {
    const api = await adminApi(request)
    const seed = await seedBasic(api, { students: 2 })
    try {
      expect(seed.studentIds).toHaveLength(2)
      expect(seed.guardianIds).toHaveLength(2)
      expect(seed.className).toBe(`E2E班-${seed.runId}`)
      expect(seed.studentNames).toEqual([`E2E生1-${seed.runId}`, `E2E生2-${seed.runId}`])

      const before = await api.get<{ total: number }>(`/api/admin/students?class_id=${seed.classId}`)
      expect(before.total).toBe(2)
    } finally {
      await cleanup(api, seed)
    }

    const after = await api.get<{ total: number }>(`/api/admin/students?class_id=${seed.classId}`)
    expect(after.total).toBe(0)
    const guardians = await api.get<unknown[]>(`/api/admin/students/${seed.studentIds[0]}/guardians`)
    expect(guardians).toEqual([])
  })

  test('e2e support teardown deactivates admin', async ({ playwright }) => {
    const username = process.env.E2E_ADMIN_USERNAME!
    expect(isStaffActive(username)).toBe(true)
    try {
      await globalTeardown()
      expect(isStaffActive(username)).toBe(false)
      const request = await playwright.request.newContext({ baseURL: resolveBaseUrl(process.env) })
      try {
        await expect(adminApi(request)).rejects.toThrow(/auth\/login → 401/)
      } finally {
        await request.dispose()
      }
    } finally {
      await globalSetup()
    }
    expect(isStaffActive(username)).toBe(true)
  })

  test('e2e support fails fast without credentials', async ({ page }) => {
    const saved = process.env.E2E_ADMIN_USERNAME
    delete process.env.E2E_ADMIN_USERNAME
    try {
      await expect(loginAsAdmin(page)).rejects.toThrow('缺少 E2E_ADMIN_USERNAME')
    } finally {
      if (saved !== undefined) process.env.E2E_ADMIN_USERNAME = saved
    }
  })
})
