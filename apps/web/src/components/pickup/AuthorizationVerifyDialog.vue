<script setup lang="ts">
// FRONTEND-201：代理接送核驗 dialog（domain_spec M7 流程 5：接送碼 / 目視核對 / pickup:override 強制完成；碼連錯 5 次鎖定不自動解鎖）。
// 設計稿：docs/mockups/page-pickup-authorizations.html（AuthorizationVerifyDialog 段）。
// 移植 ivy FE:src/views/PickupAuthorizationsView.vue 的 verify dialog（codeInput、onCodeEnter、remainingAttempts、
// overrideMode + overrideNote、successResult、開啟後聚焦輸入框）。
// - 接送碼：6 格（3 + 3）、inputmode numeric、可貼上整串（空白與「-」忽略）、自動跳格、Backspace 回上一格、開啟即聚焦第一格，
//   滿 6 碼自動送出。pickup_code_mismatch →「接送碼錯誤，還可嘗試 n 次」並清空重新聚焦；pickup_code_locked → 鎖定狀態。
// - 鎖定（authorization.locked 或回應 pickup_code_locked）：接送碼 / 目視核對分頁停用；canOverride 自動切到強制完成，
//   否則回到接送碼分頁、只剩「關閉」。開著時父層把同一張授權更新（收推播後重抓清單）：錯誤次數與鎖定以 props 為準，
//   轉鎖定同收到 pickup_code_locked、轉解鎖（家長重新產生接送碼）恢復分頁與送出鈕。
// - 成功：取代整個內容為成功畫面並 emit verified；其他錯誤（authorization_not_active / not_today）顯示後端 message、表單保留。
// - 開啟時的聚焦自己做（FormDialog 的 @opened 要等開啟動畫，這裡改在 modelValue 轉 true 的下一個 tick 聚焦）。
import { CircleCheckFilled, Document, Loading, Postcard } from '@element-plus/icons-vue'
import { computed, ref, watch, type ComponentPublicInstance } from 'vue'
import {
  confirmVisualMatch,
  overrideCompleteAuthorization,
  verifyPickupCode,
  type CodeMismatchDetails,
  type StaffAuthorization,
  type VerifyResult,
} from '@/api/pickupAuthorizations'
import FormDialog from '@/components/common/FormDialog.vue'
import { PICKUP_COMPLETION_METHOD_LABELS } from '@/shared/constants/statusLabels'
import { isApiError, type VerificationMethod } from '@/shared/types/api'
import { errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  modelValue: boolean
  authorization: StaffAuthorization
  /** 有 pickup:override 才有「主管強制完成」分頁 */
  canOverride: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  verified: [result: VerifyResult]
}>()

type Tab = 'code' | 'visual' | 'override'

/** 與後端一致：接送碼連續錯誤達此次數鎖定 */
const MAX_CODE_ATTEMPTS = 5
const CODE_LENGTH = 6
const NOTE_MAX_LENGTH = 200
const SUBMIT_TEXT: Record<Tab, string> = {
  code: '核驗接送碼',
  visual: '已核對，完成交付',
  override: '強制完成',
}

const emptyDigits = (): string[] => Array.from({ length: CODE_LENGTH }, () => '')

const tab = ref<Tab>('code')
const digits = ref<string[]>(emptyDigits())
const codeError = ref('')
const error = ref('')
const visualNote = ref('')
const overrideNote = ref('')
const overrideError = ref('')
const busy = ref(false)
const success = ref<{ result: VerifyResult; method: VerificationMethod } | null>(null)
/** 本次 dialog 內收到 pickup_code_locked */
const lockedByResponse = ref(false)
/** 本次 dialog 內因錯碼更新的次數（props 尚未經 ws 更新前先以回應為準） */
const localAttempts = ref<number | null>(null)
const photoBroken = ref(false)

const digitEls: (HTMLInputElement | null)[] = []
const overrideInput = ref<{ focus: () => void } | null>(null)

const locked = computed(() => props.authorization.locked || lockedByResponse.value)
const attempts = computed(() => localAttempts.value ?? props.authorization.code_attempts)
const codeComplete = computed(() => digits.value.every((d) => d !== ''))
const showPhoto = computed(() => !!props.authorization.photo_url && !photoBroken.value)

