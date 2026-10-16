<script setup lang="ts">
/**
 * 代理接送（/pickup/proxy）：代理接送授權（建立 / 重新產生接送碼 / 取消）與常用接送人（新增 / 刪除）。
 * 移植 ivy FE:src/parent/views/PickupView.vue::askRegenerate / doCancel / submitPerson 與
 * FE:src/parent/views/PickupCreateView.vue 建立後顯示碼的流程，合併為單頁 + bottom sheet；
 * 去掉編輯接送人、跨小孩授權列表、一次多孩授權。
 *
 * - 兩區依 children.selectedId 並行載入，各自以序號丟棄過期回應、各自失敗與重試；切換小孩回到骨架並收合「過去的授權」。
 * - 接送碼明碼只存在本元件的區域 ref（不進 store、不寫 storage、不出現在 URL），按「我已記下」即清除；
 *   接送碼 sheet 開著時離開頁面先確認（onBeforeRouteLeave，以 pending promise 保留原本的導覽型別，例如瀏覽器返回）。
 * - 錯誤一律 error snackbar，表單 sheet 保持開啟並保留輸入；不自動重試。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { isApiError } from '@/shared/types/api'
import { formatDateWithWeekday, todayTaipei } from '@/shared/utils/datetime'
import { DEFAULT_PARENT_LIMITS, getParentLimits, type ParentLimits } from '../api/config'
import {
  cancelPickupAuthorization,
  createPickupAuthorization,
  listPickupAuthorizations,
  regeneratePickupCode,
  type AuthorizationCreateInput,
  type AuthorizationWithCode,
  type ParentAuthorization,
} from '../api/pickupAuthorizations'
import { createPickupPerson, deletePickupPerson, listPickupPersons, type PickupPerson } from '../api/pickupPersons'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import M3Button from '../components/m3/M3Button.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import ParentBottomSheet from '../components/ParentBottomSheet.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import AuthorizationForm from '../components/pickup/AuthorizationForm.vue'
import AuthorizationListItem from '../components/pickup/AuthorizationListItem.vue'
import PickupCodeCard from '../components/pickup/PickupCodeCard.vue'
import PickupPersonForm, { type PickupPersonInput } from '../components/pickup/PickupPersonForm.vue'
import PickupPersonListItem from '../components/pickup/PickupPersonListItem.vue'
import PullToRefresh from '../components/PullToRefresh.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'

type SectionState = 'loading' | 'ready' | 'error'

interface ShownCode {
  value: string
  proxyName: string
  serviceDate: string
}

type PendingDialog =
  | { kind: 'delete'; person: PickupPerson }
  | { kind: 'regenerate' | 'cancel'; authorization: ParentAuthorization }

const FALLBACK_ERROR = '操作失敗，請稍後再試'
const REFRESH_ERROR = '更新失敗，請稍後再試'
const PERSON_GONE = '接送人已不存在'
const AUTHORIZATION_GONE = '這筆授權已失效'
const AUTHORIZATION_GONE_CODES = new Set(['authorization_not_active', 'authorization_expired'])

const children = useChildrenStore()
const snackbar = useSnackbarStore()
const pastId = useId()

const limits = ref<ParentLimits>(DEFAULT_PARENT_LIMITS)
const today = ref(todayTaipei())

const persons = ref<PickupPerson[]>([])
const personState = ref<SectionState>('loading')
const authorizations = ref<ParentAuthorization[]>([])
const authState = ref<SectionState>('loading')
const pastOpen = ref(false)

// 每次載入遞增；序號不符的回應（切換小孩、重新整理後）一律丟棄
let personSeq = 0
let authSeq = 0

const childName = computed(() => children.selectedChild?.name ?? '')
const childInitial = computed(() => Array.from(childName.value)[0] ?? '')

/** 沒有選中的小孩時依小孩清單狀態顯示：載入中骨架、載入失敗錯誤、沒有小孩視為空 */
function sectionView(state: SectionState): SectionState {
  if (children.selectedId === null) {
    if (children.error && !children.loaded) return 'error'
    return children.loaded ? 'ready' : 'loading'
  }
  return state
}

const personView = computed(() => sectionView(personState.value))
const authView = computed(() => sectionView(authState.value))

