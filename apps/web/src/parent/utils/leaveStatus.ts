import type { ISODate, LeaveStatus } from '@/shared/types/api'

export type LeaveStatusPillLabel = '已取消' | '已結束' | '已排定' | '請假中'
export type LeaveStatusPillTone = 'neutral' | 'info' | 'warning'

export interface LeaveStatusPill {
  label: LeaveStatusPillLabel
  tone: LeaveStatusPillTone
}

/**
 * 家長端請假狀態膠囊（列表列與詳情 sheet 共用）。
 * cancelled 優先於日期判斷：員工可能從後台整筆取消已結束的請假。
 * 日期皆為 YYYY-MM-DD，以字串比較即可。
 */
export function leaveStatusPill(
  leave: { status: LeaveStatus; start_date: ISODate; end_date: ISODate },
  today: ISODate,
): LeaveStatusPill {
  if (leave.status === 'cancelled') return { label: '已取消', tone: 'neutral' }
  if (leave.end_date < today) return { label: '已結束', tone: 'neutral' }
  if (leave.start_date > today) return { label: '已排定', tone: 'info' }
  return { label: '請假中', tone: 'warning' }
}