const attemptsText = computed(() => {
  if (locked.value) return `已錯誤 ${MAX_CODE_ATTEMPTS} 次，已鎖定`
  if (attempts.value > 0) return `已錯誤 ${attempts.value} 次，還可嘗試 ${MAX_CODE_ATTEMPTS - attempts.value} 次`
  return `尚無錯誤（連續錯誤 ${MAX_CODE_ATTEMPTS} 次會鎖定）`
})

const lockedDescription = computed(() =>
  props.canOverride ? '已切換到「主管強制完成」。' : '請聯絡主任以強制完成，或請家長在家長端重新產生接送碼。',
)

const successText = computed(() => {
  if (!success.value) return ''
  const { result, method } = success.value
  return `已完成接送：${result.authorization.student.name} 由 ${result.authorization.proxy_name} 接走（${PICKUP_COMPLETION_METHOD_LABELS[method]}）`
})

const dirty = computed(
  () =>
    props.modelValue &&
    !success.value &&
    (visualNote.value.trim() !== '' || overrideNote.value.trim() !== '' || digits.value.some((d) => d !== '')),
)
const hideFooter = computed(() => !!success.value || (locked.value && !props.canOverride))
const submitText = computed(() => SUBMIT_TEXT[tab.value])
const submitDisabled = computed(() => {
  if (tab.value === 'code') return locked.value || !codeComplete.value
  if (tab.value === 'visual') return locked.value
  return false
})

function setDigitRef(el: Element | ComponentPublicInstance | null, index: number): void {
  digitEls[index] = el instanceof HTMLInputElement ? el : null
}

/**
 * 下一個 macrotask 再聚焦：el-dialog 開啟時 focus trap 會在幾個 tick 後無條件把焦點放到 dialog 容器
 * （focus-start-el="container"），微任務時機的聚焦一定會被蓋掉；排在 timer 之後才會留在欄位上，
 * 同時 dialog 內容（含 lazy 分頁）也已渲染完成。
 */
function afterRender(fn: () => void): void {
  window.setTimeout(fn, 0)
}

function focusDigit(index: number): void {
  afterRender(() => digitEls[index]?.focus())
}

function focusOverride(): void {
  afterRender(() => overrideInput.value?.focus())
}

function focusCurrent(): void {
  if (tab.value === 'code' && !locked.value) focusDigit(0)
  else if (tab.value === 'override') focusOverride()
}

function reset(): void {
  lockedByResponse.value = false
  localAttempts.value = null
  photoBroken.value = false
  tab.value = props.authorization.locked && props.canOverride ? 'override' : 'code'
  digits.value = emptyDigits()
  codeError.value = ''
  error.value = ''
  visualNote.value = ''
  overrideNote.value = ''
  overrideError.value = ''
  busy.value = false
  success.value = null
  focusCurrent()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
  },
  { immediate: true },
)

// 開著時換成另一張授權（例如從網址參數連續核驗）：重頭開始
watch(
  () => props.authorization.id,
  () => {
    if (props.modelValue) reset()
  },
)

// 開著時父層更新同一張授權：錯誤次數與鎖定改以 props 為準（蓋掉本次由錯誤回應推得的值）。
// 多來源 watch：只有這三個值真的變了才觸發，父層換成內容相同的新物件不會清掉本次收到的鎖定。
watch(
  [() => props.authorization.id, () => props.authorization.locked, () => props.authorization.code_attempts],
  ([id, isLocked], [prevId, wasLocked]) => {
    if (!props.modelValue || success.value || id !== prevId) return
    const alreadyLocked = wasLocked || lockedByResponse.value
    lockedByResponse.value = false
    localAttempts.value = null
    if (isLocked && !alreadyLocked) enterLocked()
  },
)

watch(tab, () => {
  error.value = ''
  focusCurrent()
})

watch(overrideNote, () => {
  overrideError.value = ''
})

function clearDigits(): void {
  digits.value = emptyDigits()
}

