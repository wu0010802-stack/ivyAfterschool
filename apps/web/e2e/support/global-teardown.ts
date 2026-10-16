// FRONTEND-290：run 結束後停用 e2e 專用 admin，共用 DB 不留啟用中的測試帳號（見 ./ownerDb.ts）。
import { deactivateStaff } from './ownerDb'

export default async function globalTeardown(): Promise<void> {
  const username = process.env.E2E_ADMIN_USERNAME?.trim()
  if (username) deactivateStaff(username)
}
