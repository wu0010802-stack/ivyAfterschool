<script setup lang="ts">
/**
 * 家長端接送頁（路由 `/pickup`）：我要來接 / 我已經到了 / 我到了 / 取消 / 已接走。
 * 移植 ivy PickupNoticeView 的送出、「已抵達」捷徑、抵達確認（含不再提醒）、取消確認與回到前景重抓；
 * 去掉滾輪、備註、client_request_id、30 秒輪詢與子女 tab 列（改用 ChildContextHeader）。
 *
 * - 今日接送請求是全部小孩共用（PARENT-093 store，ws 即時套用）；切換小孩只重抓小孩詳情（can_pickup）與作業。
 * - can_pickup 依小孩 id 保留：第一次取得前主區顯示骨架；詳情載入失敗（未知）照常顯示表單，由後端 403 把關。
 * - 沒有下拉重新整理：即時性由 ws、visibilitychange 與 parentWs 斷線輪詢負責。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { PICKUP_REQUEST_STATUS_META, statusMeta } from '@/shared/constants/statusLabels'
import { isApiError } from '@/shared/types/api'
import { formatTime } from '@/shared/utils/datetime'
import { getChild } from '../api/children'
import type { ParentPickupRequest } from '../api/pickupRequests'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import M3Button from '../components/m3/M3Button.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import M3ListItem from '../components/m3/M3ListItem.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import ArrivalTimePicker from '../components/pickup/ArrivalTimePicker.vue'
import PickupProgressSteps from '../components/pickup/PickupProgressSteps.vue'
import PickupReplyMessage from '../components/pickup/PickupReplyMessage.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import StatusPill from '../components/StatusPill.vue'
import { useArriveNow } from '../composables/useArriveNow'
import { useChildrenStore } from '../stores/children'
import { useHomeworkTodayStore } from '../stores/homeworkToday'
import { usePickupRequestsStore } from '../stores/pickupRequests'
import { useSnackbarStore } from '../stores/snackbar'

/** 「通知安親班」的這些錯誤在表單卡內顯示後端 error.message 原文 */
const FORM_ERROR_CODES: ReadonlySet<string> = new Set([
  'pickup_window_closed',
  'student_not_available',
  'not_service_day',
  'expected_arrival_in_past',
  'expected_arrival_too_late',
  'student_not_active',
])
/** 以 snackbar 呈現的寫入錯誤；store 已先同步的錯誤碼（exists / invalid / not_found）畫面隨之重畫 */
const SNACK_ERRORS: Readonly<Record<string, string>> = {
  pickup_request_exists: '今天已有接送請求，已更新狀態',
  invalid_pickup_status: '狀態已更新，請確認後再操作',
  pickup_request_not_found: '找不到這筆接送請求，已重新整理',
  pickup_not_allowed: '您沒有這位小孩的接送權限',
}
/** 取消遇到這些錯誤：store 已同步，關閉對話框 */
const CANCEL_SYNCED_CODES: ReadonlySet<string> = new Set(['pickup_request_not_found', 'invalid_pickup_status'])
const FALLBACK_ERROR = '送出失敗，請稍後再試'

type MainState = 'loading' | 'error' | 'children-error' | 'no-children' | 'open' | 'no-permission' | 'form'

const router = useRouter()
const children = useChildrenStore()
const pickupRequests = usePickupRequestsStore()
const homeworkToday = useHomeworkTodayStore()
const snackbar = useSnackbarStore()
const { confirmOpen, skipNextTime, busy: arriveBusy, lastResult, request: requestArrive, confirm: confirmArrive, dismiss } =
  useArriveNow()

// 只有清單裡確實有的小孩才是操作對象：清單回來前 localStorage 殘留的舊 id 不打 API
const childId = computed(() => (children.selectedChild ? children.selectedId : null))

const childrenState = computed<'loading' | 'error' | 'empty' | 'ready'>(() => {
  if (children.items.length > 0) return 'ready'
  if (children.loading) return 'loading'
  if (children.error) return 'error'
  return children.loaded ? 'empty' : 'loading'
})

// ---- 小孩詳情（my_guardian.can_pickup）：依 id 保留；null = 載入失敗、未知 ----
const canPickupById = ref<Record<string, boolean | null>>({})
// 同一位小孩重抓時只採用最新一次的回應
const detailSeq = new Map<string, number>()