/** 進入鎖定：清掉輸入；有 override 切到強制完成（tab watcher 會聚焦備註），否則回接送碼分頁顯示鎖定說明 */
function enterLocked(): void {
  codeError.value = ''
  clearDigits()
  tab.value = props.canOverride ? 'override' : 'code'
}

function handleError(err: unknown): void {
  if (isApiError(err) && err.code === 'pickup_code_mismatch') {
    const details = err.details as Partial<CodeMismatchDetails> | null
    const remaining =
      typeof details?.remaining_attempts === 'number'
        ? details.remaining_attempts
        : Math.max(0, MAX_CODE_ATTEMPTS - attempts.value - 1)
    localAttempts.value = MAX_CODE_ATTEMPTS - remaining
    codeError.value = `接送碼錯誤，還可嘗試 ${remaining} 次`
    clearDigits()
    focusDigit(0)
    return
  }
  if (isApiError(err) && err.code === 'pickup_code_locked') {
    lockedByResponse.value = true
    localAttempts.value = MAX_CODE_ATTEMPTS
    enterLocked()
    return
  }
  error.value = errorMessage(err, '核驗失敗，請稍後再試')
}

async function run(method: VerificationMethod, call: () => Promise<VerifyResult>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await call()
    success.value = { result, method }
    emit('verified', result)
  } catch (err) {
    handleError(err)
  } finally {
    busy.value = false
  }
}

function submitCode(): void {
  if (locked.value || !codeComplete.value) return
  const code = digits.value.join('')
  codeError.value = ''
  void run('code', () => verifyPickupCode(props.authorization.id, code))
}

function submitVisual(): void {
  if (locked.value) return
  void run('visual_match', () => confirmVisualMatch(props.authorization.id, visualNote.value))
}

function submitOverride(): void {
  const note = overrideNote.value.trim()
  if (!note) {
    overrideError.value = '請填寫備註'
    focusOverride()
    return
  }
  void run('override', () => overrideCompleteAuthorization(props.authorization.id, note))
}

function onSubmit(): void {
  if (tab.value === 'code') submitCode()
  else if (tab.value === 'visual') submitVisual()
  else submitOverride()
}

/** 從第 from 格開始依序填入（貼上整串或自動填入 one-time-code）；填滿自動送出 */
function fillDigits(from: number, raw: string): void {
  const chars = raw.replace(/\D/g, '').split('')
  if (chars.length === 0) return
  const next = [...digits.value]
  let i = from
  for (const d of chars) {
    if (i >= CODE_LENGTH) break
    next[i] = d
    i += 1
  }
  digits.value = next
  codeError.value = ''
  if (codeComplete.value) submitCode()
  else focusDigit(Math.min(i, CODE_LENGTH - 1))
}

function onDigitInput(index: number, event: Event): void {
  const input = event.target as HTMLInputElement
  const raw = input.value
  if (raw.replace(/\D/g, '').length > 1) {
    input.value = digits.value[index] ?? ''
    fillDigits(index, raw)
    return
  }
  const d = raw.replace(/\D/g, '')
  const next = [...digits.value]
  next[index] = d
  digits.value = next
  input.value = d
  codeError.value = ''
  if (d && index < CODE_LENGTH - 1) focusDigit(index + 1)
  if (codeComplete.value) submitCode()
}

function onDigitKeydown(index: number, event: KeyboardEvent): void {
  if (event.key === 'Backspace' && !digits.value[index] && index > 0) {
    event.preventDefault()
    const next = [...digits.value]
    next[index - 1] = ''
    digits.value = next
    focusDigit(index - 1)
  } else if (event.key === 'ArrowLeft' && index > 0) {
    focusDigit(index - 1)
  } else if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
    focusDigit(index + 1)
  } else if (event.key === 'Enter') {
    submitCode()
  }
}

function onDigitPaste(index: number, event: ClipboardEvent): void {
  event.preventDefault()
  fillDigits(index, event.clipboardData?.getData('text') ?? '')
}