const activeAuthorizations = computed(() =>
  authorizations.value
    .filter((a) => a.effective_status === 'active')
    .sort((a, b) => a.service_date.localeCompare(b.service_date) || a.created_at.localeCompare(b.created_at)),
)
const pastAuthorizations = computed(() => authorizations.value.filter((a) => a.effective_status !== 'active'))
const atPersonLimit = computed(() => persons.value.length >= limits.value.persons_max)

/** 首次載入 / 重試：回到骨架；silent（下拉重新整理、操作後重抓）保留現有內容，失敗回傳 false */
async function loadPersons({ silent = false }: { silent?: boolean } = {}): Promise<boolean> {
  const childId = children.selectedId
  const seq = ++personSeq
  if (!silent) {
    personState.value = 'loading'
    persons.value = []
  }
  if (childId === null) return true
  try {
    const list = await listPickupPersons(childId)
    if (seq === personSeq) {
      persons.value = list
      personState.value = 'ready'
    }
    return true
  } catch {
    // 靜默重抓失敗：已有內容就保留；還在骨架（首次載入被取代）則改顯示錯誤
    if (seq === personSeq && (!silent || personState.value === 'loading')) personState.value = 'error'
    return false
  }
}

async function loadAuthorizations({ silent = false }: { silent?: boolean } = {}): Promise<boolean> {
  const childId = children.selectedId
  const seq = ++authSeq
  if (!silent) {
    authState.value = 'loading'
    authorizations.value = []
  }
  if (childId === null) return true
  try {
    const list = await listPickupAuthorizations(childId)
    if (seq === authSeq) {
      authorizations.value = list
      authState.value = 'ready'
    }
    return true
  } catch {
    if (seq === authSeq && (!silent || authState.value === 'loading')) authState.value = 'error'
    return false
  }
}

function retryPersons(): void {
  if (children.selectedId === null) void children.load(true)
  else void loadPersons()
}

function retryAuthorizations(): void {
  if (children.selectedId === null) void children.load(true)
  else void loadAuthorizations()
}

/** 下拉重新整理：兩區並行重抓、保留現有內容，任一失敗提示一次 */
async function refreshAll(): Promise<void> {
  if (children.selectedId === null) return
  today.value = todayTaipei()
  const results = await Promise.all([loadAuthorizations({ silent: true }), loadPersons({ silent: true })])
  if (results.includes(false)) snackbar.show(REFRESH_ERROR, { tone: 'error' })
}

function upsertAuthorization(updated: ParentAuthorization): void {
  const exists = authorizations.value.some((a) => a.id === updated.id)
  authorizations.value = exists
    ? authorizations.value.map((a) => (a.id === updated.id ? updated : a))
    : [updated, ...authorizations.value]
}

/** 後端 envelope 的訊息；網路錯誤、逾時、沒有 envelope 的 HTTP 錯誤一律通用訊息 */
function backendMessage(error: unknown): string {
  if (isApiError(error) && error.status > 0 && !error.code.startsWith('http_') && error.message.trim()) {
    return error.message
  }
  return FALLBACK_ERROR
}

function showError(message: string): void {
  snackbar.show(message, { tone: 'error' })
}

// ---- 接送碼（只存在這裡） ----
const code = shallowRef<ShownCode | null>(null)

function showCode(result: AuthorizationWithCode): void {
  code.value = {
    value: result.code,
    proxyName: result.authorization.proxy_name,
    serviceDate: result.authorization.service_date,
  }
}

function onCodeDone(): void {
  code.value = null
  void loadAuthorizations({ silent: true })
}

// ---- 新增代理接送 ----
const authFormOpen = ref(false)
const authFormKey = ref(0)
const authSubmitting = ref(false)

function openAuthForm(): void {
  if (children.selectedId === null) return
  today.value = todayTaipei()
  authFormKey.value += 1
  authFormOpen.value = true
}

function createAuthorizationError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'authorization_limit_reached') return '這一天的代理接送已達上限'
    if (error.code === 'invalid_service_date') return `日期需在今天起 ${limits.value.authorization_max_days_ahead} 天內`
    if (error.code === 'pickup_person_not_found') return PERSON_GONE
  }
  return backendMessage(error)
}

