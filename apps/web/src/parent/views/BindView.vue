<script setup lang="ts">
/**
 * 綁定碼綁定（/bind；稿 parent-page-bind.html）。首綁與加綁同一頁，進頁時依登入狀態決定模式
 * （PARENT-012 守衛已保證「已登入」或「bindPending」其一）：已登入 = 持有 parent_access → 加綁；否則持有 parent_bind → 首綁。
 * 移植 ivy BindView / BindAdditionalView 的 submit（合併為單一頁），保留「聯絡安親班」撥號（電話取公開設定 org_phone）。
 *
 * - 綁定碼送出前正規化（去空白與「-」、轉大寫），不符合 8 碼英數就只在欄位提示、不送出；綁定碼不寫進 log 或 storage。
 * - 首綁 401：bind token 過期 → 逾時提示，重新登入。
 * - 加綁 401：parent_access 過期，而 /parent/auth/bind 在 parentHttp 的 noRefreshPaths（不會自動續期）
 *   → 自己 refresh 一次後以同一組碼重送；refresh 失敗或重送再 401 視同登入失效。
 * - 業務錯誤交給 BindCodeErrorNotice；未知錯誤碼與網路錯誤一律 code = null（不把後端原始訊息丟給家長）。
 */
import axios from 'axios'
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isApiError } from '@/shared/types/api'
import { bind } from '../api/auth'
import type { ChildSummary, ParentMe } from '../api/children'
import { getPublicConfig, type PublicConfig } from '../api/config'
import { parentRefreshHttp } from '../api/http'
import AddFriendCard from '../components/AddFriendCard.vue'
import BindCodeErrorNotice from '../components/bind/BindCodeErrorNotice.vue'
import M3Button from '../components/m3/M3Button.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import M3TextField from '../components/m3/M3TextField.vue'
import M3TopAppBar from '../components/m3/M3TopAppBar.vue'
import { useChildrenStore } from '../stores/children'
import { useParentAuthStore } from '../stores/parentAuth'
import { useSnackbarStore } from '../stores/snackbar'
import { resolveSafeRedirect } from '../utils/safeRedirect'

const FIELD_ERROR = '綁定碼為 8 碼英文或數字'
const CODE_PATTERN = /^[A-Z0-9]{8}$/
/** BindCodeErrorNotice 認得的錯誤碼；其他一律傳 null（顯示「綁定失敗，請稍後再試」） */
const KNOWN_CODES = new Set([
  'binding_code_invalid',
  'binding_code_expired',
  'binding_code_used',
  'guardian_already_bound',
  'already_bound_to_student',
  'too_many_attempts',
  'parent_disabled',
])

const route = useRoute()
const router = useRouter()
const parentAuth = useParentAuthStore()
const children = useChildrenStore()
const snackbar = useSnackbarStore()

// 模式與問候在進頁時固定：綁定成功（setParent 清掉 bindPending）或登入失效（clear）導頁前，畫面不跟著切換
const mode: 'first' | 'additional' = parentAuth.isAuthed ? 'additional' : 'first'
const nameHint = parentAuth.bindPending?.nameHint ?? null

const code = ref('')
const fieldError = ref('')
const submitting = ref(false)
const bindError = ref<{ code: string | null } | null>(null)
const timedOut = ref(false)
/** 首綁成功且有加好友網址：成功畫面要列的小孩 */
const bound = ref<ChildSummary[] | null>(null)
const addFriendUrl = ref<string | null>(null)
const orgPhone = ref<string | null>(null)
const photoFailed = reactive<Record<string, boolean>>({})
const formRef = ref<HTMLFormElement | null>(null)

// 公開設定：錯誤提示的撥號電話與首綁成功的加好友網址；取不到時當作沒有
const configReady: Promise<PublicConfig | null> = getPublicConfig().then(
  (config) => {
    orgPhone.value = config.org_phone
    return config
  },
  () => null,
)

function subText(c: ChildSummary): string {
  return c.class_name ? `${c.grade_level} 年級 · ${c.class_name}` : `${c.grade_level} 年級`
}

function initial(name: string): string {
  return Array.from(name)[0] ?? ''
}

const boundText = computed(() => (bound.value ?? []).map((c) => `${c.name}（${subText(c)}）`).join('、'))

