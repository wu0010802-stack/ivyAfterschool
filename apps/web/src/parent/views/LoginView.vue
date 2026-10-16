<script setup lang="ts">
/**
 * LIFF 登入頁（/login，public；稿 parent-page-login.html）。
 * 移植 ivy LoginView::startLogin 的狀態機（init / loading / choice / error）與 manualRetry；
 * 去掉 consent modal、device-login、staff session 偵測、clientEvents、品牌 composable。
 *
 * - LINE 內未登入自動 liff.login()、id_token 快過期或 invalid_id_token 第一次自動重登、按「重試」（forceFresh）
 *   都停在 init 畫面直到 LINE 轉址回來。
 * - query logged_out=1：掛載時不執行 startLogin，停在 choice（剛登出不自動再登入）。
 * - 成功：setParent / children.seed 後 replace 到 resolveSafeRedirect(redirect)；needs_binding：markBindPending 後到 /bind。
 * - 帳號停用 / 尚未設定 LINE 登入（重試無效）且 org_phone 有值 → 「聯絡安親班」撥號；撥號規則同 BindCodeErrorNotice。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isApiError } from '@/shared/types/api'
import { liffLogin } from '../api/auth'
import { getPublicConfig } from '../api/config'
import M3Button from '../components/m3/M3Button.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import {
  LiffNotConfiguredError,
  clearLiffTokenRefreshMarker,
  forceLiffReloginOnce,
  idTokenNeedsRefresh,
  initLiff,
  type LiffClient,
} from '../services/liff'
import { useChildrenStore } from '../stores/children'
import { useParentAuthStore } from '../stores/parentAuth'
import { isSafeRedirectPath, resolveSafeRedirect } from '../utils/safeRedirect'

type State = 'init' | 'loading' | 'choice' | 'error'

interface LoginError {
  message: string
  icon: string
  /** 重試無效的錯誤：顯示「聯絡安親班」 */
  contact: boolean
}

const GENERIC_LOGIN_ERROR = '登入失敗，請稍後再試'
// 第一個分機符號之後都不撥（同 BindCodeErrorNotice）
const EXTENSION_MARK = /#|轉|分機|ext|x/i

const route = useRoute()
const router = useRouter()
const parentAuth = useParentAuthStore()
const children = useChildrenStore()

const loggedOut = computed(() => route.query.logged_out !== undefined && route.query.logged_out !== null)

const state = ref<State>(loggedOut.value ? 'choice' : 'init')
const error = ref<LoginError | null>(null)
const choiceBusy = ref(false)

// 安親班識別（公開設定）
const brandLoading = ref(true)
const orgName = ref('')
const logoUrl = ref<string | null>(null)
const orgPhone = ref<string | null>(null)
const logoFailed = ref(false)

const brandName = computed(() => orgName.value.trim() || '家長端')
const brandInitial = computed(() => Array.from(brandName.value)[0] ?? '家')
/** 取不到設定或名稱空白時不顯示副標 */
const showSub = computed(() => orgName.value.trim() !== '')
const showLogo = computed(() => logoUrl.value !== null && logoUrl.value !== '' && !logoFailed.value)

const contactPhone = computed(() => {
  const phone = (orgPhone.value ?? '').trim()
  return error.value?.contact && phone !== '' ? phone : ''
})
const telHref = computed(() => {
  const main = (contactPhone.value.split(EXTENSION_MARK)[0] ?? '').trim()
  return `tel:${main.startsWith('+') ? '+' : ''}${main.replace(/\D/g, '')}`
})

async function loadBrand(): Promise<void> {
  try {
    const config = await getPublicConfig()
    orgName.value = config.org_name ?? ''
    logoUrl.value = config.logo_url
    orgPhone.value = config.org_phone
  } catch {
    // 取不到公開設定：退回「家長端」文字版
  } finally {
    brandLoading.value = false
  }
}

function showError(e: LoginError): void {
  error.value = e
  state.value = 'error'
}

function mapInitError(e: unknown): LoginError {
  if (e instanceof LiffNotConfiguredError) return { message: e.message, icon: 'settings', contact: true }
  return { message: 'LINE 登入初始化失敗，請稍後再試', icon: 'error', contact: false }
}

function mapLoginError(e: unknown): LoginError {
  if (!isApiError(e)) return { message: GENERIC_LOGIN_ERROR, icon: 'error', contact: false }
  switch (e.code) {
    case 'parent_disabled':
      return { message: '您的家長帳號已停用，請聯絡安親班', icon: 'block', contact: true }
    case 'line_unavailable':
      return { message: 'LINE 驗證服務暫時無法連線，請稍後再試', icon: 'cloud_off', contact: false }
    case 'line_login_not_configured':
      return { message: '安親班尚未設定 LINE 登入，請聯絡安親班', icon: 'settings', contact: true }
    case 'too_many_attempts':
      return { message: '嘗試次數過多，請稍後再試', icon: 'hourglass_top', contact: false }
    default:
      return { message: e.message || GENERIC_LOGIN_ERROR, icon: 'error', contact: false }
  }
}

