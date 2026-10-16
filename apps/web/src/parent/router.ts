// PARENT-012：家長端路由表與登入 / 綁定守衛（移植 ivy FE:src/parent/router.ts 的 hash history 與 meta 設計、
// FE:src/parent/main.ts::ensureSessionProbed 的首次探測；去掉 device-login、maintenance 與幼稚園路由）。
//
// view 一律 lazy import；尚未實作的 view 先以佔位檔（views/<Name>.vue）讓 app shell 可以建置與瀏覽。
// 登入真相在 httpOnly cookie，守衛以 PARENT-009 parentAuth 的鏡像狀態判斷：
//   - public（/login）：已登入就導回 redirect query（PARENT-003 驗證過的站內路徑），否則放行。
//   - bindable（/bind）：先看 bindPending（首綁：瀏覽器只有 parent_bind cookie，探測 /parent/me 必定 401，
//     而 401 流程會 parentAuth.clear() 連 bindPending 一起清掉），有就直接放行、不探測；否則已登入（加綁）才放行。
//   - 其他：未登入導向 /login 並帶 redirect = to.fullPath（router 自己解析出的路徑，消費端仍會再驗證）。
import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router'
import { useParentAuthStore } from './stores/parentAuth'
import { resolveSafeRedirect } from './utils/safeRedirect'

/** 底部導覽五個分頁（PARENT-024） */
export type ParentTab = 'home' | 'homework' | 'pickup' | 'exams' | 'more'

declare module 'vue-router' {
  interface RouteMeta {
    title: string
    /** 不需登入（/login） */
    public?: boolean
    /** bindPending 或已登入其一即可進入（/bind） */
    bindable?: boolean
    /** 底部導覽目前分頁；沒有的頁面（公開頁）不顯示導覽 */
    tab?: ParentTab
    /** 頂部列顯示返回鍵 */
    showBack?: boolean
    /** 隱藏頂部列與底部導覽 */
    hideTabBar?: boolean
  }
}

export const parentRoutes: RouteRecordRaw[] = [
  {
    path: '/login',
    component: () => import('./views/LoginView.vue'),
    meta: { title: '登入', public: true, hideTabBar: true },
  },
  {
    path: '/bind',
    component: () => import('./views/BindView.vue'),
    meta: { title: '綁定小孩', bindable: true, hideTabBar: true },
  },
  {
    path: '/',
    component: () => import('./views/ChildHubView.vue'),
    meta: { title: '首頁', tab: 'home' },
  },
  {
    path: '/homework',
    component: () => import('./views/HomeworkView.vue'),
    meta: { title: '今日作業', tab: 'homework' },
  },
  {
    path: '/pickup',
    component: () => import('./views/PickupView.vue'),
    meta: { title: '接送', tab: 'pickup' },
  },
  {
    path: '/pickup/proxy',
    component: () => import('./views/PickupProxyView.vue'),
    meta: { title: '代理接送', tab: 'pickup', showBack: true },
  },
  {
    path: '/exams',
    component: () => import('./views/ExamsView.vue'),
    meta: { title: '成績', tab: 'exams' },
  },
  {
    path: '/exams/:examId',
    component: () => import('./views/ExamDetailView.vue'),
    meta: { title: '成績明細', tab: 'exams', showBack: true },
  },
  {
    path: '/more',
    component: () => import('./views/MoreView.vue'),
    meta: { title: '更多', tab: 'more' },
  },
  {
    path: '/attendance',
    component: () => import('./views/AttendanceView.vue'),
    meta: { title: '出勤紀錄', tab: 'more', showBack: true },
  },
  {
    path: '/leaves',
    component: () => import('./views/LeavesView.vue'),
    meta: { title: '請假', tab: 'more', showBack: true },
  },
  {
    path: '/notifications',
    component: () => import('./views/NotificationsView.vue'),
    meta: { title: '通知', tab: 'more', showBack: true },
  },
  {
    // 返回鍵由 PARENT-024 以 history 回上一頁（/notifications）
    path: '/notifications/preferences',
    component: () => import('./views/NotificationPrefsView.vue'),
    meta: { title: '通知設定', tab: 'more', showBack: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export function installParentGuards(router: Router): void {
  router.beforeEach(async (to) => {
    const auth = useParentAuthStore()

    if (to.meta.public) {
      // 已登入不停在登入頁：導回 redirect（站內相對路徑，不安全或缺值一律回首頁）
      if (await auth.ensureSession()) return resolveSafeRedirect(to.query.redirect)
      return true
    }

    if (to.meta.bindable) {
      // 順序不可對調：首綁時探測必定失敗，且失敗流程會把 bindPending 一起清掉
      if (auth.bindPending !== null) return true
      if (await auth.ensureSession()) return true
      return { path: '/login', replace: true }
    }

    if (await auth.ensureSession()) return true
    return { path: '/login', replace: true, query: { redirect: to.fullPath } }
  })

  router.afterEach((to) => {
    if (typeof to.meta.title === 'string') document.title = `${to.meta.title}｜家長端`
  })
}

export function createParentRouter(history: RouterHistory = createWebHashHistory()): Router {
  const router = createRouter({ history, routes: parentRoutes })
  installParentGuards(router)
  return router
}
