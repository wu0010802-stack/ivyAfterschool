<script setup lang="ts">
// FRONTEND-085：學生工作台（左列表、右詳情）。移植 ivy FE:src/views/StudentWorkbenchView.vue 的兩欄與 query 驅動選取；
// 去掉 TodayTasksPanel、招生 / 在籍統計連動。設計稿：docs/mockups/page-students.html。
// - 選中的學生存在 query.student（點列 router.replace 帶入；直接以網址進入時開啟該學生）。
// - 視窗寬 ≥ 1440 雙欄（詳情固定寬 520、黏在頂端）；< 1440 詳情改右側 el-drawer（寬 640），關閉時清掉 student 與 tab。
// - 詳情只有一個實例，以 Teleport 在雙欄與抽屜之間搬移：跨斷點不卸載重掛、不重抓
//   （GuardianManager 內只顯示一次的綁定碼 dialog 不會消失）。抽屜關閉動畫結束才卸載詳情，動畫期間不留白。
// - 詳情變更（編輯、封存、照片、永久刪除）後列表重新載入目前頁。
import { Close, User } from '@element-plus/icons-vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import EmptyState from '@/components/common/EmptyState.vue'
import StudentDetailPanel from '@/components/student/StudentDetailPanel.vue'
import StudentListPanel from '@/components/student/StudentListPanel.vue'

const WIDE_MIN_WIDTH = 1440
const DRAWER_SIZE = 640
/** 屬於詳情的 query 參數：關閉詳情時一起清掉 */
const DETAIL_QUERY_KEYS = ['student', 'tab']

const route = useRoute()
const router = useRouter()

const selectedId = computed<string | null>(() => {
  const raw = route.query.student
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value ? value : null
})

// ---- 雙欄 / 抽屜 ----
const wide = ref(window.innerWidth >= WIDE_MIN_WIDTH)

function onResize(): void {
  wide.value = window.innerWidth >= WIDE_MIN_WIDTH
}

onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

/** 詳情顯示的學生：抽屜關閉動畫期間保留上一位，動畫結束（closed）才清掉 */
const shownId = ref<string | null>(selectedId.value)

watch(selectedId, (id) => {
  if (id || wide.value) shownId.value = id
})

function onDrawerClosed(): void {
  if (!selectedId.value) shownId.value = null
}

const drawerOpen = computed(() => !wide.value && selectedId.value !== null)
/** 抽屜內容第一次打開時才渲染；渲染前詳情留在（隱藏的）雙欄位置 */
const drawerBody = ref<HTMLElement | null>(null)

// ---- 選取 ----
function select(id: string): void {
  if (id === selectedId.value) return
  void router.replace({ query: { ...route.query, student: id } })
}

function closeDetail(): void {
  const query: LocationQueryRaw = { ...route.query }
  for (const key of DETAIL_QUERY_KEYS) delete query[key]
  void router.replace({ query })
}

// ---- 詳情變更 → 列表重新載入 ----
const listPanel = ref<InstanceType<typeof StudentListPanel> | null>(null)

function onDetailChanged(): void {
  void listPanel.value?.reload()
}
</script>

<template>
  <div
    class="workbench"
    :class="{ 'is-drawer-mode': !wide }"
  >
    <StudentListPanel
      ref="listPanel"
      class="workbench__list"
      :selected-id="selectedId"
      @select="select"
    />
    <section
      v-show="wide"
      class="workbench__detail"
    >
      <EmptyState
        v-if="!shownId"
        title="從左側選擇學生以檢視詳情"
        :icon="User"
      />
      <Teleport
        v-else
        :to="drawerBody"
        :disabled="wide || !drawerBody"
      >
        <StudentDetailPanel
          :student-id="shownId"
          @changed="onDetailChanged"
        />
      </Teleport>
    </section>
  </div>

  <el-drawer
    :model-value="drawerOpen"
    class="workbench-drawer"
    body-class="workbench-drawer__container"
    :size="DRAWER_SIZE"
    :with-header="false"
    append-to-body
    :before-close="closeDetail"
    @closed="onDrawerClosed"
  >
    <div class="workbench-drawer__head">
      <el-button
        class="workbench-drawer__close"
        text
        aria-label="關閉"
        @click="closeDetail"
      >
        <el-icon :size="18">
          <Close />
        </el-icon>
      </el-button>
    </div>
    <div
      ref="drawerBody"
      class="workbench-drawer__body"
    />
  </el-drawer>
</template>

<style scoped>
.workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 520px;
  gap: 16px;
  align-items: start;
}

.workbench.is-drawer-mode {
  grid-template-columns: minmax(0, 1fr);
}

/* 詳情黏在內容區頂端；比可視區高時自己捲動（56 = 頂欄、40 = 內容區上下 padding） */
.workbench__detail {
  position: sticky;
  top: 0;
  min-height: 480px;
  max-height: calc(100dvh - 56px - 40px);
  padding: 16px;
  overflow-y: auto;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}
</style>

<style>
/* el-drawer 傳送到 body，scoped 樣式碰不到 */
.el-drawer .workbench-drawer__container {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

.workbench-drawer__head {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  height: 48px;
  padding: 0 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.workbench-drawer__close.el-button {
  width: 44px;
  height: 44px;
}

.workbench-drawer__body {
  flex: 1;
  min-height: 0;
  padding: 16px 20px;
  overflow: auto;
}
</style>
