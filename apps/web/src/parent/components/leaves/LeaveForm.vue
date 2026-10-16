<script setup lang="ts">
/**
 * 請假申請表單（單一小孩：由頁面的選中小孩決定，表單內不選小孩）。
 * 內部持有欄位狀態，送出時 emit 正規化後的 payload；建立請假與附件上傳都由 LeavesView 負責。
 * 日期範圍、附件個數 / 大小上限一律來自 limits prop（PARENT-005），元件內不寫死。
 * 日期驗證只在送出時做；附件在選檔當下驗證。
 */
import { computed, ref, shallowRef, useId, watch } from 'vue'
import type { LeaveType } from '@/shared/types/api'
import { addDays } from '@/shared/utils/datetime'
import type { ParentLimits } from '../../api/config'
import M3Button from '../m3/M3Button.vue'
import M3Icon from '../m3/M3Icon.vue'
import M3IconButton from '../m3/M3IconButton.vue'
import M3SegmentedButton, { type SegmentItem } from '../m3/M3SegmentedButton.vue'
import M3TextField from '../m3/M3TextField.vue'
import { ATTACHMENT_ACCEPT, formatFileSize, validateAttachment } from './attachmentRules'

export interface LeaveFormInput {
  leave_type: LeaveType
  start_date: string
  end_date: string
  reason: string
  files: File[]
}

const props = withDefaults(
  defineProps<{
    /** 台北今天 YYYY-MM-DD */
    today: string
    limits: ParentLimits
    submitting?: boolean
  }>(),
  { submitting: false },
)

const emit = defineEmits<{ submit: [input: LeaveFormInput]; cancel: [] }>()

const LEAVE_TYPE_ITEMS: SegmentItem[] = [
  { value: 'sick', label: '病假' },
  { value: 'personal', label: '事假' },
  { value: 'other', label: '其他' },
]
const REASON_MAX_LENGTH = 200
const END_BEFORE_START = '結束日期不可早於開始日期'

const typeLabelId = useId()
const dateLabelId = useId()

const leaveType = ref<LeaveType>('sick')
const startDate = ref(props.today)
const endDate = ref(props.today)
const reason = ref('')
const startError = ref('')
const endError = ref('')
// File 不放進 reactive：每次都換新陣列，payload 送出原物件
const files = shallowRef<File[]>([])
const fileError = ref('')

const minDate = computed(() => addDays(props.today, -props.limits.leave_past_days))
const maxDate = computed(() => addDays(props.today, props.limits.leave_future_days))
const rangeHint = computed(() => `可選 ${monthDay(minDate.value)}～${monthDay(maxDate.value)}`)
const canAddFile = computed(() => files.value.length < props.limits.leave_max_attachments)

function monthDay(date: string): string {
  return date.slice(5).replace('-', '/')
}

// 開始日晚於結束日時，結束日跟著設為開始日；任一日期變更即清除兩欄錯誤
watch(startDate, (value) => {
  if (value && endDate.value && value > endDate.value) endDate.value = value
  startError.value = ''
  endError.value = ''
})
watch(endDate, () => {
  startError.value = ''
  endError.value = ''
})

function validateDates(): boolean {
  const rangeMessage = `請假日期需在今天前 ${props.limits.leave_past_days} 天到後 ${props.limits.leave_future_days} 天內`
  const outOfRange = (date: string): boolean => !date || date < minDate.value || date > maxDate.value
  startError.value = outOfRange(startDate.value) ? rangeMessage : ''
  if (outOfRange(endDate.value)) endError.value = rangeMessage
  else endError.value = endDate.value < startDate.value ? END_BEFORE_START : ''
  return startError.value === '' && endError.value === ''
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  // 清空 value，才能再次選同一個檔案
  input.value = ''
  if (!file || !canAddFile.value) return
  fileError.value = validateAttachment(file, props.limits.leave_max_attachment_mb)
  if (fileError.value === '') files.value = [...files.value, file]
}

function removeFile(index: number): void {
  files.value = files.value.filter((_, i) => i !== index)
  fileError.value = ''
}

function onSubmit(): void {
  if (props.submitting || !validateDates()) return
  emit('submit', {
    leave_type: leaveType.value,
    start_date: startDate.value,
    end_date: endDate.value,
    reason: reason.value.trim(),
    files: [...files.value],
  })
}
</script>

