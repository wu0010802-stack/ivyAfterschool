<script setup lang="ts">
/**
 * 家長端根元件（PARENT-013 以它建立 app；稿 parent-component-layout.html）。
 * 移植 ivy ParentLayout 的 meta 驅動顯示、返回邏輯與 onTabSelect；去掉 BrandMark、home summary 徽章、
 * 幼稚園分頁、頂部列頭像鈕、ParentOfflineIndicator 與首頁 / LINE in-app 隱藏標題的判斷。
 *
 * - public 或 hideTabBar（/login、/bind）不渲染頂部列與底部導覽；BindView 的標題 / 返回列由頁面自己畫。
 * - 返回：vue-router 記錄的上一個站內位置（history.state.back）有值才 router.back()，否則回首頁。
 *   不看 history.length：LIFF 進入時 liff.state 轉址會讓第一頁的 length 就大於 1，back() 可能退出 SPA。
 * - 頁面捲動是 window 捲動；換頁回頂端 / 返回還原位置由 router 的 scrollBehavior（PARENT-195）負責。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { getPublicConfig } from '../api/config'
import ConnectionBanner from '../components/ConnectionBanner.vue'
import M3NavigationBar, { type NavItem } from '../components/m3/M3NavigationBar.vue'
import M3Snackbar from '../components/m3/M3Snackbar.vue'
import M3TopAppBar from '../components/m3/M3TopAppBar.vue'
import { useNotificationsStore } from '../stores/notifications'
import { useParentAuthStore } from '../stores/parentAuth'
import { useParentWsStore } from '../stores/parentWs'
import { useSnackbarStore } from '../stores/snackbar'

const route = useRoute()
const router = useRouter()
const parentAuth = useParentAuthStore()
const parentWs = useParentWsStore()
const notifications = useNotificationsStore()
const snackbar = useSnackbarStore()

const isPublic = computed(() => route.meta.public === true)
/** 頂部列與底部導覽 */
const showChrome = computed(() => !isPublic.value && route.meta.hideTabBar !== true)

const TABS: Omit<NavItem, 'badge'>[] = [
  { key: 'home', label: '首頁', icon: 'home', path: '/' },
  { key: 'homework', label: '作業', icon: 'assignment', path: '/homework' },
  { key: 'pickup', label: '接送', icon: 'directions_walk', path: '/pickup' },
  { key: 'exams', label: '成績', icon: 'grading', path: '/exams' },
  { key: 'more', label: '更多', icon: 'menu', path: '/more' },
]

const navItems = computed<NavItem[]>(() =>
  TABS.map((tab) => (tab.key === 'more' ? { ...tab, badge: notifications.unreadCount } : tab)),
)

// leading 的安親班識別：載入中、取得失敗或名稱空白時留空（欄位保留，標題不位移、不閃字）
const orgName = ref('')
const logoUrl = ref<string | null>(null)
const logoFailed = ref(false)
const showLogo = computed(() => !!logoUrl.value && !logoFailed.value)
const brandInitial = computed(() => Array.from(orgName.value.trim())[0] ?? '')

function onBack(): void {
  const state = window.history.state as { back?: unknown } | null
  if (state?.back) router.back()
  else void router.replace('/')
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 路徑不同 → 換頁（深層頁點所屬分頁即回分頁根路徑）；相同 → 捲回頂端、不導頁 */
function onTabSelect(_key: string, item: NavItem): void {
  if (route.path !== item.path) {
    void router.push(item.path)
    return
  }
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
}

// 登入生命週期：登入（含掛載時已登入）→ 連 ws 並更新未讀數；登出 → 斷開 ws
watch(
  () => parentAuth.isAuthed,
  (authed, wasAuthed) => {
    if (authed) {
      parentWs.connect()
      void notifications.refreshUnread()
    } else if (wasAuthed) {
      parentWs.disconnect()
    }
  },
  { immediate: true },
)

onMounted(() => {
  getPublicConfig().then(
    (config) => {
      orgName.value = config.org_name ?? ''
      logoUrl.value = config.logo_url
    },
    () => undefined,
  )
})
</script>

<template>
  <div
    class="parent-layout"
    :class="{ 'is-tabbar-hidden': !showChrome }"
  >
    <div
      v-if="showChrome"
      class="app-header"
    >
      <M3TopAppBar
        :title="route.meta.title"
        :show-back="route.meta.showBack === true"
        @back="onBack"
      >
        <template #leading>
          <img
            v-if="showLogo"
            class="brand-logo"
            :src="logoUrl ?? undefined"
            alt=""
            @error="logoFailed = true"
          >
          <span
            v-else-if="brandInitial"
            class="logo-mark m3-title-medium"
            aria-hidden="true"
          >{{ brandInitial }}</span>
        </template>
      </M3TopAppBar>
      <ConnectionBanner />
    </div>

    <main class="layout-main">
      <!-- hideTabBar 的非公開頁（/bind）：橫幅在最上方、一般文流，隨內容捲走 -->
      <ConnectionBanner v-if="!isPublic && !showChrome" />
      <RouterView />
    </main>

    <M3Snackbar
      :item="snackbar.items[0] ?? null"
      @dismiss="snackbar.dismiss"
    />
    <M3NavigationBar
      v-if="showChrome"
      class="layout-nav"
      :items="navItems"
      :current-key="route.meta.tab ?? ''"
      @select="onTabSelect"
    />
  </div>
</template>

<style>
/* 頁面捲動是 window 捲動：根捲動容器不讓瀏覽器原生下拉刷新 / iOS 回彈搶走 PullToRefresh 的手勢 */
html,
body {
  overscroll-behavior-y: contain;
}
</style>

<style scoped>
.parent-layout {
  max-width: 560px;
  min-height: 100dvh;
  margin: 0 auto;
  background: var(--m3-surface);
  color: var(--m3-on-surface);
}

/* 頂部列 + 連線橫幅：同一個 sticky 區塊 */
.app-header {
  position: sticky;
  top: 0;
  z-index: 5;
}

/* main 不加左右內距（各頁自帶）；有底部導覽時預留導覽高度 */
.layout-main {
  display: block;
}

.parent-layout:not(.is-tabbar-hidden) .layout-main {
  padding-bottom: calc(80px + env(safe-area-inset-bottom));
}

.layout-nav {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 5;
  max-width: 560px;
  margin: 0 auto;
}

/* 沒有底部導覽時 snackbar 改貼底部，不懸空 */
.parent-layout.is-tabbar-hidden :deep(.m3-snackbar) {
  bottom: calc(16px + env(safe-area-inset-bottom));
}

/* leading 的安親班識別（無返回鍵時） */
.brand-logo {
  display: block;
  width: 40px;
  height: 40px;
  border-radius: var(--m3-shape-full);
  object-fit: cover;
}

.logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: var(--m3-shape-full);
  background: var(--m3-primary-container);
  color: var(--m3-on-primary-container);
}
</style>
