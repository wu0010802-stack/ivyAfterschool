<script setup lang="ts">
// FRONTEND-197：回覆預計可接送時間（domain_spec M7 流程 3：員工覆寫回覆，reply_source = staff；可同時確認 → acknowledged）。
// 設計稿：docs/mockups/page-pickup-pos.html（PickupReplyDialog，FormDialog md）。
// - 回覆帶 reply_ready_eta 時後端同交易寫回作業進度並推播作業看板（BACKEND-407），本元件不另打作業 API。
// - board.reply / acknowledge：404 / 409 由 board 提示並重新整理後 resolve null → 直接關閉；其他錯誤顯示在表單上方。
// - 回覆成功但確認失敗：表單鎖住，送出鈕改「重試確認」，只重送確認。
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import type { PickupReply, PickupRequest } from '@/api/pickupRequests'
import FormDialog from '@/components/common/FormDialog.vue'
import { etaRelativeText, formatWaited, useNowClock, waitedMinutes } from '@/composables/useDismissalUrgency'
import type { PickupBoard } from '@/composables/usePickupBoard'
import { HOMEWORK_OVERALL_STATUS_META } from '@/shared/constants/statusLabels'
import type { HHMM } from '@/shared/types/api'
import { formatTime, nowHHMM } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  modelValue: boolean
  request: PickupRequest
  board: Pick<PickupBoard, 'reply' | 'acknowledge'>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  done: [request: PickupRequest]
}>()

const STEP_MINUTES = 5
const LAST_MINUTES = 23 * 60 + 55
const QUICK_MINUTES = [10, 20, 30] as const
const REQUIRED_MESSAGE = '請填寫預計時間或訊息'

const eta = ref<HHMM | null>(null)
const message = ref('')
const acknowledge = ref(true)
const snapshot = ref('')
const openedAtMinutes = ref(0)

const submitting = ref(false)
const fieldError = ref('')
const error = ref('')
const warn = ref('')
/** 回覆已成功、只剩確認失敗：表單鎖住，只能重試確認 */
const ackOnly = ref(false)

const { now } = useNowClock()

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function toHHMM(minutes: number): HHMM {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function roundUp(minutes: number): number {
  return Math.ceil(minutes / STEP_MINUTES) * STEP_MINUTES
}

function formState(): string {
  return JSON.stringify([eta.value || null, message.value, acknowledge.value])
}

function reset(): void {
  const r = props.request
  eta.value = r.reply_ready_eta ?? r.current_ready_eta ?? null
  message.value = r.reply_source === 'staff' ? (r.reply_message ?? '') : ''
  acknowledge.value = true
  submitting.value = false
  fieldError.value = ''
  error.value = ''
  warn.value = ''
  ackOnly.value = false
  openedAtMinutes.value = toMinutes(nowHHMM())
  snapshot.value = formState()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
  },
  { immediate: true },
)

watch([eta, message], () => {
  fieldError.value = ''
})

const showAcknowledge = computed(() => props.request.status === 'pending')
const dirty = computed(() => !ackOnly.value && formState() !== snapshot.value)
const submitText = computed(() => {
  if (ackOnly.value) return '重試確認'
  return showAcknowledge.value && acknowledge.value ? '回覆並確認' : '送出回覆'
})
const timeStart = computed(() => toHHMM(roundUp(openedAtMinutes.value)))
const messagePlaceholder = computed(() =>
  eta.value ? `預計 ${eta.value} 可接送` : '例如：數學訂正中，訂正完就可以接',
)

const arrivalText = computed(() => {
  const r = props.request
  if (r.status === 'arrived') {
    return `家長已到・${formatWaited(waitedMinutes(r, now.value))}（${formatTime(r.arrived_at)} 到達）`
  }
  if (r.expected_arrival_at) return `預計 ${r.expected_arrival_at} 到（${etaRelativeText(r.expected_arrival_at, now.value)}）`
  return '家長未指定抵達時間'
})
const homeworkMeta = computed(() => {
  const s = props.request.current_homework_status
  return s ? HOMEWORK_OVERALL_STATUS_META[s] : null
})
const replySourceText = computed(() =>
  props.request.reply_source === 'staff' ? `${props.request.replied_by_name ?? '員工'} 回覆` : '系統自動回覆',
)

function applyQuick(minutes: number): void {
  eta.value = toHHMM(Math.min(roundUp(toMinutes(nowHHMM()) + minutes), LAST_MINUTES))
}

function close(): void {
  emit('update:modelValue', false)
}

function succeed(result: PickupRequest): void {
  ElMessage.success(props.request.requested_by_type === 'parent' ? '已回覆家長' : '已更新回覆')
  emit('done', result)
  close()
}

/** 確認；回傳 false 表示失敗（已顯示警告、表單鎖住） */
async function runAcknowledge(): Promise<PickupRequest | null | false> {
  try {
    return await props.board.acknowledge(props.request.id)
  } catch (err) {
    warn.value = `已回覆，但確認失敗：${errorMessage(err, '請稍後再試')}`
    ackOnly.value = true
    return false
  }
}

async function retryAcknowledge(): Promise<void> {
  const acked = await runAcknowledge()
  if (acked === false) return
  if (acked === null) close()
  else succeed(acked)
}

