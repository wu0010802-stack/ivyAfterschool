// PARENT-033：家長端登出並清除所有家長端狀態。
// 移植 ivy FE:src/parent/composables/useParentLogout.ts::performParentLogout 的清除順序與
// 「結束 LINE session，否則回登入頁後 liff 仍為登入狀態，LoginView 會自動以上一位家長身分重新登入」；
// 去掉離線佇列 flush、跨分頁 session isolation、FAQ / today status 快取。
//
// 一律導向 /login?logged_out=1：PARENT-196 的守衛看到 logged_out 就不探測 /parent/me；少了這個值，
// 探測的 401 會讓 PARENT-013 的 handler 依登出前的頁面改導 /login?redirect=…，LoginView 在 LINE 內就會自動再登入。
import { readonly, ref, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { clearLiffTokenRefreshMarker, initLiff } from '../services/liff'
import { useChildrenStore } from '../stores/children'
import { useHomeworkTodayStore } from '../stores/homeworkToday'
import { useNotificationsStore } from '../stores/notifications'
import { useParentAuthStore } from '../stores/parentAuth'
import { useParentWsStore } from '../stores/parentWs'
import { usePickupRequestsStore } from '../stores/pickupRequests'
import { useSnackbarStore } from '../stores/snackbar'

export interface ParentLogout {
  logout: () => Promise<void>
  loggingOut: Readonly<Ref<boolean>>
}

export function useParentLogout(): ParentLogout {
  const router = useRouter()
  const parentAuth = useParentAuthStore()
  const parentWs = useParentWsStore()
  const children = useChildrenStore()
  const notifications = useNotificationsStore()
  const pickupRequests = usePickupRequestsStore()
  const homeworkToday = useHomeworkTodayStore()
  const snackbar = useSnackbarStore()

  const loggingOut = ref(false)

  /** 結束 LINE session；LIFF 未設定、SDK 載入或 init 失敗都忽略（伺服器端 session 已撤銷） */
  async function endLineSession(): Promise<void> {
    try {
      const liff = await initLiff()
      if (liff.isLoggedIn()) liff.logout()
    } catch {
      // 忽略，照常導向登入頁
    }
  }

  async function logout(): Promise<void> {
    if (loggingOut.value) return
    loggingOut.value = true
    try {
      parentWs.disconnect()
      // 撤銷 refresh family；API 失敗也會清掉本地登入狀態
      await parentAuth.logout()
      children.clear()
      notifications.clear()
      pickupRequests.clear()
      homeworkToday.clear()
      snackbar.clear()
      clearLiffTokenRefreshMarker()
      await endLineSession()
      await router.replace({ path: '/login', query: { logged_out: '1' } })
    } finally {
      loggingOut.value = false
    }
  }

  return { logout, loggingOut: readonly(loggingOut) }
}
