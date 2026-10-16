<script setup lang="ts">
// FRONTEND-199：員工代建接送請求（domain_spec M7 流程 7：source = staff；不受家長可發起時段限制，BACKEND-406）。
// 設計稿：docs/mockups/page-pickup-pos.html（代建 dialog 段）。
// - FormDialog sm「代建接送請求」，送出鈕「建立請求」。從學生卡進入時學生唯讀；從工具列進入用 StudentSelect，
//   POS 選了班級時只查該班。
// - 家長預計抵達時間選填：el-time-select 5 分一格，最早為開啟當下「現在 − 5 分」進位到 5 分，到 21:00；不選就不送。
// - 送出走 board.create（FRONTEND-188）：成功提示並 emit created、關閉；回 null 表示 board 已提示並重新整理，直接關閉；
//   其他錯誤顯示在表單上方（pickup_request_exists 用固定文案，其餘顯示後端訊息）。
import { InfoFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, reactive, ref, watch } from 'vue'
import type { PickupRequest, PickupRequestCreate } from '@/api/pickupRequests'
import FormDialog from '@/components/common/FormDialog.vue'
import StudentSelect from '@/components/student/StudentSelect.vue'
import type { PickupBoard } from '@/composables/usePickupBoard'
import { useFormDirty } from '@/composables/useFormDirty'
import type { HHMM } from '@/shared/types/api'
import { nowHHMM } from '@/shared/utils/datetime'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'

export interface PickupCreatePresetStudent {
  id: string
  name: string
  student_no: string
  class_name: string | null
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    presetStudent?: PickupCreatePresetStudent
    /** POS 中欄目前選的班級；全部班級時不傳 */
    classFilter?: { id: string; name: string }
    board: Pick<PickupBoard, 'create'>
  }>(),
  { presetStudent: undefined, classFilter: undefined },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [req: PickupRequest]
}>()

const STEP_MINUTES = 5
/** 家長預計抵達最早可選「現在 − 5 分」 */
const EARLIEST_OFFSET_MINUTES = 5
const LATEST = '21:00'
const EXISTS_MESSAGE = '此學生今天已有進行中的接送請求'

interface CreateForm {
  student_id: string | null
  expected_arrival_at: HHMM | null
}

const form = reactive<CreateForm>({ student_id: null, expected_arrival_at: null })
const studentError = ref('')
const submitError = ref('')
const saving = ref(false)
const arrivalStart = ref<HHMM>('00:00')
const { isDirty, markClean } = useFormDirty(form)

function toMinutes(hhmm: HHMM): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function toHHMM(minutes: number): HHMM {
  const clamped = Math.max(0, minutes)
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

function reset(): void {
  form.student_id = props.presetStudent?.id ?? null
  form.expected_arrival_at = null
  studentError.value = ''
  submitError.value = ''
  const earliest = toMinutes(nowHHMM()) - EARLIEST_OFFSET_MINUTES
  arrivalStart.value = toHHMM(Math.ceil(earliest / STEP_MINUTES) * STEP_MINUTES)
  markClean()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
  },
  { immediate: true },
)

const presetLabel = computed(() => {
  const s = props.presetStudent
  return s ? `${s.name}（${s.student_no}・${s.class_name ?? '未分班'}）` : ''
})
const studentPlaceholder = computed(() =>
  props.classFilter ? `輸入學號或姓名（${props.classFilter.name}）` : '輸入學號或姓名搜尋',
)

function showError(err: unknown): void {
  submitError.value =
    errorCode(err) === 'pickup_request_exists' ? EXISTS_MESSAGE : errorMessage(err, '建立失敗，請稍後再試')
}

async function submit(): Promise<void> {
  if (saving.value) return
  const studentId = form.student_id
  if (!studentId) {
    studentError.value = '請選擇學生'
    return
  }
  const body: PickupRequestCreate = { student_id: studentId }
  if (form.expected_arrival_at) body.expected_arrival_at = form.expected_arrival_at
  saving.value = true
  submitError.value = ''
  try {
    const req = await props.board.create(body)
    if (req) {
      ElMessage.success('已建立接送請求')
      emit('created', req)
    }
    emit('update:modelValue', false)
  } catch (err) {
    showError(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    title="代建接送請求"
    size="sm"
    :loading="saving"
    :dirty="isDirty"
    submit-text="建立請求"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
  >
    <el-alert
      v-if="submitError"
      class="create-dialog__alert"
      type="error"
      :closable="false"
      show-icon
      :title="submitError"
    />
    <el-form
      label-position="top"
      @submit.prevent
    >
      <el-form-item
        label="學生"
        required
        :error="studentError"
      >
        <div
          v-if="presetStudent"
          class="create-dialog__readonly"
          data-test="preset-student"
        >
          {{ presetLabel }}
        </div>
        <StudentSelect
          v-else
          v-model="form.student_id"
          class="create-dialog__full"
          :class-id="classFilter?.id"
          :placeholder="studentPlaceholder"
          @change="studentError = ''"
        />
      </el-form-item>
      <el-form-item label="家長預計抵達時間（選填）">
        <el-time-select
          v-model="form.expected_arrival_at"
          class="create-dialog__full"
          :start="arrivalStart"
          :end="LATEST"
          step="00:05"
          placeholder="不指定"
          clearable
        />
      </el-form-item>
    </el-form>
    <div class="create-dialog__note">
      <el-icon><InfoFilled /></el-icon>
      <span>員工代建的請求不會通知家長；系統會依作業進度自動產生回覆供參考。</span>
    </div>
  </FormDialog>
</template>

<style scoped>
.create-dialog__alert {
  margin-bottom: 16px;
}

.create-dialog__full {
  width: 100%;
}

.create-dialog__readonly {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);
}

.create-dialog__note {
  display: flex;
  gap: 6px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.create-dialog__note .el-icon {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--el-text-color-secondary);
}
</style>
