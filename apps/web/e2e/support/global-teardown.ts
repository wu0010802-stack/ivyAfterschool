// FRONTEND-290 / INFRA-056：run 結束後停用 e2e 專用 admin（token_version + 1，存下的 cookie 全部失效，見 ./ownerDb.ts）
// 並刪除 storageState 檔，共用 DB 不留啟用中的測試帳號、暫存目錄不留登入狀態。
import { rmSync } from 'node:fs'

import { storageStatePath } from './authState'
import { deactivateStaff } from './ownerDb'

export default async function globalTeardown(): Promise<void> {
  const username = process.env.E2E_ADMIN_USERNAME?.trim()
  if (username) deactivateStaff(username)
  rmSync(storageStatePath(), { force: true })
}
