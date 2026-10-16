// FRONTEND-184：接送等候時間、急迫等級、ETA 相對文字與分鐘時鐘。
// 移植 ivy FE:src/composables/useDismissalUrgency.ts 的 URGENCY_WARNING_MIN / URGENCY_CRITICAL_MIN、elapsedMinutes、
// urgencyLevel、formatWaited、etaRelativeText、monogramOf、useNowClock；時間解析改用 FRONTEND-003（HH:MM 欄位為台北時間），
// 去掉 reservation announcement、isPreArrivalNotice（本專案以 status 判斷）。
// 純函式都吃 now（毫秒）參數，元件吃 useNowClock 的 ref，方便以固定時間測試。
import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue'
import type { PickupRequest } from '@/api/pickupRequests'
import type { HHMM } from '@/shared/types/api'
import { hhmmToUtcIso, isValidHHMM, minutesSince, todayTaipei } from '@/shared/utils/datetime'

/** 已等 3 分鐘起轉 warning、8 分鐘起轉 critical；要調整服務標準改這兩個常數 */
export const URGENCY_WARNING_MIN = 3
export const URGENCY_CRITICAL_MIN = 8

export type UrgencyLevel = 'normal' | 'warning' | 'critical'

/** 家長已到後等了幾整分鐘；只有 arrived 才計算，其他（含 arrived_at 缺值或無法解析）回 null */
export function waitedMinutes(req: Pick<PickupRequest, 'status' | 'arrived_at'>, now: number): number | null {
  if (req.status !== 'arrived' || !req.arrived_at) return null
  if (Number.isNaN(Date.parse(req.arrived_at))) return null
  return minutesSince(req.arrived_at, new Date(now))
}

/** null 與不滿 3 分鐘為 normal；3~7 分鐘 warning；8 分鐘以上 critical */
export function urgencyLevel(minutes: number | null): UrgencyLevel {
  if (minutes == null || minutes < URGENCY_WARNING_MIN) return 'normal'
  return minutes < URGENCY_CRITICAL_MIN ? 'warning' : 'critical'
}

/** null 回空字串（不顯示）；0 分「剛到」；滿一小時「已等 1 小時 5 分」 */
export function formatWaited(minutes: number | null): string {
  if (minutes == null) return ''
  if (minutes <= 0) return '剛到'
  if (minutes >= 60) return `已等 ${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`
  return `已等 ${minutes} 分`
}

/**
 * 台北當地 HH:MM 相對於 now 的文字：未來「約 n 分後」、過去「已過 n 分」，前後不滿 1 分鐘「現在」。
 * HH:MM 視為 now 所在台北日期的時間；null 或格式錯誤回空字串。
 */
export function etaRelativeText(hhmm: HHMM | null, now: number): string {
  if (!hhmm || !isValidHHMM(hhmm)) return ''
  const target = Date.parse(hhmmToUtcIso(todayTaipei(new Date(now)), hhmm))
  const deltaMinutes = (target - now) / 60_000
  if (Math.abs(deltaMinutes) < 1) return '現在'
  return deltaMinutes > 0 ? `約 ${Math.round(deltaMinutes)} 分後` : `已過 ${Math.round(-deltaMinutes)} 分`
}

/** 姓名圓徽文字：取最後一個字（中文名的名字字尾），空值回 '?' */
export function monogramOf(name: string | null | undefined): string {
  const last = [...(name ?? '').trim()].at(-1)
  return last ? last.toUpperCase() : '?'
}

/**
 * 每 intervalMs 前進一次的 now（毫秒），讓相對時間文字自己跳。
 * 在 effectScope（元件 setup 也是）內呼叫，scope 結束時清除 interval。
 */
export function useNowClock(intervalMs = 30_000): { now: Ref<number> } {
  const now = ref(Date.now())
  const timer = setInterval(() => {
    now.value = Date.now()
  }, intervalMs)
  if (getCurrentScope()) onScopeDispose(() => clearInterval(timer))
  return { now }
}