async function loadDetail(id: string): Promise<void> {
  const seq = (detailSeq.get(id) ?? 0) + 1
  detailSeq.set(id, seq)
  try {
    const detail = await getChild(id)
    if (detailSeq.get(id) === seq) canPickupById.value[id] = detail.my_guardian.can_pickup
  } catch {
    // 已知的結果保留；第一次就失敗 → 未知（照常顯示表單）
    if (detailSeq.get(id) === seq && !(id in canPickupById.value)) canPickupById.value[id] = null
  }
}

// ---- 今日請求 ----
const openRequest = computed(() => (childId.value ? pickupRequests.openFor(childId.value) : null))
const latestRequest = computed(() => (childId.value ? pickupRequests.latestFor(childId.value) : null))
const history = computed(() => (childId.value ? pickupRequests.historyFor(childId.value) : []))
const doneRequest = computed(() =>
  !openRequest.value && latestRequest.value?.status === 'completed' ? latestRequest.value : null,
)
const openMeta = computed(() => statusMeta(PICKUP_REQUEST_STATUS_META, openRequest.value?.status))

const mainState = computed<MainState>(() => {
  const id = childId.value
  if (id === null) {
    if (childrenState.value === 'error') return 'children-error'
    if (childrenState.value === 'empty') return 'no-children'
    return 'loading'
  }
  const requestsLoading = !pickupRequests.loaded && !pickupRequests.error
  if (requestsLoading || !(id in canPickupById.value)) return 'loading'
  // 已有資料時背景重抓失敗不提示
  if (!pickupRequests.loaded) return 'error'
  if (openRequest.value) return 'open'
  if (canPickupById.value[id] === false) return 'no-permission'
  return 'form'
})

const showHistory = computed(
  () => ['open', 'no-permission', 'form'].includes(mainState.value) && history.value.length > 0,
)

// ---- 作業提示列 ----
const homeworkHint = computed<{ done: boolean; text: string } | null>(() => {
  const hw = childId.value ? homeworkToday.get(childId.value) : null
  if (!hw) return null
  if (hw.overall_status === 'done') return { done: true, text: '作業已完成' }
  const total = hw.items.length
  const head = total > 0 ? `作業進度 ${hw.items.filter((i) => i.status === 'done').length}/${total}` : '今天尚無作業項目'
  return { done: false, text: hw.ready_eta ? `${head} · 預計 ${hw.ready_eta} 可接送` : head }
})

// ---- 表單 ----
const arrival = ref<string | null>(null)
const formError = ref('')
const formExpanded = ref(false)
const creating = computed(() => pickupRequests.pendingAction === 'create')

function resetForm(): void {
  arrival.value = null
  formError.value = ''
  formExpanded.value = false
}

async function submit(): Promise<void> {
  const id = childId.value
  if (id === null || creating.value || arriveBusy.value) return
  formError.value = ''
  try {
    await pickupRequests.create(id, arrival.value)
    snackbar.show('已通知安親班')
    resetForm()
  } catch (error) {
    onCreateError(error, id)
  }
}

function onCreateError(error: unknown, id: string): void {
  if (isApiError(error) && FORM_ERROR_CODES.has(error.code)) {
    // 送出期間換了小孩：錯誤屬於另一位小孩的表單，不顯示
    if (childId.value === id) formError.value = error.message
    return
  }
  const code = isApiError(error) ? error.code : ''
  snackbar.show(SNACK_ERRORS[code] ?? FALLBACK_ERROR, { tone: 'error' })
  if (code === 'pickup_not_allowed') void loadDetail(id)
}

// ---- 我已經到了 / 我到了（確認對話框與錯誤由 useArriveNow 處理）----
function arriveNow(): void {
  if (childId.value !== null) requestArrive(childId.value, null)
}

function markArrived(): void {
  if (childId.value !== null && openRequest.value) requestArrive(childId.value, openRequest.value.id)
}

watch(lastResult, (result) => {
  if (result) resetForm()
})

// ---- 取消接送 ----
const cancelOpen = ref(false)
const cancelLoading = ref(false)
let cancelTargetId: string | null = null

