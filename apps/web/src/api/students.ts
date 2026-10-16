// FRONTEND-081：學生 api client（BACKEND-159~166、531、533，docs/tasks/api_index.md §6）。
// 移植 ivy FE:src/api/students.ts 的函式分組；去掉 lifecycle、graduate、bulk transfer、bonus impact、
// medical reason 查詢（本專案敏感欄位直接隨詳情回傳給有權限者）。
// 錯誤由 adminHttp 轉成 ApiError：409 學號 / 身分證重複、already_promoted、preview_stale（details {expected_total, total}）、
// import_has_errors、import_conflict、student_not_purgeable / student_already_purged，
// 422 purge_confirmation_mismatch、invalid_dates、import_invalid_header 等。
// 上傳（FormData）的 Content-Type 由 createHttpClient 處理（FRONTEND-294），這裡不設定。
import type { ISODate, ISODateTime, Gender, Page, StudentStatus } from '@/shared/types/api'
import { buildFormData } from '@/shared/http/upload'
import type { AxiosResponse } from 'axios'
import type { Guardian } from './guardians'
import { adminHttp } from './http'

export interface StudentSchoolBrief {
  id: string
  name: string
  short_name: string | null
}

export interface StudentClassBrief {
  id: string
  name: string
}

export interface StudentListItem {
  id: string
  student_no: string
  name: string
  gender: Gender | null
  grade_level: number
  school: StudentSchoolBrief | null
  school_class: string | null
  class: StudentClassBrief | null
  status: StudentStatus
  archived_at: ISODateTime | null
}

export interface StudentSensitive {
  id_number: string | null
  health_note: string | null
}

export interface StudentDetail extends StudentListItem {
  birthday: ISODate | null
  enrolled_on: ISODate | null
  withdrawn_on: ISODate | null
  note: string | null
  /** 短效簽名 URL */
  photo_url: string | null
  has_id_number: boolean
  has_health_note: boolean
  /** 需要 students:sensitive，否則 null */
  sensitive: StudentSensitive | null
  guardians: Guardian[]
}

export interface StudentCreate {
  student_no: string
  name: string
  gender?: Gender | null
  birthday?: ISODate | null
  grade_level: number
  school_id?: string | null
  school_class?: string | null
  class_id?: string | null
  status?: StudentStatus
  enrolled_on?: ISODate | null
  withdrawn_on?: ISODate | null
  note?: string | null
  /** 需要 students:sensitive；更新時給 null = 清除 */
  id_number?: string | null
  /** 需要 students:sensitive；更新時給 null = 清除 */
  health_note?: string | null
}

/** 沒給的欄位不變；可清除的欄位給 null 即清除（body 原樣送出，不過濾 null） */
export type StudentUpdate = Partial<StudentCreate>

export interface StudentListParams {
  q?: string
  class_id?: string
  grade_level?: number
  status?: StudentStatus
  school_id?: string
  include_archived?: boolean
  page?: number
  page_size?: number
}

export interface PromotionItem {
  id: string
  student_no: string
  name: string
  grade_from: number
  /** 六年級畢業（轉退班）為 null */
  grade_to: number | null
  class_name: string | null
}

export interface PromotionPreview {
  from_academic_year: number
  to_academic_year: number
  promote: PromotionItem[]
  graduate: PromotionItem[]
  total: number
  already_promoted: boolean
}

export interface PromotionExecute {
  from_academic_year: number
  /** 預覽當時的 total；名單已變動時後端回 409 preview_stale */
  expected_total: number
  /** 六年級畢業的退班日，預設由後端以今天計 */
  withdrawn_on?: ISODate
}

export interface PromotionResult {
  promoted: number
  graduated: number
}

export interface ImportPreviewRow {
  /** Excel 列號（標題為第 1 列） */
  row_number: number
  /** 原始儲存格字串（敏感欄位已遮罩） */
  display: Record<string, string>
  errors: string[]
}

export interface ImportPreview {
  rows: ImportPreviewRow[]
  total: number
  valid: number
  invalid: number
}

export interface ImportResult {
  created: number
  student_ids: string[]
}

export interface PurgeResult {
  student_id: string
  purged_at: ISODateTime
  anonymized_student_no: string
}

const studentPath = (id: string) => `/admin/students/${encodeURIComponent(id)}`

export async function listStudents(params: StudentListParams = {}): Promise<Page<StudentListItem>> {
  const res = await adminHttp.get<Page<StudentListItem>>('/admin/students', { params })
  return res.data
}

export async function getStudent(id: string): Promise<StudentDetail> {
  const res = await adminHttp.get<StudentDetail>(studentPath(id))
  return res.data
}

export async function createStudent(body: StudentCreate): Promise<StudentDetail> {
  const res = await adminHttp.post<StudentDetail>('/admin/students', body)
  return res.data
}

export async function updateStudent(id: string, body: StudentUpdate): Promise<StudentDetail> {
  const res = await adminHttp.patch<StudentDetail>(studentPath(id), body)
  return res.data
}

export async function archiveStudent(id: string): Promise<StudentDetail> {
  const res = await adminHttp.post<StudentDetail>(`${studentPath(id)}/archive`)
  return res.data
}

export async function uploadStudentPhoto(id: string, file: File): Promise<{ photo_url: string }> {
  const res = await adminHttp.post<{ photo_url: string }>(`${studentPath(id)}/photo`, buildFormData({ file }))
  return res.data
}

/** 學年升級預覽（dry_run，不寫入） */
export async function previewPromotion(fromYear: number): Promise<PromotionPreview> {
  const res = await adminHttp.post<PromotionPreview>('/admin/students/promote-grade', {
    from_academic_year: fromYear,
    dry_run: true,
  })
  return res.data
}

export async function executePromotion(body: PromotionExecute): Promise<PromotionResult> {
  const res = await adminHttp.post<PromotionResult>('/admin/students/promote-grade', { ...body, dry_run: false })
  return res.data
}

/** 永久刪除（匿名化）：需 students:purge，只限已封存且退班的學生；confirmStudentNo 必須等於目前學號 */
export async function purgeStudent(id: string, confirmStudentNo: string): Promise<PurgeResult> {
  const res = await adminHttp.post<PurgeResult>(`${studentPath(id)}/purge`, {
    confirm_student_no: confirmStudentNo,
  })
  return res.data
}

/** 回完整 response，讓呼叫端以 saveBlobResponse 取 Content-Disposition 檔名 */
export function downloadImportTemplate(): Promise<AxiosResponse<Blob>> {
  return adminHttp.get<Blob>('/admin/students/import-template', { responseType: 'blob' })
}

async function postImport<T>(file: File, academicYear: number, dryRun: boolean): Promise<T> {
  const res = await adminHttp.post<T>(
    '/admin/students/import',
    buildFormData({ file, academic_year: academicYear, dry_run: dryRun }),
  )
  return res.data
}

export function previewImport(file: File, academicYear: number): Promise<ImportPreview> {
  return postImport<ImportPreview>(file, academicYear, true)
}

/** 有錯誤列時後端回 409 import_has_errors（details {total, valid, invalid, rows}）；整批不寫入 */
export function executeImport(file: File, academicYear: number): Promise<ImportResult> {
  return postImport<ImportResult>(file, academicYear, false)
}