/**
 * LINE 登入完成後轉址回來的網址：目前網址去掉 logged_out（hash 路由的 query 與一般 query 都去掉，redirect 等其餘保留）。
 * LINE 會把 redirectUri 原樣帶回；帶著 logged_out 回來會停在「您已登出」而不自動登入，形成迴圈。
 */
function loginRedirectUri(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete('logged_out')
  const queryStart = url.hash.indexOf('?')
  if (queryStart >= 0) {
    const params = new URLSearchParams(url.hash.slice(queryStart + 1))
    params.delete('logged_out')
    const rest = params.toString()
    url.hash = url.hash.slice(0, queryStart) + (rest ? `?${rest}` : '')
  }
  return url.toString()
}

function relogin(): boolean {
  return forceLiffReloginOnce({ redirectUri: loginRedirectUri(), nowMs: Date.now() })
}

async function completeLogin(liff: LiffClient): Promise<void> {
  const idToken = liff.getIDToken()
  if (!idToken) throw new Error('無法取得 LINE id_token')
  const result = await liffLogin(idToken)
  if (result.status === 'ok' && result.parent) {
    clearLiffTokenRefreshMarker()
    parentAuth.setParent(result.parent)
    children.seed(result.parent.children)
    await router.replace(resolveSafeRedirect(route.query.redirect))
    return
  }
  if (result.status === 'needs_binding') {
    parentAuth.markBindPending(result.name_hint)
    const redirect = route.query.redirect
    // 只把站內相對路徑帶給綁定頁；綁定頁消費時仍會再驗證
    await router.replace({ path: '/bind', query: isSafeRedirectPath(redirect) ? { redirect } : {} })
    return
  }
  throw new Error('伺服器回應未預期狀態')
}

async function startLogin({ forceFresh = false }: { forceFresh?: boolean } = {}): Promise<void> {
  state.value = 'init'
  error.value = null

  let liff: LiffClient
  try {
    liff = await initLiff()
  } catch (e) {
    showError(mapInitError(e))
    return
  }

  if (forceFresh) {
    // 使用者主動重試：清掉 marker 後強制走完整 OAuth，確保拿到新的 id_token
    clearLiffTokenRefreshMarker()
    relogin()
    return
  }

  if (!liff.isLoggedIn()) {
    // 只在 LINE App 內自動觸發 OAuth；外部瀏覽器停在 choice 讓家長自選
    if (liff.isInClient()) {
      liff.login({ redirectUri: loginRedirectUri() })
      return
    }
    state.value = 'choice'
    return
  }

  // id_token 快過期：同一輪只強制重登一次，已重登過就照常送後端
  if (idTokenNeedsRefresh(liff.getDecodedIDToken(), Math.floor(Date.now() / 1000)) && relogin()) return

  state.value = 'loading'
  try {
    await completeLogin(liff)
  } catch (e) {
    if (isApiError(e) && (e.code === 'invalid_id_token' || e.code === 'id_token_replayed')) {
      if (relogin()) {
        // 等 LINE 轉址回來：停在 init 畫面，不顯示錯誤
        state.value = 'init'
        return
      }
      showError({ message: 'LINE 登入已逾時，請關閉後重新開啟', icon: 'timer_off', contact: false })
      return
    }
    showError(mapLoginError(e))
  }
}

function retry(): void {
  void startLogin({ forceFresh: true })
}

/**
 * choice 狀態下使用者主動選 LINE 登入；按下後 loading 直到轉址。
 * LIFF 仍是登入狀態（例如剛登出、LINE 那邊沒登出）→ 直接走 startLogin 送 id_token（含快過期時的強制重登）；
 * 未登入 → liff.login，redirectUri 不帶 logged_out，LINE 轉址回來會自動登入。
 */
async function startLineLogin(): Promise<void> {
  if (choiceBusy.value) return
  choiceBusy.value = true
  let liff: LiffClient
  try {
    liff = await initLiff()
  } catch (e) {
    choiceBusy.value = false
    showError(mapInitError(e))
    return
  }
  if (liff.isLoggedIn()) {
    choiceBusy.value = false
    await startLogin()
    return
  }
  liff.login({ redirectUri: loginRedirectUri() })
}

onMounted(() => {
  void loadBrand()
  if (!loggedOut.value) void startLogin()
})
</script>

