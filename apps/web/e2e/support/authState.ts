// INFRA-056：e2e 專用 admin 的登入狀態（storageState）。globalSetup 以 API 登入一次後寫檔，測試只讀檔裡的 cookie，
// 不再碰帳密——trace（CI 重試時錄製、失敗時隨 artifact 上傳）因此不會出現密碼。
// 檔案放在 OS 暫存目錄（不在 playwright-report / test-results / var/log 等上傳路徑底下），globalTeardown 刪除。
// 路徑固定（可用 E2E_STORAGE_STATE 覆寫）：測試中重新呼叫 globalSetup 也寫回同一個檔，teardown 一定刪得到。
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MISSING_CREDENTIALS = '缺少 E2E_ADMIN_USERNAME / E2E_ADMIN_PASSWORD'
/** 員工 access token 的 cookie 名（BACKEND app/core/security/cookies.py） */
export const STAFF_ACCESS_COOKIE = 'staff_access'

export interface StorageCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface StorageState {
  cookies: StorageCookie[]
  origins: unknown[]
}

export function storageStatePath(): string {
  return process.env.E2E_STORAGE_STATE?.trim() || join(tmpdir(), 'afterschool-e2e', 'staff-storage-state.json')
}

/** 讀 globalSetup 存下的登入狀態；沒有檔案（沒設 E2E_ADMIN_* 或 globalSetup 沒跑）時 throw */
export function readStorageState(): StorageState {
  const path = storageStatePath()
  if (!existsSync(path)) throw new Error(`${MISSING_CREDENTIALS}（globalSetup 沒有產生登入狀態：${path}）`)
  return JSON.parse(readFileSync(path, 'utf8')) as StorageState
}
