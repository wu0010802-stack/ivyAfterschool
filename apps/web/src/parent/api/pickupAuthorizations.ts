// PARENT-092：家長端代理接送授權 api client（BACKEND-447 / 448 / 449 / 524）。
// 型別逐欄對照 apps/api/app/schemas/pickup.py 的 PickupAuthorizationOut / PickupAuthorizationCreatedOut；
// 移植 ivy FE:src/parent/api/pickup.ts::regeneratePickupCode / cancelPickupAuthorization，
// 建立改為 JSON body、一筆授權一位學生（去掉 ivy 一次多孩 FormData）。
// 回傳的 6 位接送碼只交給呼叫端：本模組不快取、不記錄。
import type {
  AuthorizationEffectiveStatus,
  AuthorizationStatus,
  ISODate,
  ISODateTime,
  VerificationMethod,
} from '@/shared/types/api'
import { parentHttp } from './http'

export interface ParentAuthorization {
  id: string
  student_id: string
  service_date: ISODate
  /** 指定常用接送人時有值；臨時代理為 null */
  pickup_person_id: string | null
  proxy_name: string
  proxy_phone: string
  code_last4: string
  status: AuthorizationStatus
  /** active 且 service_date 已過 → expired */
  effective_status: AuthorizationEffectiveStatus
  verified_at: ISODateTime | null
  verification_method: VerificationMethod | null
  created_at: ISODateTime
}

/** 建立 / 重新產生接送碼的回應；code 為 6 位明碼，只回這一次 */
export interface AuthorizationWithCode {
  authorization: ParentAuthorization
  code: string
}

/** 恰好一種模式：指定常用接送人，或臨時代理（proxy_name 與 proxy_phone 皆必填） */
export type AuthorizationCreateInput =
  | { service_date: ISODate; pickup_person_id: string }
  | { service_date: ISODate; proxy_name: string; proxy_phone: string }

const childAuthorizationsPath = (childId: string) =>
  `/parent/children/${encodeURIComponent(childId)}/pickup-authorizations`
const authorizationPath = (id: string) => `/parent/pickup-authorizations/${encodeURIComponent(id)}`

/** 近 30 天起的授權（含已完成 / 取消 / 過期） */
export async function listPickupAuthorizations(childId: string): Promise<ParentAuthorization[]> {
  const res = await parentHttp.get<ParentAuthorization[]>(childAuthorizationsPath(childId))
  return res.data
}

/** 201；409 `authorization_limit_reached` 為同日授權已達上限 */
export async function createPickupAuthorization(
  childId: string,
  input: AuthorizationCreateInput,
): Promise<AuthorizationWithCode> {
  const res = await parentHttp.post<AuthorizationWithCode>(childAuthorizationsPath(childId), input)
  return res.data
}

/** 無 body；409 `authorization_not_active`；他人的 / 不存在同一 404 */
export async function cancelPickupAuthorization(id: string): Promise<ParentAuthorization> {
  const res = await parentHttp.post<ParentAuthorization>(`${authorizationPath(id)}/cancel`)
  return res.data
}

/** 無 body；新碼只回一次、舊碼立即失效；409 `authorization_not_active` / `authorization_expired` */
export async function regeneratePickupCode(id: string): Promise<AuthorizationWithCode> {
  const res = await parentHttp.post<AuthorizationWithCode>(`${authorizationPath(id)}/regenerate-code`)
  return res.data
}