async function submitAuthorization(input: AuthorizationCreateInput): Promise<void> {
  const childId = children.selectedId
  if (childId === null || authSubmitting.value) return
  authSubmitting.value = true
  try {
    const result = await createPickupAuthorization(childId, input)
    authFormOpen.value = false
    if (children.selectedId === childId) upsertAuthorization(result.authorization)
    showCode(result)
  } catch (error) {
    showError(createAuthorizationError(error))
    // 表單會清掉已不存在的選取
    if (isApiError(error) && error.code === 'pickup_person_not_found') void loadPersons({ silent: true })
  } finally {
    authSubmitting.value = false
  }
}

// ---- 新增接送人 ----
const personFormOpen = ref(false)
const personFormKey = ref(0)
const personSubmitting = ref(false)

function openPersonForm(): void {
  if (children.selectedId === null || atPersonLimit.value) return
  personFormKey.value += 1
  personFormOpen.value = true
}

function createPersonError(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'pickup_person_limit_reached') return `常用接送人最多 ${limits.value.persons_max} 位`
    if (error.status === 413) return '照片檔案過大'
    if (error.status === 415) return '照片格式不支援，請使用 JPG、PNG、WEBP 或 HEIC'
    if (error.code === 'storage_unavailable') return '照片上傳失敗，請稍後再試'
  }
  return backendMessage(error)
}

async function submitPerson(input: PickupPersonInput): Promise<void> {
  const childId = children.selectedId
  if (childId === null || personSubmitting.value) return
  personSubmitting.value = true
  try {
    await createPickupPerson(childId, input)
    personFormOpen.value = false
    snackbar.show('已新增接送人')
    if (children.selectedId === childId) void loadPersons({ silent: true })
  } catch (error) {
    showError(createPersonError(error))
  } finally {
    personSubmitting.value = false
  }
}

// ---- 確認對話框：刪除接送人 / 重新產生 / 取消授權 ----
const dialog = shallowRef<PendingDialog | null>(null)
const dialogBusy = ref(false)

const dialogTarget = computed(() => {
  const d = dialog.value
  if (!d || d.kind === 'delete') return ''
  return `${d.authorization.proxy_name} · ${formatDateWithWeekday(d.authorization.service_date)}`
})
const deleteTitle = computed(() => (dialog.value?.kind === 'delete' ? `刪除 ${dialog.value.person.name}？` : ''))

function askDelete(person: PickupPerson): void {
  dialog.value = { kind: 'delete', person }
}

function askRegenerate(authorization: ParentAuthorization): void {
  dialog.value = { kind: 'regenerate', authorization }
}

function askCancel(authorization: ParentAuthorization): void {
  dialog.value = { kind: 'cancel', authorization }
}

function closeDialog(): void {
  if (!dialogBusy.value) dialog.value = null
}

async function confirmDelete(person: PickupPerson): Promise<void> {
  try {
    await deletePickupPerson(person.id)
    dialog.value = null
    persons.value = persons.value.filter((p) => p.id !== person.id)
    snackbar.show(`已刪除 ${person.name}`)
    void loadPersons({ silent: true })
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'pickup_person_not_found')) {
      dialog.value = null
      showError(PERSON_GONE)
      void loadPersons({ silent: true })
      return
    }
    // 其他錯誤保留對話框，可直接再按一次
    showError(backendMessage(error))
  }
}

/** 授權已失效：關閉對話框並重抓授權；回傳是否已處理 */
function handleAuthorizationGone(error: unknown): boolean {
  if (!isApiError(error) || !AUTHORIZATION_GONE_CODES.has(error.code)) return false
  dialog.value = null
  showError(AUTHORIZATION_GONE)
  void loadAuthorizations({ silent: true })
  return true
}

async function confirmRegenerate(authorization: ParentAuthorization): Promise<void> {
  try {
    const result = await regeneratePickupCode(authorization.id)
    dialog.value = null
    upsertAuthorization(result.authorization)
    showCode(result)
  } catch (error) {
    if (!handleAuthorizationGone(error)) showError(backendMessage(error))
  }
}

async function confirmCancel(authorization: ParentAuthorization): Promise<void> {
  try {
    const updated = await cancelPickupAuthorization(authorization.id)
    dialog.value = null
    upsertAuthorization(updated)
    snackbar.show('已取消代理接送')
  } catch (error) {
    if (!handleAuthorizationGone(error)) showError(backendMessage(error))
  }
}

