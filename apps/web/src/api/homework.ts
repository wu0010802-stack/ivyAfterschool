// FRONTEND-150：作業進度 api client（BACKEND-385~390，docs/tasks/api_index.md §9）。
// 錯誤由 adminHttp 轉成 ApiError：422 invalid_service_date（超出 homework.window）/ student_not_in_class / no_students。
// 新增 / 修改 / 刪除項目與整體進度都會回最新的 Progress，呼叫端不需要重抓看板。
import type {
  AttendanceStatus,
  HHMM,
  HomeworkItemStatus,
  HomeworkOverallStatus,
  ISODate,
  ISODateTime,
} from '@/shared/types/api'
import { adminHttp } from './http'
import { encodePathSegment } from '@/shared/utils/pathSegment'

export interface HomeworkItem {
  id: string
  student_id: string
  service_date: ISODate
  subject_id: string | null
  subject_name: string | null
  title: string
  status: HomeworkItemStatus
  sort_order: number
  updated_at: ISODateTime
}

export interface Progress {
  student_id: string
  service_date: ISODate
  overall_status: HomeworkOverallStatus
  /** 台北當地時間 */
  ready_eta: HHMM | null
  note: string | null
  eta_updated_at: ISODateTime | null
  eta_updated_by_name: string | null
}

export interface BoardStudent {
  student_id: string
  student_no: string
  name: string
  class_id: string | null
  class_name: string | null
  attendance_status: AttendanceStatus | null
  items: HomeworkItem[]
  progress: Progress
}

export interface BoardSummary {
  total: number
  done: number
  in_progress: number
  not_started: number
}

/** 可登記的日期範圍（設定 homework.window：今天往前 past_days、往後 future_days） */
export interface HomeworkWindow {
  past_days: number
  future_days: number
}

export interface HomeworkBoard {
  date: ISODate
  window: HomeworkWindow
  summary: BoardSummary
  students: BoardStudent[]
}

export interface HomeworkBoardParams {
  /** 預設今天 */
  date?: ISODate
  class_id?: string
}

export interface HomeworkItemCreate {
  student_id: string
  /** 預設今天 */
  service_date?: ISODate
  subject_id?: string
  title: string
  /** 預設 todo */
  status?: HomeworkItemStatus
  sort_order?: number
}

export interface HomeworkBatchCreate {
  class_id: string
  service_date?: ISODate
  subject_id?: string
  title: string
  /** 不給 = 整班；給值時必須屬於該班（否則 422 student_not_in_class） */
  student_ids?: string[]
}

export interface HomeworkItemUpdate {
  title?: string
  /** null = 清除科目 */
  subject_id?: string | null
  status?: HomeworkItemStatus
  sort_order?: number
}

/** 新增 / 修改項目：回最新的項目與該生當日整體進度 */
export interface HomeworkItemResult {
  item: HomeworkItem
  progress: Progress
}

/** 刪除項目：item 固定為 null */
export interface HomeworkDeleteResult {
  item: null
  progress: Progress
}

export interface HomeworkBatchResult {
  created: number
  items: HomeworkItem[]
}

/** overall：done = 員工直接標整體完成，auto = 改回由項目推導；ready_eta / note 給 null = 清除，不給 = 不變 */
export interface HomeworkProgressUpdate {
  service_date?: ISODate
  overall?: 'done' | 'auto'
  ready_eta?: HHMM | null
  note?: string | null
}

const itemPath = (id: string) => `/admin/homework/items/${encodePathSegment(id)}`

export async function fetchHomeworkBoard(params: HomeworkBoardParams = {}): Promise<HomeworkBoard> {
  const res = await adminHttp.get<HomeworkBoard>('/admin/homework/board', { params })
  return res.data
}

export async function createHomeworkItem(body: HomeworkItemCreate): Promise<HomeworkItemResult> {
  const res = await adminHttp.post<HomeworkItemResult>('/admin/homework/items', body)
  return res.data
}

export async function batchCreateHomeworkItems(body: HomeworkBatchCreate): Promise<HomeworkBatchResult> {
  const res = await adminHttp.post<HomeworkBatchResult>('/admin/homework/items/batch', body)
  return res.data
}

export async function updateHomeworkItem(id: string, body: HomeworkItemUpdate): Promise<HomeworkItemResult> {
  const res = await adminHttp.patch<HomeworkItemResult>(itemPath(id), body)
  return res.data
}

/** 後端回 200 與 {item: null, progress}（不是 204） */
export async function deleteHomeworkItem(id: string): Promise<HomeworkDeleteResult> {
  const res = await adminHttp.delete<HomeworkDeleteResult>(itemPath(id))
  return res.data
}

export async function updateHomeworkProgress(studentId: string, body: HomeworkProgressUpdate): Promise<Progress> {
  const res = await adminHttp.put<Progress>(`/admin/homework/progress/${encodePathSegment(studentId)}`, body)
  return res.data
}
