// FRONTEND-290：e2e 前後置唯一的 owner 連線用途——依 username 啟用 / 停用 e2e 專用 admin。
// 理由：共用本機 DB 的整合測試要求「沒有其他啟用中的員工」，e2e.admin 只能在 run 期間啟用；停用帳號無法登入、
// 也就無法經 API 自行啟用，所以只有這一步以 owner（compose 的 postgres）執行。其他種子資料一律經 API（app_backend）。
// 只改 is_active（停用時 token_version + 1，同後台停用：既有 token 全部失效），不刪列、不碰 audit_logs。
// 經 docker compose exec 執行 psql，只連 compose.yaml 的本機 DB；username 以 psql 變數帶入（:'u'），不拼 SQL。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const COMPOSE_FILE = fileURLToPath(new URL('../../../../compose.yaml', import.meta.url))

const ACTIVATE_SQL = "UPDATE staff_users SET is_active = true WHERE username = :'u' RETURNING id;"
const DEACTIVATE_SQL =
  "UPDATE staff_users SET is_active = false, token_version = token_version + 1 WHERE username = :'u' AND is_active RETURNING id;"
const SELECT_SQL = "SELECT is_active FROM staff_users WHERE username = :'u';"

function psql(sql: string, username: string): string {
  return execFileSync(
    'docker',
    ['compose', '-f', COMPOSE_FILE, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-v', `u=${username}`],
    { input: sql, encoding: 'utf8' },
  ).trim()
}

/** 啟用；帳號不存在時 throw（先以 python -m app.cli create-admin 建立） */
export function activateStaff(username: string): void {
  if (!psql(ACTIVATE_SQL, username)) {
    throw new Error(`找不到員工帳號 ${username}，請先以 python -m app.cli create-admin 建立`)
  }
}

/** 停用（已停用或不存在時不做事） */
export function deactivateStaff(username: string): void {
  psql(DEACTIVATE_SQL, username)
}

/** true / false；帳號不存在回 null */
export function isStaffActive(username: string): boolean | null {
  const out = psql(SELECT_SQL, username)
  return out === '' ? null : out === 't'
}
