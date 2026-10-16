<script setup lang="ts">
// FRONTEND-029：後台外框（左側欄、上頂欄、中內容區 slot），並負責啟動 /api/ws/admin 與通知收件匣、顯示斷線橫幅。
// 移植 ivy FE:src/layouts/AdminLayout.vue 的版面骨架與手機抽屜；去掉 high-risk audit count、portal context 判斷、
// tenant、輪詢 summary（通知改走 ws + 收件匣 API，斷線輪詢由 adminWs 的各頁 poller 負責）。
// 設計稿：docs/mockups/page-admin-shell.html。
// 登出後的清理依賴本元件卸載：AdminHeader 登出只呼叫 auth store 並導向 /login，不會停 adminWs；
// /login 是 blank layout，App.vue（FRONTEND-027）讓本元件卸載（不可 v-show / keep-alive），onUnmounted 才停 ws。
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AdminHeader from '@/components/layout/AdminHeader.vue'
import AdminSidebar from '@/components/layout/AdminSidebar.vue'
import { useAdminWsStore } from '@/stores/adminWs'
import { useNotificationsStore } from '@/stores/notifications'

/** 側欄收合狀態；所有頁共用同一個值 */
const COLLAPSE_STORAGE_KEY = 'admin.sidebarCollapsed'
/** 視窗寬小於此值改為抽屜 */
const MOBILE_BREAKPOINT = 768
/** ws 重連中持續超過這麼久才顯示橫幅，短暫斷線（換頁、網路抖動）不打擾 */
const RECONNECT_BANNER_DELAY_MS = 5000

const route = useRoute()
const adminWs = useAdminWsStore()
const notifications = useNotificationsStore()

function readStoredCollapsed(): boolean | null {
  try {
    const value = localStorage.getItem(COLLAPSE_STORAGE_KEY)
    return value === 'true' ? true : value === 'false' ? false : null
  } catch {
    return null
  }
}

function writeStoredCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, String(value))
  } catch {
    // 偏好存不下來只影響下次開啟
  }
}

// 側欄：沒有記錄（使用者沒切換過）時，meta.tablet 頁面預設收合；切換過就以記住的值為準
const storedCollapsed = ref<boolean | null>(readStoredCollapsed())
const collapsed = computed(() => storedCollapsed.value ?? route.meta.tablet === true)

function toggleCollapsed(): void {
  storedCollapsed.value = !collapsed.value
  writeStoredCollapsed(storedCollapsed.value)
}

// 手機：側欄改左側抽屜，開關不影響桌機的收合狀態與記憶
const mobile = ref(window.innerWidth < MOBILE_BREAKPOINT)
const drawerOpen = ref(false)

function onResize(): void {
  mobile.value = window.innerWidth < MOBILE_BREAKPOINT
}

watch(mobile, (isMobile) => {
  if (!isMobile) drawerOpen.value = false
})

function onToggleSidebar(): void {
  if (mobile.value) drawerOpen.value = !drawerOpen.value
  else toggleCollapsed()
}

// 斷線橫幅：reconnecting 持續超過 RECONNECT_BANNER_DELAY_MS 才出現，離開 reconnecting（open / idle / closed）立即消失
const reconnectBanner = ref(false)
let bannerTimer: ReturnType<typeof setTimeout> | null = null

function clearBannerTimer(): void {
  if (bannerTimer === null) return
  clearTimeout(bannerTimer)
  bannerTimer = null
}

watch(
  () => adminWs.status,
  (status) => {
    if (status === 'reconnecting') {
      if (bannerTimer !== null) return
      bannerTimer = setTimeout(() => {
        bannerTimer = null
        reconnectBanner.value = true
      }, RECONNECT_BANNER_DELAY_MS)
      return
    }
    clearBannerTimer()
    reconnectBanner.value = false
  },
  { immediate: true },
)

let unbindNotifications: (() => void) | null = null

onMounted(() => {
  window.addEventListener('resize', onResize)
  // 先綁 handler 再連線，連上後的第一則通知不會漏
  unbindNotifications = notifications.bindWs()
  adminWs.start()
  // 背景預載是為了鈴鐺的未讀數；失敗不吵使用者，開啟通知面板時（loaded 仍為 false）會再載入並顯示錯誤
  notifications.fetch().catch(() => undefined)
})

onUnmounted(() => {
  window.removeEventListener('resize', onResize)
  clearBannerTimer()
  unbindNotifications?.()
  unbindNotifications = null
  // 整個分頁共用同一個 pinia：不清的話，換人登入後下一位使用者會先看到上一位的通知
  notifications.reset()
  adminWs.stop()
})
</script>

<template>
  <div class="admin-layout">
    <AdminSidebar
      v-if="!mobile"
      :collapsed="collapsed"
      @toggle="toggleCollapsed"
    />

    <div class="admin-layout__body">
      <AdminHeader
        :collapsed="collapsed"
        :mobile="mobile"
        @toggle-sidebar="onToggleSidebar"
      />
      <el-alert
        v-if="reconnectBanner"
        class="admin-layout__banner"
        type="warning"
        :closable="false"
        show-icon
        title="即時連線中斷，畫面每 15 秒自動更新"
      />
      <main class="admin-layout__main">
        <slot />
      </main>
    </div>

    <el-drawer
      v-if="mobile"
      v-model="drawerOpen"
      class="admin-layout-drawer"
      body-class="admin-layout-drawer__body"
      data-test="admin-sidebar-drawer"
      direction="ltr"
      title="導覽選單"
      :size="240"
      :with-header="false"
    >
      <AdminSidebar
        drawer
        :collapsed="false"
        @navigate="drawerOpen = false"
      />
    </el-drawer>
  </div>
</template>

<style scoped>
/* 側欄與頂欄固定，只有內容區捲動；100vh 為不支援 dvh 的瀏覽器備援（手機網址列會讓 100vh 超出可視區） */
.admin-layout {
  display: flex;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--el-bg-color-page);
}

.admin-layout__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.admin-layout__banner {
  flex-shrink: 0;
  border-radius: 0;
}

.admin-layout__main {
  flex: 1;
  min-height: 0;
  padding: 20px;
  overflow: auto;
}

@media (max-width: 1024px) {
  .admin-layout__main {
    padding: 16px;
  }
}

@media (max-width: 767px) {
  .admin-layout__main {
    padding: 12px;
  }
}
</style>

<style>
/* el-drawer 傳送到 body，scoped 樣式碰不到：抽屜內的側欄自己填滿，不要 Element Plus 預設的 body padding */
.el-drawer .admin-layout-drawer__body {
  padding: 0;
}
</style>