async function confirmDialog(): Promise<void> {
  const d = dialog.value
  if (!d || dialogBusy.value) return
  dialogBusy.value = true
  try {
    if (d.kind === 'delete') await confirmDelete(d.person)
    else if (d.kind === 'regenerate') await confirmRegenerate(d.authorization)
    else await confirmCancel(d.authorization)
  } finally {
    dialogBusy.value = false
  }
}

// ---- 接送碼開著時離開頁面 ----
const leaveOpen = ref(false)
let resolveLeave: ((allow: boolean) => void) | null = null

function settleLeave(allow: boolean): void {
  const resolve = resolveLeave
  resolveLeave = null
  leaveOpen.value = false
  if (allow) code.value = null
  resolve?.(allow)
}

onBeforeRouteLeave(() => {
  if (code.value === null) return true
  // 前一次詢問尚未回答又有新的導覽：舊的視同留下
  resolveLeave?.(false)
  leaveOpen.value = true
  return new Promise<boolean>((resolve) => {
    resolveLeave = resolve
  })
})

onBeforeUnmount(() => {
  resolveLeave?.(false)
  resolveLeave = null
})

watch(
  () => children.selectedId,
  () => {
    pastOpen.value = false
    void loadPersons()
    void loadAuthorizations()
  },
  { immediate: true },
)

onMounted(() => {
  void children.load()
  void getParentLimits().then((value) => {
    limits.value = value
  })
})
</script>

