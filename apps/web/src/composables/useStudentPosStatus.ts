// FRONTEND-183：接送 POS 學生卡狀態與排序權重（純函式）。
// 移植 ivy FE:src/composables/useStudentPosStatus.ts::useStudentPosStatus 的「輸入單一學生 → {status, sortWeight}」
// 純函式設計與優先權寫法；狀態改為本專案（出勤 + 接送請求），去掉 bus_picked / proxy_picked / POS 補登。
// 輸入是 GET /admin/pickup/roster 的單一學生（FRONTEND-180 RosterStudent），open_request 已是後端判定的非終態請求。
import type { RosterStudent } from '@/api/pickupRequests'
import type { HHMM, HomeworkOverallStatus, LeaveType, PickupOpenStatus } from '@/shared/types/api'
import type { Tone } from '@/shared/constants/statusLabels'

export type PosStudentStatus =
  | 'arrived'
  | 'requested'
  | 'waiting'
  | 'not_arrived'
  | 'picked_up'
  | 'on_leave'
  | 'absent'

export interface PosStudentStatusDetail {
  requestId?: string
  requestStatus?: PickupOpenStatus
  needsReply?: boolean
  /** 進行中請求的預計抵達時間（台北 HH:MM）；沒有請求或未填為 null */
  expectedArrival: HHMM | null
  homeworkStatus: HomeworkOverallStatus | null
  /** 作業預計完成時間（台北 HH:MM） */
  readyEta: HHMM | null
  /** 當日 active 的代理接送授權數 */
  authorizationCount: number
  /** roster 的 leave_type 代碼（sick / personal / other），中文由 StudentCard 以 LEAVE_TYPE_META 轉換 */
  leaveType: LeaveType | null
}

export interface PosStudentStatusResult {
  status: PosStudentStatus
  sortWeight: number
  detail: PosStudentStatusDetail
}

export const POS_STATUS_META: Record<PosStudentStatus, { label: string; tone: Tone }> = {
  arrived: { label: '家長已到', tone: 'danger' },
  requested: { label: '接送中', tone: 'warning' },
  waiting: { label: '在班等待', tone: 'success' },
  not_arrived: { label: '尚未到班', tone: 'info' },
  picked_up: { label: '已離班', tone: 'info' },
  on_leave: { label: '請假', tone: 'info' },
  absent: { label: '缺席', tone: 'info' },
}

/** 越小越前面；請假與缺席同權重，同權重的次序由呼叫端再依學號排序 */
const SORT_WEIGHT: Record<PosStudentStatus, number> = {
  arrived: 0,
  requested: 1,
  waiting: 2,
  not_arrived: 3,
  picked_up: 4,
  on_leave: 5,
  absent: 5,
}

/**
 * 優先權（高 → 低）：家長已到 → 進行中請求 → 已離班 → 請假 / 缺席 → 在班 → 其餘（預計到班或沒有出勤紀錄）。
 * 進行中請求優先於出勤：已離班的學生被重新發起接送時，卡片回到接送中。
 */
function statusOf(s: RosterStudent): PosStudentStatus {
  const request = s.open_request
  if (request?.status === 'arrived') return 'arrived'
  if (request) return 'requested'
  switch (s.attendance_status) {
    case 'left':
      return 'picked_up'
    case 'leave':
      return 'on_leave'
    case 'absent':
      return 'absent'
    case 'present':
      return 'waiting'
    default:
      return 'not_arrived'
  }
}

export function useStudentPosStatus(student: RosterStudent): PosStudentStatusResult {
  const status = statusOf(student)
  const request = student.open_request
  const detail: PosStudentStatusDetail = {
    expectedArrival: request?.expected_arrival_at ?? null,
    homeworkStatus: student.homework_status,
    readyEta: student.ready_eta,
    authorizationCount: student.active_authorization_count,
    leaveType: student.leave_type,
  }
  if (request) {
    detail.requestId = request.id
    detail.requestStatus = request.status
    detail.needsReply = request.needs_reply
  }
  return { status, sortWeight: SORT_WEIGHT[status], detail }
}
