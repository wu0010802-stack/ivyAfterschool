<script setup lang="ts">
// FRONTEND-032：後台頂欄。移植 ivy FE:src/components/layout/AdminHeader.vue 的使用者下拉與登出流程；
// 去掉 impersonate、portal preview、GlobalSearch、A11yMenu、breadcrumb parents、employee store。
// 設計稿：docs/mockups/page-admin-shell.html。收合 / 手機狀態由 AdminLayout（FRONTEND-029）持有，
// 這裡只決定切換鈕的 icon 與手機版的使用者選單樣式，點擊一律 emit toggle-sidebar。
import { ArrowDown, Avatar, Expand, Fold, Key, Loading, SwitchButton } from '@element-plus/icons-vue'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import NotificationBell from '@/components/layout/NotificationBell.vue'
import { useAdminWsStore } from '@/stores/adminWs'
import { useAuthStore } from '@/stores/auth'

const props = withDefaults(defineProps<{ collapsed?: boolean; mobile?: boolean }>(), {
  collapsed: false,
  mobile: false,
})

const emit = defineEmits<{ 'toggle-sidebar': [] }>()

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const adminWs = useAdminWsStore()

const title = computed(() => route.meta.title ?? '')
const displayName = computed(() => auth.user?.display_name ?? '')
const roleName = computed(() => auth.user?.role.name ?? '')
const showExpandIcon = computed(() => props.mobile || props.collapsed)

const WS_TIPS: Partial<Record<string, string>> = {
  open: '即時連線正常',
  reconnecting: '即時連線重試中',
}
/** open 綠、reconnecting 黃，其他（idle / connecting / closed）灰 */
const wsClass = computed(() => {
  const status = adminWs.status
  return status === 'open' || status === 'reconnecting' ? `is-${status}` : 'is-offline'
})
const wsTip = computed(() => WS_TIPS[adminWs.status] ?? '即時連線未建立')

const loggingOut = ref(false)

async function logout(): Promise<void> {
  if (loggingOut.value) return
  loggingOut.value = true
  try {
    await auth.logout()
    await router.replace('/login')
  } finally {
    loggingOut.value = false
  }
}

function onCommand(command: string | number | object): void {
  if (command === 'password') void router.push('/change-password')
  else if (command === 'logout') void logout()
}
</script>

<template>
  <header class="admin-header">
    <el-button
      class="admin-header__toggle"
      text
      aria-label="切換側欄"
      @click="emit('toggle-sidebar')"
    >
      <el-icon :size="18">
        <Expand
          v-if="showExpandIcon"
          data-test="icon-expand"
        />
        <Fold
          v-else
          data-test="icon-fold"
        />
      </el-icon>
    </el-button>
    <h1 class="admin-header__title">
      {{ title }}
    </h1>
    <span class="admin-header__spacer" />

    <el-tooltip
      :content="wsTip"
      placement="bottom"
    >
      <span
        class="ws-dot"
        :class="wsClass"
        data-test="ws-dot"
        role="img"
        :aria-label="wsTip"
      />
    </el-tooltip>

    <NotificationBell />

    <el-dropdown
      trigger="click"
      @command="onCommand"
    >
      <button
        type="button"
        class="admin-header__user"
        data-test="user-menu"
        :aria-label="mobile ? '帳號選單' : undefined"
      >
        <el-icon><Avatar /></el-icon>
        <template v-if="!mobile">
          <span>{{ displayName }}</span>
          <el-tag
            size="small"
            type="info"
            disable-transitions
          >
            {{ roleName }}
          </el-tag>
        </template>
        <el-icon><ArrowDown /></el-icon>
      </button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-if="mobile"
            disabled
          >
            {{ displayName }}（{{ roleName }}）
          </el-dropdown-item>
          <el-dropdown-item command="password">
            <el-icon><Key /></el-icon>修改密碼
          </el-dropdown-item>
          <el-dropdown-item
            command="logout"
            divided
            :disabled="loggingOut"
          >
            <el-icon>
              <Loading
                v-if="loggingOut"
                class="is-loading"
              />
              <SwitchButton v-else />
            </el-icon>
            {{ loggingOut ? '登出中…' : '登出' }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </header>
</template>

<style scoped>
/* 高度含底線（56），App 沒有全域 border-box */
.admin-header {
  box-sizing: border-box;
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
  height: 56px;
  padding: 0 12px 0 8px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}

.admin-header__toggle {
  width: 44px;
  height: 44px;
  padding: 0;
}

.admin-header__title {
  margin: 0;
  overflow: hidden;
  font-size: 16px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-header__spacer {
  flex: 1;
}

.ws-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  margin: 0 6px;
  background: var(--el-color-info-light-3);
  border-radius: 50%;
}

.ws-dot.is-open {
  background: var(--el-color-success);
}

.ws-dot.is-reconnecting {
  background: var(--el-color-warning);
}

.admin-header__user {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  height: 44px;
  padding: 0 8px;
  font-family: inherit;
  font-size: 14px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: none;
  border: none;
  border-radius: 6px;
}

.admin-header__user:hover {
  background: var(--el-fill-color-light);
}
</style>
