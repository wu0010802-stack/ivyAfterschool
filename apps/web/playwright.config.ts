// INFRA-014：Playwright e2e 設定。只跑本機全套（服務由 just up 啟動，這裡不設 webServer），
// 預設不執行，透過 just e2e <spec> 指定檔案執行。首次使用先 pnpm exec playwright install chromium。
import { defineConfig, devices } from '@playwright/test'

import { resolveBaseUrl } from './e2e/guards/env'

// 載入即驗證：E2E_BASE_URL 不是本機時這裡直接 throw，連測試清單都列不出來
const baseURL = resolveBaseUrl(process.env)

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  // FRONTEND-290：e2e 專用 admin 只在 run 期間啟用（有設 E2E_ADMIN_USERNAME 時）
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  retries: process.env.CI ? 1 : 0,
  // 後台 e2e 共用本機 DB、同一個 e2e.admin 與每 IP 的登入限流，且 support.spec 會停用 / 重新啟用 e2e.admin：
  // 檔案之間不可平行（FRONTEND-290）
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  // testMatch 只收 *.spec.ts：同目錄的共用 helper（例如 e2e/parent/fixtures.ts）不可被當成測試檔載入
  projects: [
    {
      // 後台：桌面 Chrome
      name: 'admin-chromium',
      testMatch: ['e2e/admin/**/*.spec.ts', 'e2e/smoke.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // 家長端（LIFF）：手機尺寸
      name: 'parent-mobile',
      testMatch: ['e2e/parent/**/*.spec.ts'],
      use: { ...devices['Pixel 7'] },
    },
  ],
})