function openCancel(): void {
  cancelTargetId = openRequest.value?.id ?? null
  cancelOpen.value = cancelTargetId !== null
}

async function confirmCancel(): Promise<void> {
  const id = cancelTargetId
  if (id === null || cancelLoading.value) return
  cancelLoading.value = true
  try {
    await pickupRequests.cancel(id)
    cancelOpen.value = false
    resetForm()
    snackbar.show('已取消接送')
  } catch (error) {
    const code = isApiError(error) ? error.code : ''
    if (CANCEL_SYNCED_CODES.has(code)) {
      cancelOpen.value = false
      snackbar.show(SNACK_ERRORS[code] ?? FALLBACK_ERROR, { tone: 'error' })
    } else {
      // 對話框保持開啟，可再按或「先不要」
      snackbar.show(FALLBACK_ERROR, { tone: 'error' })
    }
  } finally {
    cancelLoading.value = false
  }
}

// ---- 顯示文字 ----
function completedText(r: ParentPickupRequest): string {
  return r.completed_at && r.picked_up_by_name ? `${formatTime(r.completed_at)} 已由 ${r.picked_up_by_name} 接走` : '今天已接走'
}

function historyText(r: ParentPickupRequest): string {
  if (r.status === 'completed') {
    if (!r.completed_at) return '已接走'
    const time = formatTime(r.completed_at)
    return r.picked_up_by_name ? `${time} 由 ${r.picked_up_by_name} 接走` : `${time} 接走`
  }
  if (r.status === 'cancelled') return r.cancelled_at ? `${formatTime(r.cancelled_at)} 取消` : '已取消'
  return '逾時自動結束'
}

function historyMeta(r: ParentPickupRequest) {
  return statusMeta(PICKUP_REQUEST_STATUS_META, r.status)
}

function go(path: string): void {
  void router.push(path)
}

// ---- 載入 ----
// 換小孩：表單重設，重抓小孩詳情與作業（今日請求共用、不重抓）；第一次選到的小孩作業不強制重抓
watch(
  childId,
  (id, prev) => {
    resetForm()
    if (id === null) return
    void loadDetail(id)
    void homeworkToday.load(id, { force: prev !== undefined && prev !== null })
  },
  { immediate: true },
)

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void pickupRequests.load(true)
}

onMounted(() => {
  void children.load()
  void pickupRequests.load(true)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
})
</script>

