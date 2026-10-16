<script setup lang="ts">
/**
 * 通知收件匣（/notifications；稿 parent-page-notifications.html）。頂部列「通知」與返回鍵由 ParentLayout 依 route meta 負責。
 * 資料全在 PARENT-172 notifications store：ws 新通知由 store 插到最前面，畫面直接出現、不重新請求。
 *
 * - 首次載入、切換篩選、錯誤重試：卡內骨架直到該次 load 回應；下拉重新整理保留現有內容，失敗以 snackbar 提示。
 * - 點通知：未讀的先標已讀（不等回應、失敗不阻擋）→ payload.student_id 是自己的小孩就切換 → deep_link 是站內安全路徑才導頁。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Notification } from '@/shared/types/api'
import M3Button from '../components/m3/M3Button.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3SegmentedButton, { type SegmentItem } from '../components/m3/M3SegmentedButton.vue'
import NotificationListItem from '../components/notifications/NotificationListItem.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import PullToRefresh from '../components/PullToRefresh.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { useChildrenStore } from '../stores/children'
import { useNotificationsStore } from '../stores/notifications'
import { useSnackbarStore } from '../stores/snackbar'
import { isSafeRedirectPath } from '../utils/safeRedirect'

type Filter = 'all' | 'unread'

// vue-tsc 不把 template 的 aria-label 對應到 ariaLabel prop（同 LeaveForm），改以物件展開
const FILTER_SEGMENT_ATTRS = { ariaLabel: '通知篩選' }

const router = useRouter()
const notifications = useNotificationsStore()
const children = useChildrenStore()
const snackbar = useSnackbarStore()

const filter = ref<Filter>('all')
/** 首次載入 / 切換篩選 / 重試：等待該次 load 期間卡內顯示骨架 */
const switching = ref(true)
const loadingMore = ref(false)
const markingAll = ref(false)

/**
 * store.items 是哪個篩選成功載入的結果。切換篩選失敗時 store 保留的是另一個篩選的舊清單，
 * 不能當成目前篩選的內容顯示，要改顯示錯誤態。
 */
const loadedFilter = ref<Filter | null>(null)

// 每次需要骨架的載入遞增；較舊的那次結束時不收骨架（store 也會丟棄它的回應）
let switchSeq = 0

const filterItems = computed<SegmentItem[]>(() => {
  const n = notifications.unreadCount
  return [
    { value: 'all', label: '全部' },
    { value: 'unread', label: n > 0 ? `未讀 ${n > 99 ? '99+' : n}` : '未讀' },
  ]
})

const view = computed<'loading' | 'error' | 'empty' | 'data'>(() => {
  if (switching.value) return 'loading'
  if (notifications.error && (notifications.items.length === 0 || loadedFilter.value !== filter.value)) return 'error'
  return notifications.items.length > 0 ? 'data' : 'empty'
})

const hasMore = computed(() => view.value === 'data' && notifications.items.length < notifications.total)

async function loadCurrent(): Promise<void> {
  const requested = filter.value
  await notifications.load({ unreadOnly: requested === 'unread' })
  if (!notifications.error && filter.value === requested) loadedFilter.value = requested
}

async function reload(): Promise<void> {
  const mySeq = ++switchSeq
  switching.value = true
  await loadCurrent()
  if (mySeq === switchSeq) switching.value = false
}

function onFilter(value: string): void {
  const next: Filter = value === 'unread' ? 'unread' : 'all'
  if (next === filter.value) return
  filter.value = next
  void reload()
}

/** 下拉重新整理：重抓目前篩選的第 1 頁，保留現有內容；失敗但仍顯示內容時另外提示（已是錯誤態就不重複） */
async function refresh(): Promise<void> {
  await loadCurrent()
  if (notifications.error && view.value !== 'error') {
    snackbar.show('更新失敗，請稍後再試', { tone: 'error' })
  }
}

