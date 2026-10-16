<script setup lang="ts">
// FRONTEND-094：學生 Excel 匯入（BACKEND-155 / 156：預覽不寫入、執行全有或全無）。
// 設計稿：docs/mockups/page-students.html（StudentImportDialog 段）。
// - FormDialog lg + el-steps 三步（選擇檔案 / 預覽 / 完成），送出鈕依步驟為「預覽」「匯入」「完成」。
// - 選檔先以 checkUpload(XLSX_RULE) 檢查；422 import_invalid_header 依 details {missing, unexpected} 分行列出，
//   import_too_many_rows / import_empty 等顯示後端訊息。
// - 有錯誤列時「匯入」停用；執行前確認；409 import_has_errors / import_conflict 顯示後端訊息並回到選檔步驟。
// - 關閉（與重新開啟）時重設所有狀態。
import {
  CircleCheck,
  Document,
  Download,
  RefreshLeft,
  UploadFilled,
  WarningFilled,
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox, type UploadFile } from 'element-plus'
import { computed, ref, watch } from 'vue'
import {
  downloadImportTemplate,
  executeImport,
  previewImport,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportResult,
} from '@/api/students'
import FormDialog from '@/components/common/FormDialog.vue'
import { saveBlobResponse } from '@/shared/http/download'
import { checkUpload, XLSX_RULE } from '@/shared/http/upload'
import { isApiError } from '@/shared/types/api'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'
import { academicYearOptions, currentAcademicYear } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  imported: [result: ImportResult]
}>()

type Step = 0 | 1 | 2

interface HeaderProblem {
  missing: string[]
  unexpected: string[]
}

const STEP_SUBMIT_TEXT = ['預覽', '匯入', '完成'] as const
const TEMPLATE_FILENAME = '學生匯入範本.xlsx'
const XLSX_ACCEPT = '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
/** 預覽表格的欄位：取後端 display 的範本欄名 */
const DISPLAY_KEYS = { studentNo: '學號*', name: '姓名*', grade: '年級*', className: '安親班班級' } as const

const { can } = usePermission()
const thisYear = currentAcademicYear()
const yearOptions = academicYearOptions(thisYear)

const step = ref<Step>(0)
const year = ref(thisYear)
const file = ref<File | null>(null)
const fileError = ref('')
const loading = ref(false)
const downloading = ref(false)
const onlyErrors = ref(false)
const headerProblem = ref<HeaderProblem | null>(null)
const backendMessage = ref('')
const preview = ref<ImportPreview | null>(null)
const created = ref(0)
const uploadRef = ref<{ clearFiles: () => void } | null>(null)

function reset(): void {
  step.value = 0
  year.value = thisYear
  file.value = null
  fileError.value = ''
  loading.value = false
  onlyErrors.value = false
  headerProblem.value = null
  backendMessage.value = ''
  preview.value = null
  created.value = 0
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
  },
)

const submitText = computed(() => STEP_SUBMIT_TEXT[step.value])
const submitDisabled = computed(
  () => (step.value === 0 && !file.value) || (step.value === 1 && (preview.value?.invalid ?? 0) > 0),
)
const invalidCount = computed(() => preview.value?.invalid ?? 0)
const visibleRows = computed<ImportPreviewRow[]>(() => {
  const rows = preview.value?.rows ?? []
  return onlyErrors.value ? rows.filter((r) => r.errors.length > 0) : rows
})

function cell(row: ImportPreviewRow, key: string): string {
  return row.display[key] || '—'
}

function clearMessages(): void {
  headerProblem.value = null
  backendMessage.value = ''
}

function onFileChange(uploadFile: UploadFile): void {
  uploadRef.value?.clearFiles()
  const raw = uploadFile.raw
  if (!raw) return
  clearMessages()
  const check = checkUpload(raw, XLSX_RULE)
  if (!check.ok) {
    file.value = null
    fileError.value = check.message
    return
  }
  file.value = raw
  fileError.value = ''
}

function parseHeaderProblem(details: unknown): HeaderProblem | null {
  if (details === null || typeof details !== 'object') return null
  const { missing, unexpected } = details as Partial<Record<keyof HeaderProblem, unknown>>
  if (!Array.isArray(missing) || !Array.isArray(unexpected)) return null
  return { missing: missing.map(String), unexpected: unexpected.map(String) }
}