function normalize(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

function isUnauthorized(e: unknown): boolean {
  return isApiError(e) && e.status === 401
}

function showBindError(e: unknown): void {
  bindError.value = { code: isApiError(e) && KNOWN_CODES.has(e.code) ? e.code : null }
}

/** 409 refresh_in_progress：另一個分頁剛輪替過 cookie，視同成功（同 PARENT-004） */
async function refreshSession(): Promise<boolean> {
  try {
    await parentRefreshHttp.post('/parent/auth/refresh')
    return true
  } catch (e) {
    return axios.isAxiosError(e) && e.response?.status === 409
  }
}

async function sessionExpired(): Promise<void> {
  parentAuth.clear()
  children.clear()
  await router.replace('/login')
}

/** 回傳綁定後的家長資料；失敗時已處理畫面或導頁，回 null */
async function attemptBind(normalized: string): Promise<ParentMe | null> {
  try {
    return (await bind(normalized)).parent
  } catch (e) {
    if (!isUnauthorized(e)) {
      showBindError(e)
      return null
    }
    if (mode === 'first') {
      timedOut.value = true
      return null
    }
  }
  if (!(await refreshSession())) {
    await sessionExpired()
    return null
  }
  try {
    return (await bind(normalized)).parent
  } catch (e) {
    if (isUnauthorized(e)) await sessionExpired()
    else showBindError(e)
    return null
  }
}

async function onBound(parent: ParentMe): Promise<void> {
  // 先記下綁定前的小孩，才找得出新加綁的是哪一位（重新整理後 children 可能尚未載入，併入登入資料）
  const before = new Set([...children.items, ...(parentAuth.parent?.children ?? [])].map((c) => c.id))
  parentAuth.setParent(parent)
  children.seed(parent.children)

  if (mode === 'additional') {
    const added = parent.children.find((c) => !before.has(c.id))
    if (added) {
      children.select(added.id)
      snackbar.show(`已加綁 ${added.name}`)
    }
    await router.replace('/')
    return
  }

  const config = await configReady
  if (config?.add_friend_url) {
    addFriendUrl.value = config.add_friend_url
    bound.value = parent.children
    return
  }
  await router.replace(resolveSafeRedirect(route.query.redirect))
}

async function onSubmit(): Promise<void> {
  if (submitting.value) return
  const normalized = normalize(code.value)
  if (!CODE_PATTERN.test(normalized)) {
    fieldError.value = FIELD_ERROR
    return
  }
  fieldError.value = ''
  bindError.value = null
  submitting.value = true
  try {
    const parent = await attemptBind(normalized)
    if (parent) await onBound(parent)
  } finally {
    submitting.value = false
  }
}

async function onRetry(): Promise<void> {
  code.value = ''
  fieldError.value = ''
  bindError.value = null
  await nextTick()
  formRef.value?.querySelector('input')?.focus()
}

function relogin(): void {
  parentAuth.clearBindPending()
  void router.replace('/login')
}

function startUsing(): void {
  void router.replace(resolveSafeRedirect(route.query.redirect))
}

function onBack(): void {
  void router.push('/more')
}

onMounted(() => {
  // 加綁頁重新整理時小孩清單可能尚未載入（已載入則不重抓）
  if (mode === 'additional') void children.load()
})
</script>

<template>
  <div
    v-if="bound"
    class="bind-success"
  >
    <main class="bind-success__content">
      <div class="success-head">
        <M3Icon
          class="success-head__icon"
          name="check_circle"
          filled
          :size="48"
        />
        <h1 class="m3-headline-small">
          綁定完成
        </h1>
        <p class="m3-body-medium">
          已綁定：{{ boundText }}
        </p>
      </div>
      <AddFriendCard :url="addFriendUrl" />
    </main>
    <div class="bind-footer">
      <M3Button
        block
        @click="startUsing"
      >
        開始使用
      </M3Button>
    </div>
  </div>

  <div
    v-else
    class="bind-page"
  >
    <M3TopAppBar
      v-if="mode === 'additional'"
      title="加綁其他小孩"
      show-back
      @back="onBack"
    />
    <main
      class="bind"
      :class="{ 'has-bar': mode === 'additional' }"
    >
      <div
        v-if="mode === 'first'"
        class="bind-head"
      >
        <p class="bind-head__eyebrow m3-label-large">
          第一次使用
        </p>
        <h1 class="m3-headline-small">
          綁定小孩
        </h1>
        <p
          v-if="nameHint"
          class="bind-head__hello m3-body-large"
        >
          您好，{{ nameHint }}
        </p>
      </div>
      <template v-else>
        <h2 class="bind-section m3-label-large">
          目前已綁定
        </h2>
        <M3Card
          variant="outlined"
          padding="none"
        >
          <ul
            v-if="children.items.length"
            class="bound-list"
            role="list"
            aria-label="目前已綁定的小孩"
          >
            <li
              v-for="k in children.items"
              :key="k.id"
              class="bound-row"
            >
              <span
                class="bound-row__avatar m3-title-small"
                aria-hidden="true"
              >
                <img
                  v-if="k.photo_url && !photoFailed[k.id]"
                  :src="k.photo_url"
                  alt=""
                  @error="photoFailed[k.id] = true"
                >
                <template v-else>{{ initial(k.name) }}</template>
              </span>
              <span class="bound-row__text">
                <span class="bound-row__name m3-body-large">{{ k.name }}</span>
                <span class="bound-row__sub m3-body-medium">{{ subText(k) }}</span>
              </span>
            </li>
          </ul>
          <p
            v-else
            class="bound-empty m3-body-medium"
          >
            目前沒有已綁定的小孩
          </p>
        </M3Card>
        <h2 class="bind-section m3-label-large">
          輸入新的綁定碼
        </h2>
      </template>

      <div
        v-if="timedOut"
        class="bind-timeout"
      >
        <div
          class="bind-timeout__box"
          role="alert"
        >
          <M3Icon
            name="timer_off"
            filled
          />
          <p class="m3-title-medium">
            綁定時間已逾時，請重新以 LINE 登入
          </p>
        </div>
        <M3Button
          block
          icon="login"
          @click="relogin"
        >
          重新登入
        </M3Button>
      </div>
      <template v-else>
        <form
          ref="formRef"
          class="bind-form"
          autocapitalize="characters"
          novalidate
          @submit.prevent="onSubmit"
        >
          <M3TextField
            v-model="code"
            label="綁定碼"
            autocomplete="one-time-code"
            supporting-text="請輸入安親班提供的 8 碼綁定碼。綁定碼只能使用一次，過期或已使用請向安親班索取新的綁定碼。"
            :error-text="fieldError"
            @update:model-value="fieldError = ''"
          />
          <M3Button
            type="submit"
            block
            :loading="submitting"
          >
            綁定
          </M3Button>
        </form>
        <BindCodeErrorNotice
          v-if="bindError"
          :code="bindError.code"
          :org-phone="orgPhone"
          @retry="onRetry"
        />
      </template>
    </main>
  </div>
</template>

<style scoped>
.bind {
  padding: 32px 16px 24px;
}

.bind.has-bar {
  padding-top: 8px;
}

.bind-head {
  padding: 0 0 16px;
}

.bind-head__eyebrow {
  margin: 0;
  color: var(--m3-primary);
}

.bind-head h1 {
  margin: 4px 0;
  color: var(--m3-on-surface);
}

.bind-head__hello {
  margin: 0;
  color: var(--m3-on-surface-variant);
}

.bind-section {
  margin: 16px 4px 8px;
  color: var(--m3-on-surface-variant);
}

.bind-section:first-child {
  margin-top: 8px;
}

.bind-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  margin: 0 0 16px;
}

