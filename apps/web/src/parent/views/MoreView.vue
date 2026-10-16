<script setup lang="ts">
/**
 * PARENT-034：「更多」分頁（/more）。由上而下：家長資料 → 我的小孩 → 加好友卡 → 功能入口 → 登出 → 安親班名稱。
 * 參考 ivy FE:src/parent/views/MeView.vue 的資訊架構與 doLogout；去掉費用摘要、個資匯出、外觀設定、FAQ、
 * 個資權利專區與推播狀態提示。
 *
 * - 小孩清單進頁呼叫 children.load()（已載入不重打，與首頁 / 成績頁 / 請假頁相同）。
 * - 頭像網址（LINE 頭像、學生照片）可能過期：載入失敗以「網址」記錄並退回首字，清單換成新網址時會重新嘗試。
 * - 登出：ConfirmDialog 確認後呼叫 PARENT-033 logout()；進行中對話框保持開啟、確認鈕 loading（取消 / Esc / scrim 無效），
 *   完成後由 useParentLogout 導向 /login?logged_out=1。登出 API 失敗也照樣登出，不顯示錯誤。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { STUDENT_STATUS_META } from '@/shared/constants/statusLabels'
import type { ChildSummary } from '../api/children'
import { getPublicConfig } from '../api/config'
import AddFriendCard from '../components/AddFriendCard.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import M3ListItem from '../components/m3/M3ListItem.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import { useParentLogout } from '../composables/useParentLogout'
import { useChildrenStore } from '../stores/children'
import { useNotificationsStore } from '../stores/notifications'
import { useParentAuthStore } from '../stores/parentAuth'

interface Entry {
  headline: string
  icon: string
  to: string
  /** 「通知」列：trailing 在 chevron 前加未讀數膠囊 */
  unreadBadge?: boolean
}

const ENTRIES: readonly Entry[] = [
  { headline: '出勤紀錄', icon: 'calendar_month', to: '/attendance' },
  { headline: '請假', icon: 'event_busy', to: '/leaves' },
  { headline: '代理接送', icon: 'badge', to: '/pickup/proxy' },
  { headline: '通知', icon: 'notifications', to: '/notifications', unreadBadge: true },
  { headline: '通知設定', icon: 'tune', to: '/notifications/preferences' },
  { headline: '加綁其他小孩', icon: 'link', to: '/bind' },
]

const SUSPENDED = STUDENT_STATUS_META.suspended
const BADGE_MAX = 99
/** display_name 空白時的頭像字 */
const PARENT_FALLBACK_INITIAL = '家'

const router = useRouter()
const parentAuth = useParentAuthStore()
const children = useChildrenStore()
const notifications = useNotificationsStore()
const { logout, loggingOut } = useParentLogout()

const failedPhotos = reactive(new Set<string>())
const friendUrl = ref<string | null>(null)
const orgName = ref('')
const confirmOpen = ref(false)

/** 首字；用 Array.from 避免把罕用字（兩個 UTF-16 code unit）切成一半 */
function initialOf(name: string | null | undefined): string {
  return Array.from((name ?? '').trim())[0] ?? ''
}

function usablePhoto(url: string | null | undefined): string | null {
  return url && !failedPhotos.has(url) ? url : null
}

function onPhotoError(url: string | null | undefined): void {
  if (url) failedPhotos.add(url)
}

const displayName = computed(() => parentAuth.parent?.display_name ?? '')
const parentPhoto = computed(() => usablePhoto(parentAuth.parent?.picture_url))
const parentInitial = computed(() => initialOf(displayName.value) || PARENT_FALLBACK_INITIAL)

type KidsState = 'list' | 'loading' | 'error' | 'empty'

// 有資料一律顯示清單（重新整理失敗也保留舊資料）；尚未開始載入（例如登出清空後）視同載入中
const kidsState = computed<KidsState>(() => {
  if (children.items.length > 0) return 'list'
  if (children.error) return 'error'
  if (children.loading || !children.loaded) return 'loading'
  return 'empty'
})

function subtitle(c: ChildSummary): string {
  return [`${c.grade_level} 年級`, c.class_name].filter(Boolean).join(' · ')
}

function pick(id: string): void {
  children.select(id)
  void router.push('/')
}

function retryChildren(): void {
  void children.load(true)
}

function goBind(): void {
  void router.push('/bind')
}

const unread = computed(() => notifications.unreadCount)
const badgeText = computed(() => (unread.value > BADGE_MAX ? `${BADGE_MAX}+` : String(unread.value)))

async function confirmLogout(): Promise<void> {
  await logout()
  confirmOpen.value = false
}

onMounted(() => {
  void children.load()
  getPublicConfig().then(
    (config) => {
      friendUrl.value = config.add_friend_url
      orgName.value = (config.org_name ?? '').trim()
    },
    () => {
      // 取不到公開設定：不顯示加好友卡與安親班名稱
    },
  )
})
</script>

