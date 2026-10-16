// FRONTEND-028：建立後台 app（App.vue + Pinia + router），注入 adminHttp 的 refresh / 認證失敗 / 強制改密碼 handler，
// 設定未捕捉錯誤的顯示與 Element Plus 全域繁中語系。main.ts 只負責匯入樣式與掛載；測試傳 memory history。
import { ElMessage, provideGlobalConfig } from 'element-plus'
import zhTw from 'element-plus/es/locale/lang/zh-tw'
import { createPinia, type Pinia } from 'pinia'
import { createApp, type App } from 'vue'
import { START_LOCATION, type Router, type RouterHistory } from 'vue-router'
import * as authApi from '@/api/auth'
import { setAdminHttpHandlers } from '@/api/http'
import AppRoot from '@/App.vue'
import { createAdminRouter } from '@/router'
import { errorMessage, isCanceled } from '@/shared/utils/errorMessage'
import { useAuthStore } from '@/stores/auth'

const LOGIN_PATH = '/login'
const CHANGE_PASSWORD_PATH = '/change-password'

export interface AdminAppOptions {
  /** 預設 hash history；測試傳 createMemoryHistory() */
  history?: RouterHistory
}

export function createAdminApp(opts: AdminAppOptions = {}): { app: App; router: Router; pinia: Pinia } {
  const app = createApp(AppRoot)
  const pinia = createPinia()
  app.use(pinia)
  const router = createAdminRouter(opts.history)
  app.use(router)

  // App.vue 的 el-config-provider 只涵蓋元件樹；命令式的 ElMessageBox / ElMessage 在樹外渲染，
  // 要靠全域設定才會是繁中（不必用 app.use(ElementPlus) 整包安裝）
  provideGlobalConfig({ locale: zhTw }, app, true)

  setAdminHttpHandlers({
    refresh: async () => {
      // refresh 回來的權限可能已變更
      const user = await authApi.refresh()
      useAuthStore(pinia).setUser(user)
    },
    authFailure: () => {
      useAuthStore(pinia).reset()
      const current = router.currentRoute.value
      // 第一次導航還沒完成時（restore 的 401）交給 authGuard 導向登入，避免兩個導航互相取消
      if (current === START_LOCATION || current.meta.public) return
      void router.replace({ path: LOGIN_PATH, query: { redirect: current.fullPath } })
    },
    passwordChangeRequired: () => {
      void router.replace(CHANGE_PASSWORD_PATH)
    },
  })

  app.config.errorHandler = (err) => {
    if (isCanceled(err)) return
    console.error('[app] 未捕捉的錯誤', err)
    ElMessage.error(errorMessage(err, '發生未預期的錯誤'))
  }

  return { app, router, pinia }
}
