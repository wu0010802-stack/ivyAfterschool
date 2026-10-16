<script setup lang="ts">
// FRONTEND-198：完成交付（domain_spec M7 流程 5：記錄由哪位監護人或哪張代理授權接走；BACKEND-433 method guardian / override）。
// 設計稿：docs/mockups/page-pickup-pos.html（PickupCompleteDialog，FormDialog md）。
// - 選項分三組：監護人（can_pickup 才可選）、代理接送（該生今日 active 授權，改走核驗頁）、其他（主管確認交付，需 pickup:override）。
// - 監護人交付沒有備註欄：後端只保存主管確認交付的備註（寫入稽核紀錄）。
// - board.complete：404 / 409 由 board 提示並重新整理後 resolve null → 直接關閉；其他錯誤顯示在選項上方。
import { Document, InfoFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { listGuardians, type Guardian } from '@/api/guardians'
import type { StaffAuthorization } from '@/api/pickupAuthorizations'
import type { PickupCompleteBody, PickupRequest } from '@/api/pickupRequests'
import FormDialog from '@/components/common/FormDialog.vue'
import type { PickupBoard } from '@/composables/usePickupBoard'
import { GUARDIAN_RELATION_LABELS } from '@/shared/constants/statusLabels'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  modelValue: boolean
  request: PickupRequest
  /** board 中的今日授權（本元件只取該生 effective_status 為 active 者） */
  authorizations: StaffAuthorization[]
  canOverride: boolean
  board: Pick<PickupBoard, 'complete'>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  done: [request: PickupRequest]
  'verify-authorization': [authorization: StaffAuthorization]
}>()

const OVERRIDE = 'override'
const GUARDIAN_PREFIX = 'g:'
const AUTH_PREFIX = 'a:'

const guardians = ref<Guardian[]>([])
const loadingGuardians = ref(false)
const choice = ref<string | null>(null)
const note = ref('')
const noteError = ref('')
const error = ref('')
const submitting = ref(false)
// 關閉後重開、或重新載入時，較早的回應不得覆蓋
let loadSeq = 0

const eligibleGuardians = computed(() => guardians.value.filter((g) => g.can_pickup))
const studentAuthorizations = computed(() =>
  props.authorizations.filter((a) => a.student_id === props.request.student.id && a.effective_status === 'active'),
)
const chosenAuthorization = computed(() => {
  const c = choice.value
  if (!c?.startsWith(AUTH_PREFIX)) return null
  return studentAuthorizations.value.find((a) => a.id === c.slice(AUTH_PREFIX.length)) ?? null
})
const noEligible = computed(
  () =>
    !loadingGuardians.value &&
    eligibleGuardians.value.length === 0 &&
    studentAuthorizations.value.length === 0 &&
    !props.canOverride,
)
const submitText = computed(() => (chosenAuthorization.value ? '前往核驗' : '完成交付'))
const submitDisabled = computed(() => loadingGuardians.value || choice.value === null || noEligible.value)
const dirty = computed(() => choice.value === OVERRIDE && note.value.trim() !== '')

async function loadGuardians(): Promise<void> {
  const seq = ++loadSeq
  loadingGuardians.value = true
  try {
    const list = await listGuardians(props.request.student.id)
    if (seq !== loadSeq) return
    guardians.value = list
    const eligible = list.filter((g) => g.can_pickup)
    // 只有一位可接送監護人時預選
    if (choice.value === null && eligible.length === 1) choice.value = `${GUARDIAN_PREFIX}${eligible[0]!.id}`
  } catch (err) {
    if (seq !== loadSeq) return
    guardians.value = []
    error.value = errorMessage(err, '無法載入監護人資料，請稍後再試')
  } finally {
    if (seq === loadSeq) loadingGuardians.value = false
  }
}

function reset(): void {
  guardians.value = []
  choice.value = null
  note.value = ''
  noteError.value = ''
  error.value = ''
  submitting.value = false
  void loadGuardians()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
    else loadSeq += 1
  },
  { immediate: true },
)

watch([choice, note], () => {
  noteError.value = ''
})

function close(): void {
  emit('update:modelValue', false)
}

/** 監護人選擇失效（未授權接送 / 資料已變更）：提示、清掉選擇並重新載入 */
function guardianChanged(message: string): void {
  error.value = message
  choice.value = null
  void loadGuardians()
}

function bodyOf(c: string): PickupCompleteBody | null {
  if (c === OVERRIDE) {
    const text = note.value.trim()
    if (!text) {
      noteError.value = '請填寫備註'
      return null
    }
    return { method: 'override', note: text }
  }
  return { method: 'guardian', guardian_id: c.slice(GUARDIAN_PREFIX.length) }
}

