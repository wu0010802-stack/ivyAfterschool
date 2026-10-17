// FRONTEND-181：代理接送授權清單與核驗 api client（BACKEND-436~439，docs/tasks/api_index.md §10）。
// 移植 ivy FE:src/api/pickupAuthorizations.ts 的 list / verify / override / confirmVisualMatch 分組，改為本專案路徑。
// 錯誤由 adminHttp 轉成 ApiError：400 pickup_code_mismatch（details.remaining_attempts）、
// 409 pickup_code_locked / authorization_not_active / authorization_not_today / invalid_pickup_status、
// 403 permission_denied（override-complete 缺 pickup:override）、404 授權不存在。
import type {
  AuthorizationEffectiveStatus,
  AuthorizationStatus,
  ISODate,
  ISODateTime,
  VerificationMethod,
} from '@/shared/types/api'
import { adminHttp } from './http'
import type { PickupRequest, PickupStudent } from './pickupRequests'
import { encodePathSegment } from '@/shared/utils/pathSegment'

export interface StaffAuthorization {
  id: string
  student: PickupStudent
  student_id: string
  service_date: ISODate
  /** 常用接送人；臨時代理人為 null */
  pickup_person_id: string | null
  proxy_name: string
  proxy_phone: string
  /** 接送碼末四碼（後端不保存明碼） */
  code_last4: string
  status: AuthorizationStatus
  /** 過期日的 active 顯示 expired */
  effective_status: AuthorizationEffectiveStatus
  verified_at: ISODateTime | null
  verification_method: VerificationMethod | null
  created_at: ISODateTime
  /** 常用接送人照片的短效 URL，協助目視比對；沒有照片為 null */
  photo_url: string | null
  /** 已錯碼次數 */
  code_attempts: number
  /** 連錯達上限後鎖定，只能由 pickup:override 強制完成 */
  locked: boolean
  verified_by_name: string | null
}

export interface VerifyResult {
  authorization: StaffAuthorization
  request: PickupRequest
}

export interface PickupAuthorizationListParams {
  /** 預設今天 */
  date?: ISODate
  status?: AuthorizationStatus
}

/** 400 pickup_code_mismatch 的 details */
export interface CodeMismatchDetails {
  remaining_attempts: number
}

const authorizationPath = (id: string) => `/admin/pickup/authorizations/${encodePathSegment(id)}`

export async function listPickupAuthorizations(
  params: PickupAuthorizationListParams = {},
): Promise<StaffAuthorization[]> {
  const res = await adminHttp.get<StaffAuthorization[]>('/admin/pickup/authorizations', { params })
  return res.data
}

/** 送出前去除空白與 `-`（家長端顯示的接送碼會分段） */
export async function verifyPickupCode(id: string, code: string): Promise<VerifyResult> {
  const res = await adminHttp.post<VerifyResult>(`${authorizationPath(id)}/verify`, {
    code: code.replace(/[\s-]/g, ''),
  })
  return res.data
}

/** 目視核對後確認；沒有 note 送 {} */
export async function confirmVisualMatch(id: string, note?: string): Promise<VerifyResult> {
  const res = await adminHttp.post<VerifyResult>(
    `${authorizationPath(id)}/confirm-visual-match`,
    note?.trim() ? { note } : {},
  )
  return res.data
}

/** 主管強制完成（需 pickup:override，可處理已鎖定的授權）；note 必填並寫入稽核紀錄 */
export async function overrideCompleteAuthorization(id: string, note: string): Promise<VerifyResult> {
  const res = await adminHttp.post<VerifyResult>(`${authorizationPath(id)}/override-complete`, { note })
  return res.data
}