<template>
  <main class="login">
    <div class="login-brand">
      <template v-if="brandLoading">
        <SkeletonBlock
          class="login-brand__skeleton-logo"
          width="80px"
          height="80px"
        />
        <SkeletonBlock
          class="login-brand__skeleton-name"
          width="168px"
          height="28px"
        />
      </template>
      <template v-else>
        <img
          v-if="showLogo"
          class="login-brand__logo"
          :src="logoUrl ?? undefined"
          alt=""
          @error="logoFailed = true"
        >
        <span
          v-else
          class="login-brand__mark"
          aria-hidden="true"
        >{{ brandInitial }}</span>
        <h1 class="login-brand__name m3-headline-small">
          {{ brandName }}
        </h1>
        <p
          v-if="showSub"
          class="login-brand__sub m3-body-medium"
        >
          家長端
        </p>
      </template>
    </div>

    <div class="login-body">
      <div
        v-if="state === 'init' || state === 'loading'"
        class="login-status"
        role="status"
      >
        <span
          class="login-spinner"
          aria-hidden="true"
        />
        <p class="m3-body-large">
          {{ state === 'init' ? '正在連線 LINE…' : '登入中…' }}
        </p>
      </div>

      <div
        v-else-if="state === 'choice'"
        class="login-choice"
      >
        <p class="login-choice__title m3-title-medium">
          {{ loggedOut ? '您已登出' : '請使用 LINE 帳號登入' }}
        </p>
        <p class="login-choice__desc m3-body-medium">
          {{ loggedOut ? '需要時可再以 LINE 登入' : '登入後即可查看小孩的到班、作業與接送狀態' }}
        </p>
        <M3Button
          class="login-choice__button"
          block
          icon="login"
          :loading="choiceBusy"
          @click="startLineLogin"
        >
          使用 LINE 登入
        </M3Button>
      </div>

      <template v-else-if="error">
        <ParentEmptyState
          variant="error"
          :icon="error.icon"
          :title="error.message"
          @action="retry"
        />
        <a
          v-if="contactPhone"
          class="login-call m3-label-large"
          :href="telHref"
        >
          <M3Icon
            name="call"
            :size="18"
          />
          <span class="login-call__label">聯絡安親班 {{ contactPhone }}</span>
        </a>
      </template>
    </div>
  </main>
</template>

<style scoped>
.login {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 96px 16px 24px;
}

/* 識別區固定最小高：init → loading → choice / error 切換時不位移 */
.login-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  min-height: 160px;
  text-align: center;
}

.login-brand__logo,
.login-brand__mark {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 80px;
  height: 80px;
  border-radius: var(--m3-shape-full);
}

.login-brand__logo {
  object-fit: cover;
}

.login-brand__mark {
  background: var(--m3-primary-container);
  color: var(--m3-on-primary-container);
  font-size: 32px;
  font-weight: 500;
  line-height: 40px;
}

.login-brand__name {
  margin: 4px 0 0;
  color: var(--m3-on-surface);
  overflow-wrap: anywhere;
}

.login-brand__sub {
  margin: -8px 0 0;
  color: var(--m3-on-surface-variant);
}

.login-brand__skeleton-logo :deep(.sk) {
  border-radius: var(--m3-shape-full);
}

.login-brand__skeleton-name {
  margin-top: 4px;
}

.login-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 360px;
  min-height: 220px;
  margin-top: 32px;
}

.login-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding-top: 24px;
  color: var(--m3-on-surface-variant);
}

.login-status p {
  margin: 0;
}

.login-spinner {
  flex: none;
  width: 40px;
  height: 40px;
  border: 4px solid var(--m3-primary);
  border-right-color: transparent;
  border-radius: 50%;
  animation: login-spin 0.8s linear infinite;
}

@keyframes login-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  /* 停成靜止弧形 */
  .login-spinner {
    animation: none;
  }
}

/* 錯誤態放在狀態區內：收掉 ParentEmptyState 預設的大上下內距（稿 .login-body .empty-state） */
.login-body :deep(.empty-state) {
  padding-top: 8px;
  padding-bottom: 8px;
}

.login-choice {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 8px;
  text-align: center;
}

.login-choice p {
  margin: 0;
}

.login-choice__title {
  color: var(--m3-on-surface);
}

.login-choice__desc {
  color: var(--m3-on-surface-variant);
}

.login-choice__button {
  margin-top: 16px;
}

/* outlined 按鈕外觀的撥號連結 */
.login-call {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  align-self: center;
  box-sizing: border-box;
  max-width: 100%;
  min-height: 48px;
  padding: 8px 24px 8px 16px;
  border-radius: var(--m3-shape-full);
  box-shadow: inset 0 0 0 1px var(--m3-outline);
  color: var(--m3-primary);
  text-align: center;
  text-decoration: none;
  overflow-wrap: anywhere;
  -webkit-tap-highlight-color: transparent;
}

/* state layer：顏色取 currentColor */
.login-call::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: currentColor;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.login-call:hover::before {
  opacity: var(--m3-state-hover);
}

.login-call:active::before {
  opacity: var(--m3-state-pressed);
}

.login-call:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: 2px;
}
</style>