/** 選檔步驟的錯誤：標題列問題分行列出，其餘顯示後端訊息 */
function showFileStepError(err: unknown, fallback: string): void {
  if (isApiError(err) && err.code === 'import_invalid_header') {
    const problem = parseHeaderProblem(err.details)
    if (problem) {
      headerProblem.value = problem
      return
    }
  }
  backendMessage.value = errorMessage(err, fallback)
}

async function runPreview(): Promise<void> {
  if (!file.value) return
  loading.value = true
  clearMessages()
  try {
    preview.value = await previewImport(file.value, year.value)
    onlyErrors.value = false
    step.value = 1
  } catch (err) {
    showFileStepError(err, '預覽失敗，請稍後再試')
  } finally {
    loading.value = false
  }
}

async function runImport(): Promise<void> {
  if (!file.value || !preview.value) return
  try {
    await ElMessageBox.confirm(`將建立 ${preview.value.valid} 位學生，確定匯入嗎？`, '確認匯入', {
      type: 'warning',
      confirmButtonText: '匯入',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  loading.value = true
  try {
    const result = await executeImport(file.value, year.value)
    created.value = result.created
    step.value = 2
    emit('imported', result)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'import_has_errors' || code === 'import_conflict') {
      // 預覽後資料有變：回到選檔步驟，保留檔案以便直接重新預覽
      backendMessage.value = errorMessage(err, '匯入資料有變動，請重新預覽')
      preview.value = null
      step.value = 0
    } else {
      ElMessage.error(errorMessage(err, '匯入失敗，請稍後再試'))
    }
  } finally {
    loading.value = false
  }
}

function submit(): void {
  if (step.value === 0) void runPreview()
  else if (step.value === 1) void runImport()
  else emit('update:modelValue', false)
}

function reupload(): void {
  step.value = 0
  file.value = null
  fileError.value = ''
  preview.value = null
  onlyErrors.value = false
  clearMessages()
}

async function downloadTemplate(): Promise<void> {
  downloading.value = true
  try {
    saveBlobResponse(await downloadImportTemplate(), TEMPLATE_FILENAME)
  } catch (err) {
    ElMessage.error(errorMessage(err, '下載範本失敗，請稍後再試'))
  } finally {
    downloading.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    title="匯入學生（Excel）"
    size="lg"
    :loading="loading"
    :autofocus="false"
    :submit-text="submitText"
    :cancel-text="step === 2 ? '關閉' : '取消'"
    :submit-disabled="submitDisabled"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
    @closed="reset"
  >
    <el-steps
      class="import-steps"
      :active="step"
      finish-status="success"
      simple
    >
      <el-step title="選擇檔案" />
      <el-step title="預覽" />
      <el-step title="完成" />
    </el-steps>

    <template v-if="step === 0">
      <el-alert
        v-if="headerProblem"
        class="import-alert"
        type="error"
        :closable="false"
        show-icon
        title="標題列不正確"
      >
        <div v-if="headerProblem.missing.length">
          缺少欄位：{{ headerProblem.missing.join('、') }}
        </div>
        <div v-if="headerProblem.unexpected.length">
          無法辨識的欄位：{{ headerProblem.unexpected.join('、') }}
        </div>
        <div>請確認標題列使用範本欄名。</div>
      </el-alert>
      <el-alert
        v-if="backendMessage"
        class="import-alert"
        type="error"
        :closable="false"
        show-icon
        :title="backendMessage"
      />
      <el-form
        label-position="top"
        @submit.prevent
      >
        <el-form-item label="學年度（決定「安親班班級」欄比對哪一學年度的班級）">
          <el-select
            v-model="year"
            class="import-year"
          >
            <el-option
              v-for="y in yearOptions"
              :key="y.value"
              :label="y.label"
              :value="y.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="檔案">
          <div class="import-file">
            <el-upload
              ref="uploadRef"
              drag
              :auto-upload="false"
              :accept="XLSX_ACCEPT"
              :show-file-list="false"
              :on-change="onFileChange"
            >
              <el-icon class="el-icon--upload">
                <UploadFilled />
              </el-icon>
              <div class="el-upload__text">
                把 .xlsx 拖到這裡，或<em>點擊選擇</em>
              </div>
            </el-upload>
            <div class="import-file__row">
              <span
                v-if="file"
                class="import-file__name"
                data-test="import-file-name"
              >
                <el-icon><Document /></el-icon>{{ file.name }}
              </span>
              <span class="import-file__spacer" />
              <el-button
                :loading="downloading"
                :icon="downloading ? undefined : Download"
                @click="downloadTemplate"
              >
                下載範本
              </el-button>
            </div>
            <div
              v-if="fileError"
              class="import-file__error"
            >
              {{ fileError }}
            </div>
          </div>
        </el-form-item>
      </el-form>
      <div class="import-fields">
        只支援以範本建立的檔案，最多 500 列。<br>
        必填：學號、姓名、年級<br>
        選填：性別、生日、就讀國小、學校班級、安親班班級、狀態、入學日、備註<br>
        敏感（需敏感資料權限）：身分證字號、健康備註
        <div
          v-if="!can('students:sensitive')"
          class="import-fields__warning"
        >
          <el-icon><WarningFilled /></el-icon> 你沒有敏感資料權限，含這兩欄資料的列會被標為錯誤
        </div>
      </div>
    </template>

    <template v-else-if="step === 1 && preview">
      <div class="import-summary">
        <span>共 {{ preview.total }} 列，正確 {{ preview.valid }} 列，<span :class="{ 'import-danger': invalidCount > 0 }">錯誤 {{ preview.invalid }} 列</span></span>
        <span class="import-file__spacer" />
        <el-switch
          v-model="onlyErrors"
          active-text="只顯示錯誤列"
          :disabled="invalidCount === 0"
        />
        <el-button
          :icon="RefreshLeft"
          @click="reupload"
        >
          重新上傳
        </el-button>
      </div>
      <el-alert
        v-if="invalidCount > 0"
        class="import-alert"
        type="error"
        :closable="false"
        show-icon
        title="請修正 Excel 中的錯誤後重新上傳（匯入為全部成功或全部不寫入）"
      />
      <el-table
        :data="visibleRows"
        row-key="row_number"
        border
        size="small"
        max-height="320"
      >
        <el-table-column
          prop="row_number"
          label="列號"
          width="64"
        />
        <!-- @vue-generic {ImportPreviewRow} -->
        <el-table-column
          label="學號"
          width="96"
        >
          <template #default="{ row }: { row: ImportPreviewRow }">
            {{ cell(row, DISPLAY_KEYS.studentNo) }}
          </template>
        </el-table-column>
        <!-- @vue-generic {ImportPreviewRow} -->
        <el-table-column
          label="姓名"
          width="96"
        >
          <template #default="{ row }: { row: ImportPreviewRow }">
            {{ cell(row, DISPLAY_KEYS.name) }}
          </template>
        </el-table-column>
        <!-- @vue-generic {ImportPreviewRow} -->
        <el-table-column
          label="年級"
          width="80"
        >
          <template #default="{ row }: { row: ImportPreviewRow }">
            {{ cell(row, DISPLAY_KEYS.grade) }}
          </template>
        </el-table-column>
        <!-- @vue-generic {ImportPreviewRow} -->
        <el-table-column
          label="安親班班級"
          width="110"
          show-overflow-tooltip
        >
          <template #default="{ row }: { row: ImportPreviewRow }">
            {{ cell(row, DISPLAY_KEYS.className) }}
          </template>
        </el-table-column>
        <!-- @vue-generic {ImportPreviewRow} -->
        <el-table-column
          label="錯誤"
          min-width="200"
        >
          <template #default="{ row }: { row: ImportPreviewRow }">
            <span
              v-if="row.errors.length"
              class="import-error-cell"
            >{{ row.errors.join('\n') }}</span>
            <el-icon
              v-else
              class="import-ok"
              aria-label="正確"
            >
              <CircleCheck />
            </el-icon>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-result
      v-else-if="step === 2"
      icon="success"
      :title="`已建立 ${created} 位學生`"
      sub-title="列表已重新載入。"
    />
  </FormDialog>
</template>

<style scoped>
.import-steps {
  margin-bottom: 16px;
}

.import-alert {
  margin-bottom: 12px;
}

.import-year {
  width: 200px;
}

.import-file {
  width: 100%;
}

.import-file__row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  width: 100%;
  margin-top: 8px;
}

.import-file__name {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.import-file__spacer {
  flex: 1;
}

.import-file__error {
  margin-top: 6px;
  font-size: 13px;
  color: var(--el-color-danger);
}

.import-fields {
  padding: 10px 12px;
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}

.import-fields__warning {
  margin-top: 4px;
  color: var(--el-color-danger);
}

.import-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
}

.import-danger {
  color: var(--el-color-danger);
}

.import-error-cell {
  color: var(--el-color-danger);
  white-space: pre-line;
}

.import-ok {
  color: var(--el-color-success);
}
</style>