<template>
  <div class="pickup-view">
    <div class="pk-head">
      <SkeletonBlock
        v-if="childrenState === 'loading'"
        variant="row"
        height="80px"
        class="pk-cch-skeleton"
      />
      <ChildContextHeader
        v-else
        :children="children.items"
        :selected-id="children.selectedId"
        @select="children.select"
      />
    </div>

    <div
      v-if="homeworkHint"
      class="hw-hint m3-body-medium"
    >
      <M3Icon
        :name="homeworkHint.done ? 'check_circle' : 'assignment'"
        :size="20"
        :filled="homeworkHint.done"
        :class="{ 'hw-hint__done': homeworkHint.done }"
      />
      <span class="hw-hint__text">{{ homeworkHint.text }}</span>
    </div>

    <div class="pk-main">
      <SkeletonBlock
        v-if="mainState === 'loading'"
        variant="card"
        :count="2"
      />
      <ParentEmptyState
        v-else-if="mainState === 'error'"
        variant="error"
        title="接送狀態載入失敗"
        description="請檢查網路連線後再試一次"
        @action="pickupRequests.load(true)"
      />
      <ParentEmptyState
        v-else-if="mainState === 'children-error'"
        variant="error"
        title="小孩清單載入失敗"
        description="請檢查網路連線後再試一次"
        @action="children.load(true)"
      />
      <ParentEmptyState
        v-else-if="mainState === 'no-children'"
        icon="link"
        title="尚未綁定小孩"
        description="請輸入安親班提供的綁定碼"
        action-label="輸入綁定碼"
        @action="go('/bind')"
      />
      <template v-else-if="mainState === 'open' && openRequest">
        <M3Card
          variant="elevated"
          class="pk-req"
        >
          <div class="pk-req__head">
            <h2 class="pk-card-title m3-title-medium">
              今天的接送
            </h2>
            <StatusPill
              :label="openMeta.label"
              :tone="openMeta.tone"
            />
          </div>
          <PickupReplyMessage :request="openRequest" />
          <p
            v-if="openRequest.expected_arrival_at"
            class="pk-req__expected m3-body-medium"
          >
            <M3Icon
              name="schedule"
              :size="18"
            />您預計 {{ openRequest.expected_arrival_at }} 抵達
          </p>
          <M3Button
            v-if="openRequest.can_mark_arrived"
            class="pk-req__arrive"
            block
            icon="where_to_vote"
            :loading="arriveBusy"
            @click="markArrived"
          >
            我到了
          </M3Button>
        </M3Card>
        <M3Card variant="outlined">
          <PickupProgressSteps :request="openRequest" />
          <div
            v-if="openRequest.can_cancel"
            class="pk-steps__actions"
          >
            <M3Button
              variant="text"
              icon="close"
              :disabled="arriveBusy"
              @click="openCancel"
            >
              取消接送
            </M3Button>
          </div>
        </M3Card>
      </template>
      <ParentEmptyState
        v-else-if="mainState === 'no-permission'"
        icon="block"
        title="您沒有這位小孩的接送權限"
        description="如需接送請聯絡安親班"
      />
      <template v-else>
        <div
          v-if="doneRequest"
          class="pk-done"
          role="status"
        >
          <M3Icon
            name="check_circle"
            :size="32"
            filled
          />
          <div class="pk-done__text">
            <p class="pk-done__title m3-title-medium">
              {{ completedText(doneRequest) }}
            </p>
            <p class="m3-body-medium">
              今天的接送已完成
            </p>
          </div>
        </div>
        <button
          v-if="doneRequest && !formExpanded"
          type="button"
          class="pk-again m3-label-large"
          aria-expanded="false"
          @click="formExpanded = true"
        >
          需要再次接送？<M3Icon
            name="expand_more"
            :size="18"
          />
        </button>
        <template v-else>
          <M3Card class="pk-form">
            <template #header>
              <h2 class="pk-card-title m3-title-medium">
                我要來接
              </h2>
              <p class="pk-form__sub m3-body-medium">
                通知老師您正在路上，系統會立即回覆預計可接送時間
              </p>
            </template>
            <ArrivalTimePicker v-model="arrival" />
            <div
              v-if="formError"
              class="form-error m3-body-medium"
              role="alert"
            >
              <M3Icon
                name="error"
                :size="20"
                filled
              />
              <span class="form-error__text">{{ formError }}</span>
            </div>
            <M3Button
              class="pk-form__submit"
              block
              icon="send"
              :loading="creating"
              :disabled="arriveBusy"
              @click="submit"
            >
              通知安親班
            </M3Button>
          </M3Card>
          <div
            class="pk-or m3-label-medium"
            aria-hidden="true"
          >
            或
          </div>
          <M3Button
            variant="outlined"
            block
            icon="where_to_vote"
            :loading="arriveBusy"
            :disabled="creating"
            @click="arriveNow"
          >
            我已經到了
          </M3Button>
          <p class="pk-arrive-hint m3-body-small">
            人已在安親班門口時使用，不必先通知
          </p>
        </template>
      </template>
    </div>

    <template v-if="showHistory">
      <h2 class="pk-section m3-label-large">
        今日紀錄
      </h2>
      <M3Card
        variant="outlined"
        padding="none"
      >
        <ul
          class="pk-history"
          role="list"
          aria-label="今日接送紀錄"
        >
          <li
            v-for="r in history"
            :key="r.id"
            class="pk-history__row"
          >
            <StatusPill
              :label="historyMeta(r).label"
              :tone="historyMeta(r).tone"
            />
            <span class="pk-history__text m3-body-medium">{{ historyText(r) }}</span>
            <span class="pk-history__time m3-body-small">{{ formatTime(r.created_at) }} 發起</span>
          </li>
        </ul>
      </M3Card>
    </template>

    <M3Card
      variant="outlined"
      padding="none"
      class="pk-proxy"
    >
      <ul
        class="pk-proxy__list"
        role="list"
      >
        <M3ListItem
          headline="代理接送與常用接送人"
          supporting-text="由親友代接時，先建立代理接送與接送碼"
          leading-icon="badge"
          trailing-icon="chevron_right"
          to="/pickup/proxy"
        />
      </ul>
    </M3Card>

    <ConfirmDialog
      :open="confirmOpen"
      title="確認已抵達安親班？"
      message="老師會收到通知並準備帶孩子出來"
      confirm-label="我到了"
      @confirm="confirmArrive"
      @cancel="dismiss"
    >
      <label class="check-row m3-body-large"><input
        v-model="skipNextTime"
        type="checkbox"
      >下次不再提醒</label>
    </ConfirmDialog>
    <ConfirmDialog
      :open="cancelOpen"
      title="取消這次接送？"
      confirm-label="確定取消"
      cancel-label="先不要"
      destructive
      :loading="cancelLoading"
      @confirm="confirmCancel"
      @cancel="cancelOpen = false"
    />
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、底 24px 內距（ParentLayout 不加），上方 8px 由 .pk-head 補 */
.pickup-view {
  padding: 0 16px 24px;
}