function onDigitFocus(event: FocusEvent): void {
  ;(event.target as HTMLInputElement).select()
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="`核驗代理接送：${authorization.proxy_name}`"
    size="md"
    :loading="busy"
    :dirty="dirty"
    :hide-footer="hideFooter"
    :submit-text="submitText"
    :submit-disabled="submitDisabled"
    :autofocus="false"
    @update:model-value="emit('update:modelValue', $event)"
    @submit="onSubmit"
  >
    <div
      v-if="success"
      class="vd-success"
      role="status"
    >
      <el-icon class="vd-success__icon">
        <CircleCheckFilled />
      </el-icon>
      <p class="vd-success__title">
        {{ successText }}
      </p>
      <p class="vd-success__sub">
        已通知家長，出勤已記錄離班。
      </p>
      <el-button
        class="vd-close"
        type="primary"
        @click="close"
      >
        關閉
      </el-button>
    </div>
    <template v-else>
      <el-alert
        v-if="error"
        class="dlg-alert"
        type="error"
        :closable="false"
        show-icon
        :title="error"
      />
      <el-alert
        v-if="locked"
        class="dlg-alert"
        type="warning"
        :closable="false"
        show-icon
        title="接送碼已連續錯誤 5 次而鎖定"
        :description="lockedDescription"
      />
      <dl class="dlg-summary">
        <dt>學生</dt>
        <dd>{{ authorization.student.name }}（{{ authorization.student.class_name }}）</dd>
        <dt>代理人</dt>
        <dd>{{ authorization.proxy_name }}・{{ authorization.proxy_phone }}</dd>
        <dt>末四碼</dt>
        <dd>{{ authorization.code_last4 }}</dd>
        <dt>錯誤次數</dt>
        <dd :class="{ 'is-warn': attempts > 0 && !locked, 'is-danger': locked }">
          {{ attemptsText }}
        </dd>
      </dl>
      <el-tabs
        v-model="tab"
        class="vd-tabs"
        stretch
      >
        <el-tab-pane
          label="接送碼"
          name="code"
          :disabled="locked"
          lazy
        >
          <div class="vd-pane">
            <div
              v-if="locked"
              class="vd-locked"
            >
              接送碼已鎖定，不能再輸入
            </div>
            <template v-else>
              <p class="vd-desc">
                請代理人出示家長提供的 6 位接送碼，輸入滿 6 碼會自動核驗。
              </p>
              <div
                class="code-boxes"
                :class="{ 'is-error': !!codeError }"
                role="group"
                aria-label="接送碼"
              >
                <input
                  v-for="(d, i) in digits"
                  :key="i"
                  :ref="(el) => setDigitRef(el, i)"
                  class="code-box"
                  :class="{ 'is-gap': i === 3 }"
                  type="text"
                  inputmode="numeric"
                  :maxlength="CODE_LENGTH"
                  autocomplete="one-time-code"
                  :value="d"
                  :disabled="busy"
                  :aria-label="`第 ${i + 1} 碼`"
                  @input="onDigitInput(i, $event)"
                  @keydown="onDigitKeydown(i, $event)"
                  @paste="onDigitPaste(i, $event)"
                  @focus="onDigitFocus"
                >
              </div>
              <div
                v-if="busy"
                class="vd-status"
              >
                <el-icon class="is-loading">
                  <Loading />
                </el-icon>核驗中…
              </div>
              <div
                v-else-if="codeError"
                class="vd-status is-error"
                role="alert"
              >
                {{ codeError }}
              </div>
              <div
                v-else
                class="vd-status"
              >
                可直接貼上整串接送碼
              </div>
            </template>
          </div>
        </el-tab-pane>
        <el-tab-pane
          label="目視核對"
          name="visual"
          :disabled="locked"
          lazy
        >
          <div class="vd-pane vd-visual">
            <template v-if="showPhoto">
              <div class="vd-photo">
                <img
                  :src="authorization.photo_url ?? undefined"
                  :alt="`${authorization.proxy_name} 的照片`"
                  @error="photoBroken = true"
                >
              </div>
              <p class="vd-caption">
                請比對照片與到場人員
              </p>
            </template>
            <div
              v-else
              class="vd-nophoto"
            >
              <el-icon><Postcard /></el-icon>
              <span>此代理人沒有照片，請核對身分證件上的姓名：<strong>{{ authorization.proxy_name }}</strong></span>
            </div>
            <el-form
              class="vd-full"
              label-position="top"
              @submit.prevent
            >
              <el-form-item label="備註（選填）">
                <el-input
                  v-model="visualNote"
                  type="textarea"
                  :rows="2"
                  :maxlength="NOTE_MAX_LENGTH"
                  show-word-limit
                  placeholder="例如：已核對身分證"
                />
              </el-form-item>
            </el-form>
            <div class="vd-audit vd-full">
              <el-icon><Document /></el-icon>會記錄於稽核紀錄
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane
          v-if="canOverride"
          label="主管強制完成"
          name="override"
          lazy
        >
          <div class="vd-pane">
            <p class="vd-desc">
              接送碼與目視核對都無法完成時（例如接送碼已鎖定），由主管確認後強制完成交付。
            </p>
            <el-form
              label-position="top"
              @submit.prevent
            >
              <el-form-item
                label="備註"
                required
                :error="overrideError"
              >
                <el-input
                  ref="overrideInput"
                  v-model="overrideNote"
                  type="textarea"
                  :rows="3"
                  :maxlength="NOTE_MAX_LENGTH"
                  show-word-limit
                  placeholder="例如：已電話向家長確認"
                />
              </el-form-item>
            </el-form>
            <div class="vd-audit">
              <el-icon><Document /></el-icon>會記錄於稽核紀錄
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
      <div
        v-if="locked && !canOverride"
        class="vd-locked-actions"
      >
        <el-button
          class="vd-close"
          @click="close"
        >
          關閉
        </el-button>
      </div>
    </template>
  </FormDialog>
</template>

<style scoped>
.dlg-alert {
  margin-bottom: 16px;
}

.dlg-summary {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 4px 12px;
  margin: 0 0 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.dlg-summary dt {
  color: var(--el-text-color-secondary);
}

.dlg-summary dd {
  margin: 0;
  color: var(--el-text-color-primary);
  font-variant-numeric: tabular-nums;
}

.dlg-summary dd.is-warn {
  font-weight: 600;
  color: var(--el-color-warning-dark-2);
}

.dlg-summary dd.is-danger {
  font-weight: 600;
  color: var(--el-color-danger);
}

.vd-tabs :deep(.el-tabs__item) {
  height: 48px;
  font-size: 15px;
}

.vd-pane {
  padding-top: 4px;
}

.vd-desc {
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}

.code-boxes {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.code-box {
  width: 52px;
  height: 60px;
  padding: 0;
  font-family: inherit;
  font-size: 28px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  text-align: center;
  caret-color: var(--el-color-primary);
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  outline: none;
  font-variant-numeric: tabular-nums;
}

.code-box:focus {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
}

.code-box.is-gap {
  margin-left: 14px;
}

.code-box:disabled {
  color: var(--el-text-color-placeholder);
  cursor: not-allowed;
  background: var(--el-fill-color-light);
}

.code-boxes.is-error .code-box {
  border-color: var(--el-color-danger);
}

.vd-status {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  margin-top: 12px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.vd-status.is-error {
  font-weight: 600;
  color: var(--el-color-danger);
}

.vd-locked {
  padding: 28px 12px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.vd-visual {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.vd-photo {
  width: 220px;
  height: 220px;
  overflow: hidden;
  background: var(--el-fill-color);
  border-radius: 8px;
}

.vd-photo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.vd-caption {
  margin: 8px 0 14px;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.vd-nophoto {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  width: 100%;
  margin-bottom: 14px;
  padding: 14px;
  font-size: 14px;
  line-height: 1.6;
  background: var(--el-fill-color-lighter);
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
}

.vd-nophoto .el-icon {
  flex-shrink: 0;
  font-size: 28px;
  color: var(--el-text-color-secondary);
}

.vd-full {
  width: 100%;
}

.vd-audit {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: -8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.vd-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px 8px 4px;
  text-align: center;
}

.vd-success__icon {
  font-size: 56px;
  color: var(--el-color-success);
}

.vd-success__title {
  margin: 12px 0 4px;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.6;
}

.vd-success__sub {
  margin: 0 0 20px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.vd-close {
  min-width: 120px;
  min-height: 44px;
  font-size: 15px;
}

.vd-locked-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