async function loadMore(): Promise<void> {
  if (loadingMore.value) return
  const pageBefore = notifications.page
  loadingMore.value = true
  try {
    await notifications.loadMore()
  } finally {
    loadingMore.value = false
  }
  if (notifications.page === pageBefore && notifications.error) {
    snackbar.show('載入更多失敗，請稍後再試', { tone: 'error' })
  }
}

async function markAll(): Promise<void> {
  if (markingAll.value || notifications.unreadCount === 0) return
  markingAll.value = true
  try {
    await notifications.markAllRead()
  } catch {
    snackbar.show('全部標為已讀失敗，請稍後再試', { tone: 'error' })
    return
  } finally {
    markingAll.value = false
  }
  snackbar.show('已全部標為已讀')
  // 未讀篩選：重抓後清單變成空狀態（不顯示骨架）
  if (filter.value === 'unread') await loadCurrent()
}

function onOpen(n: Notification): void {
  if (n.read_at === null) void notifications.markRead(n.id).catch(() => undefined)
  const studentId = n.payload?.student_id
  if (typeof studentId === 'string' && children.items.some((c) => c.id === studentId)) {
    children.select(studentId)
  }
  // deep_link 是外部可控輸入：只導站內安全路徑，其餘留在本頁、不提示
  if (isSafeRedirectPath(n.deep_link)) void router.push(n.deep_link)
}

function openPreferences(): void {
  void router.push('/notifications/preferences')
}

onMounted(() => {
  void children.load()
  void reload()
})
</script>

<template>
  <PullToRefresh
    :on-refresh="refresh"
    :disabled="view === 'loading'"
  >
    <div class="ntv">
      <M3SegmentedButton
        :model-value="filter"
        :items="filterItems"
        v-bind="FILTER_SEGMENT_ATTRS"
        @update:model-value="onFilter"
      />
      <div class="ntv-tools">
        <M3Button
          variant="text"
          icon="tune"
          @click="openPreferences"
        >
          通知設定
        </M3Button>
        <M3Button
          variant="text"
          icon="done_all"
          :disabled="notifications.unreadCount === 0"
          :loading="markingAll"
          @click="markAll"
        >
          全部標為已讀
        </M3Button>
      </div>

      <template v-if="view !== 'error'">
        <M3Card
          variant="outlined"
          padding="none"
          class="noti-card"
        >
          <ul
            v-if="view === 'data'"
            class="noti-list"
            role="list"
            :aria-label="filter === 'unread' ? '未讀通知' : '通知'"
          >
            <NotificationListItem
              v-for="n in notifications.items"
              :key="n.id"
              :notification="n"
              @open="onOpen"
            />
          </ul>
          <SkeletonBlock
            v-else-if="view === 'loading'"
            variant="row"
            :count="4"
          />
          <ParentEmptyState
            v-else-if="filter === 'unread'"
            icon="done_all"
            title="沒有未讀通知"
            description="新的到班、作業、接送與成績通知會出現在這裡"
          />
          <ParentEmptyState
            v-else
            icon="notifications"
            title="目前沒有通知"
            description="到班、作業、接送與成績的通知會出現在這裡"
          />
        </M3Card>
        <M3Button
          v-if="hasMore"
          variant="outlined"
          block
          :loading="loadingMore"
          @click="loadMore"
        >
          載入更多
        </M3Button>
      </template>
      <ParentEmptyState
        v-else
        variant="error"
        title="通知載入失敗"
        description="請檢查網路連線後再試一次"
        @action="reload"
      />
    </div>
  </PullToRefresh>
</template>

<style scoped>
/* 頁面自帶左右 16px、上 8px、底部 24px（放在 PullToRefresh 內層），區塊間距 12px */
.ntv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 16px 24px;
}

/* 文字按鈕的內距往外吃，讓圖示與內容左右緣對齊 */
.ntv-tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: -4px -12px;
}

.noti-card {
  overflow: hidden;
}

.noti-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
