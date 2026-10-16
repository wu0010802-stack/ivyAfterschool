<script setup lang="ts">
// FRONTEND-027：後台根元件。依路由 meta.layout 切換版面——'blank'（登入、改密碼、找不到頁面）直接 <RouterView />，
// 其餘包進 AdminLayout（FRONTEND-029）；el-config-provider 套用 Element Plus 繁中語系。
// 路由 ready 之前（第一次導航還在跑，route 仍是起始位置、meta 是空的）只顯示全頁 loading，避免閃現側欄。
// 登出後的清理依賴 AdminLayout 卸載（停 adminWs、清通知 store）：版面切換一律用 v-if / v-else，
// 不可改成 v-show 或 keep-alive 包住。
import { Loading } from '@element-plus/icons-vue'
import zhTw from 'element-plus/es/locale/lang/zh-tw'
import { computed, ref } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import AdminLayout from '@/layouts/AdminLayout.vue'

const route = useRoute()
const router = useRouter()

const ready = ref(false)
// 第一次導航失敗（isReady 會 reject）也要離開 loading，錯誤由 router.onError 處理
void router.isReady().then(
  () => {
    ready.value = true
  },
  () => {
    ready.value = true
  },
)

const blank = computed(() => route.meta.layout === 'blank')
</script>

<template>
  <el-config-provider :locale="zhTw">
    <div
      v-if="!ready"
      class="app-loading"
      data-test="app-loading"
      role="status"
      aria-label="載入中"
    >
      <el-icon
        class="is-loading"
        :size="32"
      >
        <Loading />
      </el-icon>
    </div>
    <RouterView v-else-if="blank" />
    <AdminLayout v-else>
      <RouterView />
    </AdminLayout>
  </el-config-provider>
</template>

<style scoped>
.app-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  height: 100dvh;
  color: var(--el-color-primary);
  background: var(--el-bg-color-page);
}
</style>
