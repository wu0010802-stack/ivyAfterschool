<script setup lang="ts">
// FRONTEND-100：退班學生個資永久刪除 / 匿名化（POST /admin/students/{id}/purge，BACKEND-531；domain_spec M3 個資保存）。
// 設計稿：docs/mockups/page-students.html（StudentPurgeDialog 段）。
// - 直接用 el-dialog（FormDialog 的送出鈕固定 primary，這裡要 danger）；寬度與 footer 版面照 FormDialog md。
// - 輸入值去頭尾空白後與學號完全相同才啟用「永久刪除」；送出中取消、X、Esc 都無效。
// - 422 purge_confirmation_mismatch：輸入欄下紅字並清空；其他錯誤（例如 409 student_not_purgeable）顯示在 dialog 內。
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { purgeStudent, type PurgeResult, type StudentDetail } from '@/api/students'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  modelValue: boolean
  student: StudentDetail
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  purged: [result: PurgeResult]
}>()

const EFFECTS_TEXT =
  '永久刪除後將匿名化姓名，並清除身分證字號、健康備註、照片、監護人聯絡資料與家長綁定；出勤、成績等統計紀錄保留但不再能辨識此學生。此操作無法復原，並會記錄於稽核紀錄。'

const confirmText = ref('')
const errorMsg = ref('')
const mismatch = ref(false)
const loading = ref(false)

const canSubmit = computed(() => confirmText.value.trim() === props.student.student_no)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    confirmText.value = ''
    errorMsg.value = ''
    mismatch.value = false
  },
  { immediate: true },
)

function requestClose(): void {
  if (loading.value) return
  emit('update:modelValue', false)
}

async function submit(): Promise<void> {
  if (loading.value || !canSubmit.value) return
  errorMsg.value = ''
  mismatch.value = false
  loading.value = true
  try {
    const result = await purgeStudent(props.student.id, confirmText.value.trim())
    ElMessage.success(`已永久刪除並匿名化（新編號 ${result.anonymized_student_no}）`)
    emit('purged', result)
    emit('update:modelValue', false)
  } catch (err) {
    if (errorCode(err) === 'purge_confirmation_mismatch') {
      mismatch.value = true
      confirmText.value = ''
    } else {
      errorMsg.value = errorMessage(err, '永久刪除失敗，請稍後再試')
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-dialog
    class="purge-dialog"
    :model-value="modelValue"
    title="永久刪除學生資料"
    width="560px"
    :close-on-click-modal="false"
    :close-on-press-escape="!loading"
    :show-close="!loading"
    :before-close="requestClose"
    append-to-body
  >
    <el-alert
      type="error"
      :closable="false"
      show-icon
      :title="EFFECTS_TEXT"
    />
    <el-alert
      v-if="errorMsg"
      class="purge-alert"
      type="error"
      :closable="false"
      :title="errorMsg"
    />
    <div class="purge-confirm">
      <label
        class="purge-confirm__label"
        for="purge-confirm-input"
      >請輸入學號 <strong class="purge-confirm__no">{{ student.student_no }}</strong> 以確認</label>
      <el-input
        id="purge-confirm-input"
        v-model="confirmText"
        placeholder="輸入學號"
        autocomplete="off"
        :disabled="loading"
        @keyup.enter="submit"
      />
      <div
        v-if="mismatch"
        class="purge-mismatch"
        role="alert"
      >
        確認學號不符，請重新整理後再試
      </div>
    </div>
    <template #footer>
      <div class="purge-dialog__footer">
        <el-button
          :disabled="loading"
          @click="requestClose"
        >
          取消
        </el-button>
        <el-button
          type="danger"
          :loading="loading"
          :disabled="!canSubmit"
          @click="submit"
        >
          永久刪除
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.purge-alert {
  margin-top: 12px;
}

.purge-confirm {
  margin-top: 16px;
}

.purge-confirm__label {
  display: block;
  margin-bottom: 6px;
  font-size: 14px;
  color: var(--el-text-color-regular);
}

.purge-confirm__no {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--el-text-color-primary);
}

.purge-mismatch {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-color-danger);
}

.purge-dialog__footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.purge-dialog__footer :deep(.el-button + .el-button) {
  margin-left: 0;
}
</style>