.pk-head {
  padding-top: 8px;
}

/* 同身分卡外框：圓角 16px、surface-container-low */
.pk-cch-skeleton {
  border-radius: var(--m3-shape-large);
  background: var(--m3-surface-container-low);
  overflow: hidden;
}

/* 作業提示列：純資訊、不可點 */
.hw-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: var(--m3-shape-small);
  background: var(--m3-surface-container);
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.hw-hint__done {
  color: var(--m3-primary);
}

/* 主區：依狀態放骨架 / 載入失敗 / 進行中 / 無權限 / 表單 */
.pk-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}

.pk-card-title {
  margin: 0;
}

/* 表單卡 */
.pk-form__sub {
  margin: 4px 0 0;
  color: var(--m3-on-surface-variant);
}

.form-error {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin-top: 12px;
  color: var(--m3-error);
}

.pk-form__submit {
  margin-top: 16px;
}

.pk-or {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--m3-on-surface-variant);
}

.pk-or::before,
.pk-or::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--m3-outline-variant);
}

.pk-arrive-hint {
  margin: -4px 0 0;
  text-align: center;
  color: var(--m3-on-surface-variant);
}

/* 進行中：請求卡 + 進度卡 */
.pk-req__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.pk-req__expected {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.pk-req__arrive {
  margin-top: 16px;
}

.pk-steps__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--m3-outline-variant);
}

/* 已接走成功卡 */
.pk-done {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-primary-container);
  color: var(--m3-on-primary-container);
}

.pk-done__text {
  flex: 1;
  min-width: 0;
}

.pk-done__text p {
  margin: 0;
}

.pk-done__title {
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.pk-again {
  position: relative;
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 48px;
  padding: 0 16px;
  border: none;
  border-radius: var(--m3-shape-full);
  background: transparent;
  color: var(--m3-primary);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.pk-again:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: 2px;
}

/* M3 state layer */
.pk-again::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: currentcolor;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.pk-again:hover::before {
  opacity: var(--m3-state-hover);
}

.pk-again:focus-visible::before {
  opacity: var(--m3-state-focus);
}

.pk-again:active::before {
  opacity: var(--m3-state-pressed);
}

/* 今日紀錄 */
.pk-section {
  margin: 24px 4px 8px;
  color: var(--m3-on-surface-variant);
}

.pk-history {
  margin: 0;
  padding: 0;
  list-style: none;
}

.pk-history__row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 8px 16px;
}

.pk-history__row + .pk-history__row {
  border-top: 1px solid var(--m3-outline-variant);
}

.pk-history__text {
  flex: 1;
  min-width: 0;
  color: var(--m3-on-surface);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.pk-history__time {
  flex: none;
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

/* 代理接送入口 */
.pk-proxy {
  margin-top: 24px;
  overflow: hidden;
}

.pk-proxy__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* ConfirmDialog default slot：「下次不再提醒」整列 48px 可點 */
.check-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.check-row input {
  flex: none;
  width: 18px;
  height: 18px;
  margin: 0 3px;
  accent-color: var(--m3-primary);
  cursor: pointer;
}

.check-row input:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: 4px;
}
</style>