async function onSubmit(): Promise<void> {
  const c = choice.value
  if (submitting.value || c === null || submitDisabled.value) return
  const auth = chosenAuthorization.value
  if (auth) {
    // 代理接送不在這裡完成：到核驗頁核對接送碼或身分
    emit('verify-authorization', auth)
    close()
    return
  }
  const body = bodyOf(c)
  if (!body) return
  error.value = ''
  submitting.value = true
  try {
    const completed = await props.board.complete(props.request.id, body)
    if (completed === null) {
      close()
      return
    }
    ElMessage.success('已完成交付')
    emit('done', completed)
    close()
  } catch (err) {
    const code = errorCode(err)
    if (code === 'guardian_cannot_pickup') guardianChanged('此監護人未被授權接送')
    else if (code === 'invalid_guardian') guardianChanged('監護人資料已變更，請重新選擇')
    else error.value = errorMessage(err, '完成交付失敗，請稍後再試')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="`完成交付：${request.student.name}`"
    size="md"
    :loading="submitting"
    :dirty="dirty"
    :submit-text="submitText"
    :submit-disabled="submitDisabled"
    @update:model-value="emit('update:modelValue', $event)"
    @submit="onSubmit"
  >
    <el-alert
      v-if="error"
      class="complete-dialog__alert"
      type="error"
      :closable="false"
      show-icon
      :title="error"
    />
    <el-alert
      v-if="noEligible"
      class="complete-dialog__alert"
      type="warning"
      :closable="false"
      show-icon
      title="沒有可接送的監護人，請聯絡主任處理"
    />

    <div
      v-if="loadingGuardians"
      class="complete-dialog__skeleton"
    >
      <el-skeleton
        :rows="3"
        animated
      />
    </div>
    <el-radio-group
      v-else
      v-model="choice"
      class="complete-dialog__options"
    >
      <div class="complete-dialog__group">
        <div class="complete-dialog__group-title">
          監護人
        </div>
        <div
          v-if="guardians.length === 0"
          class="complete-dialog__empty"
        >
          沒有監護人資料
        </div>
        <div class="complete-dialog__list">
          <el-radio
            v-for="g in guardians"
            :key="g.id"
            :value="`g:${g.id}`"
            :disabled="!g.can_pickup"
            border
          >
            <span class="complete-dialog__main">
              <span class="complete-dialog__name">{{ g.name }}（{{ GUARDIAN_RELATION_LABELS[g.relation] }}）</span>
              <span
                v-if="g.phone"
                class="complete-dialog__sub"
              >{{ g.phone }}</span>
            </span>
            <el-tag
              v-if="!g.can_pickup"
              type="info"
              size="small"
              disable-transitions
            >
              未授權接送
            </el-tag>
          </el-radio>
        </div>
      </div>

      <div
        v-if="studentAuthorizations.length > 0"
        class="complete-dialog__group"
      >
        <div class="complete-dialog__group-title">
          代理接送（今日授權）
        </div>
        <div class="complete-dialog__list">
          <el-radio
            v-for="a in studentAuthorizations"
            :key="a.id"
            :value="`a:${a.id}`"
            border
          >
            <span class="complete-dialog__main">
              <span class="complete-dialog__name">代理：{{ a.proxy_name }}（{{ a.proxy_phone }}）</span>
              <span class="complete-dialog__sub">末四碼 {{ a.code_last4 }}</span>
            </span>
            <el-tag
              v-if="a.locked"
              type="danger"
              size="small"
              disable-transitions
            >
              已鎖定
            </el-tag>
          </el-radio>
        </div>
      </div>

      <div
        v-if="canOverride"
        class="complete-dialog__group"
      >
        <div class="complete-dialog__group-title">
          其他
        </div>
        <div class="complete-dialog__list">
          <el-radio
            :value="OVERRIDE"
            border
          >
            <span class="complete-dialog__main">
              <span class="complete-dialog__name">主管確認交付</span>
              <span class="complete-dialog__sub">沒有可接送的監護人或代理授權時，由主管確認後交付</span>
            </span>
          </el-radio>
        </div>
      </div>
    </el-radio-group>

    <div
      v-if="!loadingGuardians && chosenAuthorization"
      class="complete-dialog__note-box"
    >
      <el-icon><InfoFilled /></el-icon>
      <span>
        按「前往核驗」到代理接送核驗頁，核對接送碼或代理人身分後完成交付。<template v-if="chosenAuthorization.locked">此授權的接送碼已鎖定，需由主任強制完成。</template>
      </span>
    </div>

    <el-form
      v-if="!loadingGuardians && choice === OVERRIDE"
      class="complete-dialog__extra"
      label-position="top"
      @submit.prevent
    >
      <el-form-item
        label="備註"
        required
        :error="noteError"
      >
        <el-input
          v-model="note"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="例如：阿嬤臨時來接，已電話向媽媽確認"
        />
      </el-form-item>
      <div class="complete-dialog__audit">
        <el-icon><Document /></el-icon>會記錄於稽核紀錄
      </div>
    </el-form>
  </FormDialog>
</template>

<style scoped>
.complete-dialog__alert {
  margin-bottom: 16px;
}

.complete-dialog__skeleton {
  padding: 4px 0 12px;
}

.complete-dialog__options.el-radio-group {
  display: block;
  width: 100%;
  font-size: 14px;
}

.complete-dialog__group {
  margin-bottom: 14px;
}

.complete-dialog__group-title {
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.complete-dialog__empty {
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

.complete-dialog__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: stretch;
  width: 100%;
}

/* 框線 radio 卡，觸控目標 ≥ 56px */
.complete-dialog__list .el-radio.is-bordered {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  height: auto;
  min-height: 56px;
  padding: 8px 14px;
  margin: 0;
}

.complete-dialog__list .el-radio.is-bordered + .el-radio.is-bordered {
  margin-left: 0;
}

.complete-dialog__list :deep(.el-radio__label) {
  display: flex;
  flex: 1;
  gap: 8px;
  align-items: center;
  min-width: 0;
}

.complete-dialog__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.complete-dialog__name {
  font-size: 15px;
  color: var(--el-text-color-primary);
  white-space: normal;
}

.complete-dialog__sub {
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
  white-space: normal;
}

.complete-dialog__list .el-radio.is-disabled .complete-dialog__name {
  color: var(--el-text-color-placeholder);
}

.complete-dialog__note-box {
  display: flex;
  gap: 6px;
  padding: 10px 12px;
  margin-top: 4px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.complete-dialog__note-box .el-icon {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--el-text-color-secondary);
}

.complete-dialog__extra {
  margin-top: 4px;
}

.complete-dialog__audit {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: -8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