<template>
  <form
    class="lf"
    novalidate
    @submit.prevent="onSubmit"
  >
    <fieldset
      class="lf-lock"
      :disabled="submitting"
    >
      <div
        class="lf-group"
        role="group"
        :aria-labelledby="typeLabelId"
      >
        <p
          :id="typeLabelId"
          class="lf-label m3-title-small"
        >
          假別
        </p>
        <M3SegmentedButton
          v-model="leaveType"
          :items="LEAVE_TYPE_ITEMS"
          aria-label="假別"
        />
      </div>

      <div
        class="lf-group"
        role="group"
        :aria-labelledby="dateLabelId"
      >
        <p
          :id="dateLabelId"
          class="lf-label m3-title-small"
        >
          日期
        </p>
        <div class="lf-dates">
          <M3TextField
            v-model="startDate"
            type="date"
            label="開始日期"
            :min="minDate"
            :max="maxDate"
            :supporting-text="rangeHint"
            :error-text="startError"
          />
          <M3TextField
            v-model="endDate"
            type="date"
            label="結束日期"
            :min="minDate"
            :max="maxDate"
            :error-text="endError"
          />
        </div>
      </div>

      <M3TextField
        v-model="reason"
        type="textarea"
        label="事由（選填）"
        placeholder="例如：發燒看醫生"
        :maxlength="REASON_MAX_LENGTH"
      />

      <div class="lf-group">
        <p class="lf-label m3-title-small">
          附件（選填）<span class="lf-label__aside m3-body-small">{{ files.length }}/{{ limits.leave_max_attachments }}</span>
        </p>
        <ul
          v-if="files.length"
          class="lf-files"
          role="list"
          aria-label="已選附件"
        >
          <li
            v-for="(f, i) in files"
            :key="`${f.name}-${i}`"
            class="lf-file"
          >
            <M3Icon
              class="lf-file__icon"
              :class="{ 'is-pdf': f.type === 'application/pdf' }"
              :name="f.type === 'application/pdf' ? 'picture_as_pdf' : 'image'"
            />
            <span class="lf-file__text">
              <span class="lf-file__name m3-body-large">{{ f.name }}</span>
              <span class="lf-file__size m3-body-small">{{ formatFileSize(f.size) }}</span>
            </span>
            <M3IconButton
              icon="close"
              :label="`移除 ${f.name}`"
              @click="removeFile(i)"
            />
          </li>
        </ul>
        <label
          v-if="canAddFile"
          class="lf-add m3-label-large"
        >
          <input
            class="lf-add__input"
            type="file"
            :accept="ATTACHMENT_ACCEPT"
            aria-label="新增附件"
            @change="onFileChange"
          >
          <M3Icon
            name="attach_file"
            :size="18"
          />
          <span>新增附件</span>
        </label>
        <div
          v-if="fileError"
          class="lf-error m3-body-small"
          role="alert"
        >
          <span class="lf-error__line">
            <M3Icon
              name="error"
              filled
              :size="16"
            />{{ fileError }}
          </span>
        </div>
        <p class="lf-help m3-body-small">
          {{
            canAddFile
              ? `最多 ${limits.leave_max_attachments} 個，單檔 ${limits.leave_max_attachment_mb} MB 以內（JPG、PNG、WEBP、HEIC、PDF）`
              : `已達 ${limits.leave_max_attachments} 個附件上限`
          }}
        </p>
      </div>
    </fieldset>

    <div class="lf-actions">
      <M3Button
        variant="outlined"
        :disabled="submitting"
        @click="emit('cancel')"
      >
        取消
      </M3Button>
      <M3Button
        type="submit"
        icon="send"
        :loading="submitting"
      >
        送出請假
      </M3Button>
    </div>
  </form>
</template>

<style scoped>
/* 單欄表單：假別 / 日期 / 事由 / 附件 / 按鈕列 */
.lf {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* submitting 時 fieldset disabled 鎖定全部欄位（不淡化，避免閃爍）；display: contents 讓子區塊直接參與 .lf 的間距 */
.lf-lock {
  display: contents;
}

.lf-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}

.lf-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 0;
  color: var(--m3-on-surface);
}

.lf-label__aside {
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.lf-dates {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.lf-files {
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--m3-outline-variant);
  border-radius: var(--m3-shape-medium);
  list-style: none;
}

.lf-file {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 4px 4px 4px 16px;
}

.lf-file + .lf-file {
  border-top: 1px solid var(--m3-outline-variant);
}

.lf-file__icon {
  color: var(--m3-on-surface-variant);
}

.lf-file__icon.is-pdf {
  color: var(--m3-error);
}

.lf-file__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.lf-file__name {
  overflow: hidden;
  color: var(--m3-on-surface);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lf-file__size {
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

/* 「新增附件」：外觀同 M3Button outlined + 圖示，label 包視覺隱藏但可聚焦的 file input */
.lf-add {
  position: relative;
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  justify-content: center;
  gap: 8px;
  min-width: 48px;
  height: 48px;
  padding: 0 24px 0 16px;
  border-radius: var(--m3-shape-full);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--m3-outline);
  color: var(--m3-primary);
  cursor: pointer;
  white-space: nowrap;
  -webkit-tap-highlight-color: transparent;
}

.lf-add::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: currentcolor;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.lf-add:hover::before {
  opacity: var(--m3-state-hover);
}

.lf-add:focus-within::before {
  opacity: var(--m3-state-focus);
}

.lf-add:active::before {
  opacity: var(--m3-state-pressed);
}

.lf-add:focus-within {
  outline: 2px solid var(--m3-primary);
  outline-offset: 2px;
}

.lf-add__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
}

.lf-help {
  margin: 0;
  padding: 0 4px;
  color: var(--m3-on-surface-variant);
}

.lf-error {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0 4px;
  color: var(--m3-error);
}

.lf-error__line {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}

.lf-actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
}

.lf-actions > * {
  flex: 1 1 0;
}
</style>