<template>
  <div class="pickup-proxy-view">
    <PullToRefresh
      :on-refresh="refreshAll"
      :disabled="code !== null || authView === 'loading' || children.selectedId === null"
    >
      <div class="px">
        <ChildContextHeader
          v-if="children.items.length > 0"
          :children="children.items"
          :selected-id="children.selectedId"
          @select="children.select"
        />
        <SkeletonBlock
          v-else-if="!children.loaded && !children.error"
          variant="row"
          height="80px"
          class="px-cch-skeleton"
        />
        <M3Button
          icon="add"
          block
          :disabled="children.selectedId === null"
          @click="openAuthForm"
        >
          新增代理接送
        </M3Button>

        <!-- 代理接送授權 -->
        <div class="px-section">
          <h2 class="px-section__title m3-title-small">
            代理接送授權
          </h2>
          <span
            v-if="authView === 'ready' && activeAuthorizations.length > 0"
            class="px-section__aside m3-body-small"
          >有效 {{ activeAuthorizations.length }} 筆</span>
        </div>
        <M3Card
          variant="outlined"
          padding="none"
          class="px-card"
        >
          <SkeletonBlock
            v-if="authView === 'loading'"
            variant="row"
            :count="2"
            height="120px"
          />
          <ParentEmptyState
            v-else-if="authView === 'error'"
            variant="error"
            title="代理接送授權載入失敗"
            description="請檢查網路連線後再試一次"
            @action="retryAuthorizations"
          />
          <ul
            v-else-if="activeAuthorizations.length > 0"
            class="px-list"
            role="list"
            aria-label="有效的代理接送授權"
          >
            <AuthorizationListItem
              v-for="a in activeAuthorizations"
              :key="a.id"
              :authorization="a"
              @regenerate="askRegenerate"
              @cancel="askCancel"
            />
          </ul>
          <ParentEmptyState
            v-else
            icon="badge"
            title="目前沒有代理接送授權"
            description="由親友代接時，按「新增代理接送」取得接送碼"
          />
        </M3Card>
        <template v-if="authView === 'ready' && pastAuthorizations.length > 0">
          <button
            type="button"
            class="px-expander m3-label-large"
            :aria-expanded="pastOpen ? 'true' : 'false'"
            :aria-controls="pastId"
            @click="pastOpen = !pastOpen"
          >
            <span class="px-expander__label">過去的授權（{{ pastAuthorizations.length }}）</span>
            <M3Icon
              class="px-expander__icon"
              name="expand_more"
            />
          </button>
          <M3Card
            v-if="pastOpen"
            :id="pastId"
            variant="outlined"
            padding="none"
            class="px-card"
          >
            <ul
              class="px-list"
              role="list"
              aria-label="過去的代理接送授權"
            >
              <AuthorizationListItem
                v-for="a in pastAuthorizations"
                :key="a.id"
                :authorization="a"
              />
            </ul>
          </M3Card>
        </template>

        <!-- 常用接送人 -->
        <div class="px-section">
          <h2 class="px-section__title m3-title-small">
            常用接送人
          </h2>
          <span
            v-if="personView === 'ready'"
            class="px-section__aside m3-body-small"
          >{{ persons.length }}/{{ limits.persons_max }}</span>
        </div>
        <M3Card
          variant="outlined"
          padding="none"
          class="px-card"
        >
          <SkeletonBlock
            v-if="personView === 'loading'"
            variant="row"
            :count="2"
          />
          <ParentEmptyState
            v-else-if="personView === 'error'"
            variant="error"
            title="常用接送人載入失敗"
            description="請檢查網路連線後再試一次"
            @action="retryPersons"
          />
          <ul
            v-else-if="persons.length > 0"
            class="px-list"
            role="list"
            aria-label="常用接送人"
          >
            <PickupPersonListItem
              v-for="p in persons"
              :key="p.id"
              :person="p"
              @delete="askDelete"
            />
          </ul>
          <ParentEmptyState
            v-else
            icon="group"
            title="尚未新增常用接送人"
            description="新增後可快速建立代理接送"
          />
        </M3Card>
        <M3Button
          variant="tonal"
          icon="person_add"
          block
          :disabled="personView !== 'ready' || children.selectedId === null || atPersonLimit"
          @click="openPersonForm"
        >
          新增接送人
        </M3Button>
        <p
          v-if="personView === 'ready' && atPersonLimit"
          class="px-limit m3-body-small"
        >
          最多 {{ limits.persons_max }} 位
        </p>
      </div>
    </PullToRefresh>

    <!-- 新增代理接送：送出中不可關閉 -->
    <ParentBottomSheet
      v-model="authFormOpen"
      title="新增代理接送"
      :dismissible="!authSubmitting"
    >
      <div class="px-form-for">
        <span
          class="px-form-for__avatar m3-label-large"
          aria-hidden="true"
        >{{ childInitial }}</span>
        <span class="m3-body-medium">為 {{ childName }} 建立代理接送</span>
      </div>
      <div class="px-form-wrap">
        <AuthorizationForm
          :key="authFormKey"
          :persons="persons"
          :submitting="authSubmitting"
          :today="today"
          :max-days-ahead="limits.authorization_max_days_ahead"
          @submit="submitAuthorization"
          @cancel="authFormOpen = false"
        />
      </div>
    </ParentBottomSheet>

    <!-- 新增接送人：送出中不可關閉 -->
    <ParentBottomSheet
      v-model="personFormOpen"
      title="新增接送人"
      :dismissible="!personSubmitting"
    >
      <div class="px-form-for">
        <span
          class="px-form-for__avatar m3-label-large"
          aria-hidden="true"
        >{{ childInitial }}</span>
        <span class="m3-body-medium">為 {{ childName }} 新增常用接送人</span>
      </div>
      <div class="px-form-wrap">
        <PickupPersonForm
          :key="personFormKey"
          :submitting="personSubmitting"
          @submit="submitPerson"
          @cancel="personFormOpen = false"
        />
      </div>
    </ParentBottomSheet>

    <!-- 接送碼：不可關閉，只能按「我已記下」 -->
    <ParentBottomSheet
      :model-value="code !== null"
      title="接送碼"
      :dismissible="false"
    >
      <PickupCodeCard
        v-if="code"
        :key="code.value"
        :code="code.value"
        :proxy-name="code.proxyName"
        :service-date="code.serviceDate"
        @done="onCodeDone"
      />
    </ParentBottomSheet>

    <ConfirmDialog
      :open="dialog?.kind === 'delete'"
      :title="deleteTitle"
      message="已建立的代理接送授權不受影響"
      confirm-label="刪除"
      destructive
      :loading="dialogBusy"
      @confirm="confirmDialog"
      @cancel="closeDialog"
    />
    <ConfirmDialog
      :open="dialog?.kind === 'regenerate'"
      title="重新產生接送碼？"
      message="舊的接送碼會立即失效，請把新碼重新傳給接送人"
      confirm-label="重新產生"
      :loading="dialogBusy"
      @confirm="confirmDialog"
      @cancel="closeDialog"
    >
      <p class="px-confirm-target m3-body-medium">
        {{ dialogTarget }}
      </p>
    </ConfirmDialog>
    <ConfirmDialog
      :open="dialog?.kind === 'cancel'"
      title="取消這筆代理接送？"
      message="接送碼會立即失效，代理人無法再用它接送"
      confirm-label="確定取消"
      cancel-label="先不要"
      destructive
      :loading="dialogBusy"
      @confirm="confirmDialog"
      @cancel="closeDialog"
    >
      <p class="px-confirm-target m3-body-medium">
        {{ dialogTarget }}
      </p>
    </ConfirmDialog>
    <!-- 疊在接送碼 sheet 之上（dialog 15 > sheet 10） -->
    <ConfirmDialog
      :open="leaveOpen"
      title="確定已記下接送碼？"
      message="離開後就無法再查看這組接送碼，遺失時只能重新產生"
      confirm-label="已記下，離開"
      cancel-label="留在這裡"
      @confirm="settleLeave(true)"
      @cancel="settleLeave(false)"
    />
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、上 8px、底部 24px 內距；放在 PullToRefresh 內層，下拉指示器才橫跨全寬（ParentLayout 不加） */
.px {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 16px 24px;
}

