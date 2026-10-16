// PARENT-013：家長端入口。建立 app（ParentLayout + Pinia + router），注入 PARENT-004 的未登入 handler。
// 移植 ivy FE:src/parent/main.ts 的掛載順序；去掉 tenant boot、Sentry、theme / a11y 初始化、離線佇列 flush、
// chunkSelfHeal 與 publicLiffTarget 跳轉。首次探測 /parent/me 由 PARENT-012 的路由守衛負責。
// 不得 import element-plus 或後台目錄（INFRA-005 eslint、INFRA-029 bundle 檢查）。
import { createPinia, type Pinia } from 'pinia'
import { createApp, type App } from 'vue'
import { START_LOCATION, type Router, type RouterHistory } from 'vue-router'
import './styles/m3-tokens.css'
import './styles/base.css'
import './styles/icons.css'
import { setUnauthenticatedHandler } from './api/http'
import { isParentLoggingOut } from './composables/useParentLogout'
import ParentLayout from './layouts/ParentLayout.vue'
import { createParentRouter } from './router'
import { useChildrenStore } from './stores/children'
import { useParentAuthStore } from './stores/parentAuth'
import { useParentWsStore } from './stores/parentWs'

const LOGIN_PATH = '/login'

export interface ParentAppOptions {
  /** 預設 hash history；測試傳 createMemoryHistory() */
  history?: RouterHistory
}

export function createParentApp(opts: ParentAppOptions = {}): { app: App; router: Router; pinia: Pinia } {
  const app = createApp(ParentLayout)
  const pinia = createPinia()
  app.use(pinia)
  const router = createParentRouter(opts.history)

  // 已發出、尚未完成的導向登入：/login 守衛的探測也 401 時不再導向第二次
  let redirecting = false

  // 要在 app.use(router) 之前註冊：安裝 router 就會開始第一次導航，守衛的探測可能就 401
  setUnauthenticatedHandler(() => {
    useParentAuthStore(pinia).clear()
    useChildrenStore(pinia).clear()
    useParentWsStore(pinia).disconnect()
    const current = router.currentRoute.value
    // 第一次導航還沒完成（START_LOCATION）時交給守衛導向，才會帶上原本要去的路徑，也避免兩個導航互相取消
    // 登出進行中：登出流程自己會導到 /login?logged_out=1，這裡再導 redirect= 會取消它（LINE 內會自動再登入）
    if (current === START_LOCATION || current.meta.public || redirecting || isParentLoggingOut()) return
    redirecting = true
    void router.replace({ path: LOGIN_PATH, query: { redirect: current.fullPath } }).finally(() => {
      redirecting = false
    })
  })

  app.use(router)
  return { app, router, pinia }
}

/**
 * 第一次導航完成才掛載：導航完成前目前路由是 START_LOCATION（沒有 meta），ParentLayout 會先畫出頂部列與底部導覽，
 * 在 /login 再收起（閃一下）。第一次導航失敗（例如 lazy view 的 chunk 載入失敗）也照樣掛載，不留白頁。
 */
export async function mountParentApp(
  target: string | Element,
  opts: ParentAppOptions = {},
): Promise<{ app: App; router: Router; pinia: Pinia }> {
  const created = createParentApp(opts)
  try {
    await created.router.isReady()
  } catch {
    // 照樣掛載；之後的導航會再試一次
  }
  created.app.mount(target)
  return created
}

if (!import.meta.env.VITEST) void mountParentApp('#app')
