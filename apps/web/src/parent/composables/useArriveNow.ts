// PARENT-105：「我到了 / 我已經到了」確認流程（首頁今日狀態卡與接送頁共用）。
// 移植 ivy FE:src/parent/views/PickupNoticeView.vue::onArriveNowClick / onArriveConfirm / performArriveNow 的
// 「下次不再提醒」與「沒有進行中請求時先建立再抵達」概念；本專案由後端 `arrived: true` 一次完成，
// 409（已有進行中請求）時由 PARENT-093 store 改對既有請求呼叫「我到了」。
//
// 頁面以 ConfirmDialog 呈現 confirmOpen（標題「確認已抵達安親班？」、說明「老師會收到通知並準備帶孩子出來」、
// default slot 放「下次不再提醒」勾選綁 skipNextTime）。busy 期間再次 request / confirm 一律忽略（防連點）。
import { readonly, ref, type Ref } from 'vue'
import { isApiError } from '@/shared/types/api'
import type { ParentPickupRequest } from '../api/pickupRequests'
import { usePickupRequestsStore } from '../stores/pickupRequests'
import { useSnackbarStore } from '../stores/snackbar'

export const ARRIVE_SKIP_CONFIRM_KEY = 'parent_pickup_arrive_skip_confirm'

const SUCCESS_MESSAGE = '已通知老師您到了'
const FALLBACK_ERROR = '送出失敗，請稍後再試'
const FIXED_ERRORS: Record<string, string> = {
  pickup_not_allowed: '您沒有這位小孩的接送權限',
  invalid_pickup_status: '狀態已更新，請確認後再操作',
  pickup_request_not_found: '找不到這筆接送請求，已重新整理',
}
/** 這些錯誤直接顯示後端的 error.message */
const BACKEND_MESSAGE_CODES = new Set(['pickup_window_closed', 'student_not_available', 'not_service_day', 'student_not_active'])

export interface ArriveNow {
  confirmOpen: Ref<boolean>
  skipNextTime: Ref<boolean>
  busy: Readonly<Ref<boolean>>
  /** 使用者按下「我到了 / 我已經到了」：有進行中請求 → 對該 id「我到了」；沒有 → 「我已經到了」捷徑 */
  request: (childId: string, openRequestId: string | null) => void
  /** ConfirmDialog 的確認；失敗或被忽略時回傳 null */
  confirm: () => Promise<ParentPickupRequest | null>
  /** ConfirmDialog 的取消 */
  dismiss: () => void
  lastResult: Ref<ParentPickupRequest | null>
}

function readSkipConfirm(): boolean {
  try {
    return localStorage.getItem(ARRIVE_SKIP_CONFIRM_KEY) === '1'
  } catch {
    // 無痕模式等情況 storage 會拋錯：每次都確認
    return false
  }
}

function writeSkipConfirm(): void {
  try {
    localStorage.setItem(ARRIVE_SKIP_CONFIRM_KEY, '1')
  } catch {
    // 同 readSkipConfirm：記不住就下次再問
  }
}

function errorMessage(error: unknown): string {
  if (!isApiError(error)) return FALLBACK_ERROR
  const fixed = FIXED_ERRORS[error.code]
  if (fixed) return fixed
  return BACKEND_MESSAGE_CODES.has(error.code) ? error.message : FALLBACK_ERROR
}

export function useArriveNow(): ArriveNow {
  const pickupRequests = usePickupRequestsStore()
  const snackbar = useSnackbarStore()

  const confirmOpen = ref(false)
  const skipNextTime = ref(false)
  const busy = ref(false)
  const lastResult = ref<ParentPickupRequest | null>(null)
  let target: { childId: string; openRequestId: string | null } | null = null

  async function run(): Promise<ParentPickupRequest | null> {
    const current = target
    target = null
    if (!current) return null
    // 送出前同步設定 busy：同一個 tick 內的再次呼叫就會被擋下
    busy.value = true
    try {
      const result = current.openRequestId
        ? await pickupRequests.markArrived(current.openRequestId)
        : await pickupRequests.arriveNow(current.childId)
      lastResult.value = result
      snackbar.show(SUCCESS_MESSAGE)
      return result
    } catch (error) {
      snackbar.show(errorMessage(error), { tone: 'error' })
      return null
    } finally {
      busy.value = false
    }
  }

  function request(childId: string, openRequestId: string | null): void {
    if (busy.value) return
    target = { childId, openRequestId }
    if (readSkipConfirm()) {
      void run()
      return
    }
    skipNextTime.value = false
    confirmOpen.value = true
  }

  function confirm(): Promise<ParentPickupRequest | null> {
    if (busy.value || !target) return Promise.resolve(null)
    if (skipNextTime.value) writeSkipConfirm()
    confirmOpen.value = false
    return run()
  }

  function dismiss(): void {
    confirmOpen.value = false
    target = null
  }

  return { confirmOpen, skipNextTime, busy: readonly(busy), request, confirm, dismiss, lastResult }
}