.px-section {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 12px 4px -4px;
}

.px-section__title {
  margin: 0;
  color: var(--m3-on-surface);
}

.px-section__aside {
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.px-card {
  overflow: hidden;
}

.px-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 同身分卡外框 */
.px-cch-skeleton {
  border-radius: var(--m3-shape-large);
  background: var(--m3-surface-container-low);
  overflow: hidden;
}

/* 「過去的授權」展開列：整列 48px 文字按鈕，右側 expand_more 展開時旋轉 */
.px-expander {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 48px;
  padding: 0 12px 0 4px;
  border: none;
  border-radius: var(--m3-shape-small);
  background: transparent;
  color: var(--m3-on-surface-variant);
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

/* state layer */
.px-expander::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--m3-on-surface);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.px-expander:hover::before {
  opacity: var(--m3-state-hover);
}

.px-expander:focus-visible::before {
  opacity: var(--m3-state-focus);
}

.px-expander:active::before {
  opacity: var(--m3-state-pressed);
}

.px-expander:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: 2px;
}

.px-expander__label {
  flex: 1;
  min-width: 0;
}

.px-expander__icon {
  transition: transform var(--m3-dur-short-4) var(--m3-easing-standard);
}

.px-expander[aria-expanded='true'] .px-expander__icon {
  transform: rotate(180deg);
}

.px-limit {
  margin: -4px 4px 0;
  color: var(--m3-on-surface-variant);
  text-align: center;
}

/* sheet 上方「為 {小孩} …」一列（同請假頁） */
.px-form-for {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  padding: 8px 12px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-surface-container);
  color: var(--m3-on-surface);
}

.px-form-for__avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--m3-shape-full);
  background: var(--m3-tertiary-container);
  color: var(--m3-on-tertiary-container);
}

/* 確認對話框說明下方的目標列（同請假頁） */
.px-confirm-target {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--m3-shape-small);
  background: var(--m3-surface-container-highest);
  color: var(--m3-on-surface);
}

/*
 * 兩個表單的按鈕列固定在 sheet 可視區底部（同請假頁 LeaveForm 的做法），初始畫面就看得到送出鈕，表單內容在它上方捲動。
 * sticky 的停靠位置會避開捲動容器（ParentBottomSheet 的內容區）的 padding，所以包住表單的元素與按鈕列都以
 * --sheet-body-pad（內容區底部內距 24px）往下補回去，按鈕列才會貼齊 sheet 底緣；z-index 高於 M3TextField 的浮動標籤（2）。
 * 只改定位與底色，按鈕排列（AuthorizationForm 的等寬 grid、PickupPersonForm 的 flex）照元件本身。不改元件介面。
 */
.px-form-wrap {
  --sheet-body-pad: 24px;

  margin-bottom: calc(-1 * var(--sheet-body-pad));
}

.px-form-wrap :deep(.af-actions),
.px-form-wrap :deep(.form-actions) {
  position: sticky;
  z-index: 3;
  bottom: calc(-1 * var(--sheet-body-pad));
  margin: 0 -24px;
  padding: 16px 24px calc(16px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--m3-outline-variant);
  background: var(--m3-surface-container-low);
}
</style>
