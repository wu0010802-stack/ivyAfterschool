// FRONTEND-290 / INFRA-056：run 開始前啟用 e2e 專用 admin（見 ./ownerDb.ts），再以 API 登入一次、把 cookie 存成
// storageState（見 ./authState.ts）。globalSetup 不錄 trace，之後的測試不再送帳密。
// 沒設 E2E_ADMIN_USERNAME 時（只跑替身的家長端 e2e）不做事。
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { request } from '@playwright/test'

import { resolveBaseUrl } from '../guards/env'
import { MISSING_CREDENTIALS, storageStatePath } from './authState'
import { activateStaff } from './ownerDb'

const LOGIN_PATH = '/api/admin/auth/login'

export default async function globalSetup(): Promise<void> {
  const username = process.env.E2E_ADMIN_USERNAME?.trim()
  if (!username) return
  const password = process.env.E2E_ADMIN_PASSWORD
  if (!password) throw new Error(MISSING_CREDENTIALS)
  activateStaff(username)

  const baseURL = resolveBaseUrl(process.env)
  // 帶 Web 的 Origin：API 對不安全方法檢查 Origin 是否在 CORS_ORIGINS（BACKEND-019）
  const context = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: new URL(baseURL).origin } })
  try {
    const response = await context.post(LOGIN_PATH, { data: { username, password } })
    if (!response.ok()) {
      // 回應只含錯誤碼與訊息，不含密碼
      throw new Error(`e2e admin 以 API 登入失敗（${response.status()}）：${await response.text()}`)
    }
    const path = storageStatePath()
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    await context.storageState({ path })
  } finally {
    await context.dispose()
  }
}