async function sendReply(): Promise<void> {
  const time = eta.value || null
  const text = message.value.trim()
  if (!time && !text) {
    fieldError.value = REQUIRED_MESSAGE
    return
  }
  const body: PickupReply = {}
  if (time) body.reply_ready_eta = time
  if (text) body.reply_message = text

  let replied: PickupRequest | null
  try {
    replied = await props.board.reply(props.request.id, body)
  } catch (err) {
    error.value = errorMessage(err, '回覆失敗，請稍後再試')
    return
  }
  if (replied === null) {
    close()
    return
  }
  // 送出期間別人已確認（或家長已到）時不再確認，避免 409
  if (!(showAcknowledge.value && acknowledge.value && replied.status === 'pending')) {
    succeed(replied)
    return
  }
  const acked = await runAcknowledge()
  if (acked === false) return
  if (acked === null) close()
  else succeed(acked)
}

async function onSubmit(): Promise<void> {
  if (submitting.value) return
  error.value = ''
  submitting.value = true
  try {
    if (ackOnly.value) await retryAcknowledge()
    else await sendReply()
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="`回覆預計可接送時間：${request.student.name}`"
    size="md"
    :loading="submitting"
    :dirty="dirty"
    :submit-text="submitText"
    @update:model-value="emit('update:modelValue', $event)"
    @submit="onSubmit"
  >
    <el-alert
      v-if="warn"
      class="reply-dialog__alert"
      type="warning"
      :closable="false"
      show-icon
      :title="warn"
    />
    <el-alert
      v-if="error"
      class="reply-dialog__alert"
      type="error"
      :closable="false"
      show-icon
      :title="error"
    />
    <dl class="reply-dialog__summary">
      <dt>學生</dt>
      <dd>{{ request.student.name }}（{{ request.student.class_name ?? '未分班' }}）</dd>
      <dt>家長抵達</dt>
      <dd>{{ arrivalText }}</dd>
      <dt>目前作業</dt>
      <dd>
        <el-tag
          v-if="homeworkMeta"
          :type="homeworkMeta.tone"
          size="small"
          effect="plain"
          disable-transitions
        >
          {{ homeworkMeta.label }}
        </el-tag>
        <span v-if="request.current_ready_eta">作業預計 {{ request.current_ready_eta }} 完成</span>
        <span
          v-else-if="request.current_homework_status !== 'done'"
          class="reply-dialog__muted"
        >尚未設定作業預計完成時間</span>
      </dd>
      <dt>目前回覆</dt>
      <dd>
        <template v-if="request.reply_message">
          {{ request.reply_message }}<span class="reply-dialog__muted">（{{ replySourceText }}）</span>
        </template>
        <span
          v-else
          class="reply-dialog__muted"
        >尚未回覆</span>
      </dd>
    </dl>
    <p
      v-if="request.requested_by_type !== 'parent'"
      class="reply-dialog__note"
    >
      員工代建的請求，回覆不會通知家長。
    </p>
    <el-form
      label-position="top"
      :disabled="ackOnly"
      @submit.prevent
    >
      <el-form-item
        label="預計可接送時間"
        :error="fieldError"
      >
        <el-time-select
          v-model="eta"
          class="reply-dialog__full"
          :start="timeStart"
          end="21:00"
          step="00:05"
          placeholder="選擇時間"
          clearable
        />
        <div class="reply-dialog__quick">
          <el-button
            v-for="minutes in QUICK_MINUTES"
            :key="minutes"
            @click="applyQuick(minutes)"
          >
            +{{ minutes }} 分
          </el-button>
        </div>
        <div class="reply-dialog__hint">
          <el-icon><Refresh /></el-icon>將同步更新作業看板的預計可接送時間
        </div>
      </el-form-item>
      <el-form-item label="給家長的訊息">
        <el-input
          v-model="message"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          :placeholder="messagePlaceholder"
        />
      </el-form-item>
      <el-checkbox
        v-if="showAcknowledge"
        v-model="acknowledge"
        class="reply-dialog__ack"
        size="large"
      >
        同時確認此請求
      </el-checkbox>
    </el-form>
  </FormDialog>
</template>

<style scoped>
.reply-dialog__alert {
  margin-bottom: 16px;
}

.reply-dialog__summary {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 6px 12px;
  padding: 10px 12px;
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.reply-dialog__summary dt {
  color: var(--el-text-color-secondary);
}

.reply-dialog__summary dd {
  margin: 0;
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.reply-dialog__summary .el-tag {
  margin-right: 6px;
  vertical-align: 1px;
}

.reply-dialog__muted {
  color: var(--el-text-color-secondary);
}

.reply-dialog__note {
  margin: -8px 0 14px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.reply-dialog__full {
  width: 100%;
}

/* 快捷鈕一列，觸控目標 44px */
.reply-dialog__quick {
  display: flex;
  flex-basis: 100%;
  gap: 8px;
  margin-top: 8px;
}

.reply-dialog__quick .el-button {
  min-width: 72px;
  height: 44px;
  margin-left: 0;
}

.reply-dialog__hint {
  display: flex;
  flex-basis: 100%;
  gap: 4px;
  align-items: center;
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.reply-dialog__ack.el-checkbox {
  height: 44px;
}
</style>
