// FRONTEND-290：run 開始前啟用 e2e 專用 admin（見 ./ownerDb.ts）。沒設 E2E_ADMIN_USERNAME 時（只跑替身的家長端 e2e）不做事。
import { activateStaff } from './ownerDb'

export default async function globalSetup(): Promise<void> {
  const username = process.env.E2E_ADMIN_USERNAME?.trim()
  if (username) activateStaff(username)
}
