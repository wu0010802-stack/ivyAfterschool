// FRONTEND-290 / INFRA-056：後台 e2e 支援工具（../support/admin.ts、globalSetup / globalTeardown）本身的驗收。接真實後端：
// 執行前 just up（或自行起 API + Web），並以 python -m app.cli create-admin 建立 e2e 專用 admin，
// 帳密放在 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD 環境變數（不 commit）。
// e2e.admin 只在 run 期間啟用：globalSetup 啟用並以 API 登入一次、把 cookie 存成 storageState；globalTeardown 停用並刪檔。
// 其他 spec 一律以 storageState 登入，trace 裡不會出現密碼；會送出密碼的測試（登入表單、teardown 後重新 globalSetup）
// 都在 ./login-form.spec.ts（整檔關閉 trace）。
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { adminApi, cleanup, loginAsAdmin, seedBasic } from '../support/admin'
import { STAFF_ACCESS_COOKIE, storageStatePath, type StorageState } from '../support/authState'

const WEB_DIR = fileURLToPath(new URL('../..', import.meta.url))
const REPO_ROOT = resolve(WEB_DIR, '../..')
/** e2e workflow 失敗時上傳的路徑（.github/workflows/e2e.yml） */
const UPLOADED_DIRS = [resolve(WEB_DIR, 'playwright-report'), resolve(WEB_DIR, 'test-results'), resolve(REPO_ROOT, 'var/log')]
const LOGIN_PATH = '/api/admin/auth/login'

test.describe('e2e support', () => {
  test('e2e support login via storage state', async ({ page }) => {
    const logins: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === LOGIN_PATH) logins.push(r.url())
    })

    await loginAsAdmin(page)

    expect(page.url()).not.toContain('#/login')
    await expect(page).toHaveTitle(/今日儀表板/)
    expect(logins).toEqual([])
  })

  test('e2e support storage state outside uploaded paths', () => {
    const path = resolve(storageStatePath())

    for (const dir of UPLOADED_DIRS) expect(path.startsWith(dir + sep)).toBe(false)
    expect(existsSync(path)).toBe(true)
    const state = JSON.parse(readFileSync(path, 'utf8')) as StorageState
    expect(state.cookies.map((c) => c.name)).toContain(STAFF_ACCESS_COOKIE)
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

  test('e2e support fails fast without credentials', async ({ page, request }) => {
    const saved = process.env.E2E_STORAGE_STATE
    process.env.E2E_STORAGE_STATE = resolve(WEB_DIR, 'e2e/.auth/does-not-exist.json')
    try {
      await expect(loginAsAdmin(page)).rejects.toThrow('缺少 E2E_ADMIN_USERNAME')
      await expect(adminApi(request)).rejects.toThrow('缺少 E2E_ADMIN_USERNAME')
    } finally {
      if (saved === undefined) delete process.env.E2E_STORAGE_STATE
      else process.env.E2E_STORAGE_STATE = saved
    }
  })
})
