// FRONTEND-308：把變數放進 api 路徑的唯一入口（前後台共用）。
// encodeURIComponent 不編碼 '.'，值恰為 '.' / '..' 時仍是 dot-segment，URL 正規化後會打到其他 endpoint；
// 空字串則讓路徑少一段。這三種值直接拒絕、不送出請求。
import { ApiError } from '@/shared/types/api'

const INVALID_SEGMENTS = new Set(['', '.', '..'])

export function encodePathSegment(value: string): string {
  if (INVALID_SEGMENTS.has(value)) throw new ApiError(0, 'invalid_path_segment', '資料識別碼無效，請重新整理後再試')
  return encodeURIComponent(value)
}
