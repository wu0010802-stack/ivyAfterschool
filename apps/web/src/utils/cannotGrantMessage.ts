// FRONTEND-310：403 cannot_grant_permissions 的錯誤訊息（角色編輯 / 新增角色 / 員工帳號表單共用）。
// details.permissions（只取字串）→ 中文名稱以「、」串接，查不到名稱時用代碼；沒有清單時用後端訊息。
import { isApiError } from '@/shared/types/api'
import { errorMessage } from '@/shared/utils/errorMessage'

export function cannotGrantMessage(err: unknown, labels: ReadonlyMap<string, string>): string {
  const details = isApiError(err) ? (err.details as { permissions?: unknown } | null) : null
  const codes = Array.isArray(details?.permissions)
    ? details.permissions.filter((c): c is string => typeof c === 'string')
    : []
  if (!codes.length) return errorMessage(err, '你沒有部分權限，無法授出')
  return `你沒有以下權限，無法授出：${codes.map((c) => labels.get(c) ?? c).join('、')}`
}