/* 加綁模式：目前已綁定（不可點的清單） */
.bound-list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}

.bound-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 56px;
  padding: 8px 16px;
}

.bound-row__avatar {
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

.bound-row__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.bound-row__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.bound-row__name,
.bound-row__sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bound-row__name {
  color: var(--m3-on-surface);
}

.bound-row__sub {
  color: var(--m3-on-surface-variant);
}

.bound-empty {
  margin: 0;
  padding: 16px;
  color: var(--m3-on-surface-variant);
  text-align: center;
}

/* 首綁逾時：表單整段換成提示框 + 重新登入（warning：不是輸入錯，重新登入即可） */
.bind-timeout {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.bind-timeout__box {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-warning-container);
  color: var(--m3-on-warning-container);
}

.bind-timeout__box p {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

/* 首綁成功：內容 + 固定在底部的「開始使用」 */
.bind-success {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
}

.bind-success__content {
  flex: 1;
  padding: 0 16px 24px;
}

.success-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 32px 0 24px;
  text-align: center;
}

.success-head__icon {
  color: var(--m3-primary);
}

.success-head h1 {
  margin: 0;
  color: var(--m3-on-surface);
}

.success-head p {
  margin: 0;
  color: var(--m3-on-surface-variant);
  overflow-wrap: anywhere;
}

.bind-footer {
  position: sticky;
  bottom: 0;
  flex: none;
  padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--m3-outline-variant);
  background: var(--m3-surface);
}
</style>