<template>
  <div class="more">
    <section
      class="profile"
      aria-label="家長資料"
    >
      <span
        class="profile__avatar m3-headline-small"
        aria-hidden="true"
      >
        <img
          v-if="parentPhoto"
          :src="parentPhoto"
          alt=""
          @error="onPhotoError(parentPhoto)"
        >
        <template v-else>{{ parentInitial }}</template>
      </span>
      <h2 class="profile__name m3-title-large">
        {{ displayName }}
      </h2>
    </section>

    <div class="more-section m3-label-large">
      我的小孩
    </div>
    <M3Card
      variant="outlined"
      padding="none"
      class="more-card"
    >
      <SkeletonBlock
        v-if="kidsState === 'loading'"
        variant="row"
        :count="2"
      />
      <ParentEmptyState
        v-else-if="kidsState === 'error'"
        variant="error"
        title="小孩清單載入失敗"
        description="請檢查網路連線後再試一次"
        @action="retryChildren"
      />
      <ParentEmptyState
        v-else-if="kidsState === 'empty'"
        icon="link"
        title="尚未綁定小孩"
        description="請輸入安親班提供的綁定碼"
        action-label="輸入綁定碼"
        @action="goBind"
      />
      <ul
        v-else
        class="kid-list"
        role="list"
        aria-label="我的小孩"
      >
        <li
          v-for="c in children.items"
          :key="c.id"
        >
          <button
            type="button"
            class="kid-row"
            :aria-current="c.id === children.selectedId ? 'true' : undefined"
            @click="pick(c.id)"
          >
            <span
              class="kid-row__avatar m3-title-small"
              aria-hidden="true"
            >
              <img
                v-if="usablePhoto(c.photo_url)"
                :src="usablePhoto(c.photo_url) ?? undefined"
                alt=""
                @error="onPhotoError(c.photo_url)"
              >
              <template v-else>{{ initialOf(c.name) }}</template>
            </span>
            <span class="kid-row__text">
              <span class="kid-row__name-row">
                <span class="kid-row__name m3-body-large">{{ c.name }}</span>
                <StatusPill
                  v-if="c.status === 'suspended'"
                  :label="SUSPENDED.label"
                  :tone="SUSPENDED.tone"
                />
              </span>
              <span class="kid-row__sub m3-body-medium">{{ subtitle(c) }}</span>
            </span>
            <StatusPill
              v-if="c.id === children.selectedId"
              label="目前查看"
              tone="info"
            />
            <M3Icon
              v-else
              class="kid-row__chevron"
              name="chevron_right"
            />
          </button>
        </li>
      </ul>
    </M3Card>

    <AddFriendCard
      class="more-friend"
      :url="friendUrl"
    />

    <div class="more-section m3-label-large">
      功能
    </div>
    <M3Card
      variant="outlined"
      padding="none"
      class="more-card"
    >
      <ul
        class="more-list"
        role="list"
        aria-label="功能"
      >
        <M3ListItem
          v-for="entry in ENTRIES"
          :key="entry.to"
          :headline="entry.headline"
          :leading-icon="entry.icon"
          :trailing-icon="entry.unreadBadge ? '' : 'chevron_right'"
          :to="entry.to"
        >
          <template
            v-if="entry.unreadBadge"
            #trailing
          >
            <span class="notif-trailing">
              <template v-if="unread > 0">
                <span
                  class="count-badge m3-label-medium"
                  aria-hidden="true"
                >{{ badgeText }}</span>
                <span class="visually-hidden">，{{ unread }} 則未讀</span>
              </template>
              <M3Icon name="chevron_right" />
            </span>
          </template>
        </M3ListItem>
      </ul>
    </M3Card>

    <M3Card
      variant="outlined"
      padding="none"
      class="more-card more-logout"
    >
      <ul
        class="more-list"
        role="list"
        aria-label="帳號"
      >
        <M3ListItem
          headline="登出"
          leading-icon="logout"
          clickable
          @click="confirmOpen = true"
        />
      </ul>
    </M3Card>

    <p
      v-if="orgName"
      class="more-footer m3-body-small"
    >
      {{ orgName }}
    </p>

    <ConfirmDialog
      :open="confirmOpen"
      title="確定要登出？"
      message="登出後需重新以 LINE 登入"
      confirm-label="登出"
      cancel-label="取消"
      destructive
      :loading="loggingOut"
      @confirm="confirmLogout"
      @cancel="confirmOpen = false"
    />
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、上 8px、底部 24px 內距（ParentLayout 的 main 不加） */
.more {
  padding: 8px 16px 24px;
}

/* 小標：同首頁 */
.more-section {
  margin: 20px 4px 8px;
  color: var(--m3-on-surface-variant);
}

.more-friend {
  margin-top: 16px;
}

.more-logout {
  margin-top: 16px;
}

.more-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 家長資料 */
.profile {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 72px;
  padding: 8px 0;
}

.profile__avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  overflow: hidden;
  border-radius: var(--m3-shape-full);
  background: var(--m3-tertiary-container);
  color: var(--m3-on-tertiary-container);
}

.profile__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile__name {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--m3-on-surface);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 我的小孩：每位一列，整列可點 */
.kid-list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}

.kid-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  min-height: 72px;
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: var(--m3-on-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* state layer */
.kid-row::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--m3-on-surface);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.kid-row:hover::before {
  opacity: var(--m3-state-hover);
}

.kid-row:focus-visible::before {
  opacity: var(--m3-state-focus);
}

.kid-row:active::before {
  opacity: var(--m3-state-pressed);
}

.kid-row:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: -2px;
}

.kid-row__avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  overflow: hidden;
  border-radius: var(--m3-shape-full);
  background: var(--m3-tertiary-container);
  color: var(--m3-on-tertiary-container);
}

.kid-row__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.kid-row__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.kid-row__name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.kid-row__name,
.kid-row__sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kid-row__sub {
  color: var(--m3-on-surface-variant);
}

.kid-row__chevron {
  flex: none;
  color: var(--m3-on-surface-variant);
}

/* 通知列 trailing：未讀數膠囊 + chevron */
.notif-trailing {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.count-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--m3-shape-full);
  background: var(--m3-error);
  color: var(--m3-on-error);
  font-variant-numeric: tabular-nums;
}

.more-footer {
  margin: 24px 0 0;
  color: var(--m3-on-surface-variant);
  text-align: center;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  border: 0;
  white-space: nowrap;
  clip: rect(0 0 0 0);
}
</style>
