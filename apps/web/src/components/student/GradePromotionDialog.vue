<script setup lang="ts">
// FRONTEND-095：學年升級（BACKEND-157 / 158：一到五年級 +1、六年級轉退班；班級不變）。
// 參考 ivy FE:src/api/students.ts::bulkGraduateStudents 的批次轉態用途；本專案改為預覽 → 輸入確認 → 執行。
// 設計稿：docs/mockups/page-students.html（GradePromotionDialog 段）。
// - 開啟即以「升級來源學年度」（預設本學年度 − 1）預覽；切換學年度重新預覽（序號防護，只採用最新回應）。
// - 執行前開輸入確認框，輸入「確認升級」四字才可按確定；送出 expected_total = 預覽當時的 total。
// - 409 preview_stale：提示「名單在預覽後有變動…」並自動重新預覽；409 already_promoted：顯示後端訊息並重新預覽。
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'
import {
  executePromotion,
  previewPromotion,
  type PromotionItem,
  type PromotionPreview,
  type PromotionResult,
} from '@/api/students'
import FormDialog from '@/components/common/FormDialog.vue'
import { todayTaipei } from '@/shared/utils/datetime'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'
import { academicYearOptions, currentAcademicYear, gradeLabel } from '@/utils/academicYear'

const props = defineProps<{ modelValue: boolean }>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  promoted: [result: PromotionResult]
}>()

const CONFIRM_PHRASE = '確認升級'

/** 來源學年度選項：本學年度到前三年（新到舊） */
const defaultYear = (): number => currentAcademicYear() - 1
const yearOptions = academicYearOptions(defaultYear(), 2, 1)

const year = ref(defaultYear())
const withdrawnOn = ref(todayTaipei())
const preview = ref<PromotionPreview | null>(null)
const previewLoading = ref(false)
const previewError = ref('')
const staleNotice = ref(false)
const executing = ref(false)
const tab = ref<'promote' | 'graduate'>('promote')
const confirmOpen = ref(false)
const confirmText = ref('')

let seq = 0

async function loadPreview(): Promise<void> {
  const mySeq = ++seq
  previewLoading.value = true
  previewError.value = ''
  try {
    const res = await previewPromotion(year.value)
    if (mySeq !== seq) return
    preview.value = res
  } catch (err) {
    if (mySeq !== seq) return
    preview.value = null
    previewError.value = errorMessage(err, '無法載入升級預覽，請稍後再試')
  } finally {
    if (mySeq === seq) previewLoading.value = false
  }
}

function reset(): void {
  year.value = defaultYear()
  withdrawnOn.value = todayTaipei()
  preview.value = null
  previewError.value = ''
  staleNotice.value = false
  executing.value = false
  tab.value = 'promote'
  confirmOpen.value = false
  confirmText.value = ''
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    reset()
    void loadPreview()
  },
  { immediate: true },
)

function onYearChange(): void {
  staleNotice.value = false
  void loadPreview()
}

const executeDisabled = computed(
  () => previewLoading.value || !preview.value || preview.value.already_promoted,
)
const confirmReady = computed(() => confirmText.value.trim() === CONFIRM_PHRASE)

function gradeChange(item: PromotionItem): string {
  return `${gradeLabel(item.grade_from)} → ${item.grade_to === null ? '退班' : gradeLabel(item.grade_to)}`
}

function askConfirm(): void {
  if (executeDisabled.value) return
  confirmText.value = ''
  confirmOpen.value = true
}

async function execute(): Promise<void> {
  const current = preview.value
  if (!current || !confirmReady.value) return
  confirmOpen.value = false
  executing.value = true
  try {
    const result = await executePromotion({
      from_academic_year: current.from_academic_year,
      expected_total: current.total,
      withdrawn_on: withdrawnOn.value,
    })
    ElMessage.success(`已升級 ${result.promoted} 位、退班 ${result.graduated} 位`)
    emit('promoted', result)
    emit('update:modelValue', false)
  } catch (err) {
    const code = errorCode(err)
    if (code === 'preview_stale') {
      staleNotice.value = true
      void loadPreview()
    } else if (code === 'already_promoted') {
      ElMessage.error(errorMessage(err, '此學年度已執行過升級'))
      void loadPreview()
    } else {
      ElMessage.error(errorMessage(err, '升級失敗，請稍後再試'))
    }
  } finally {
    executing.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    title="學年升級"
    size="lg"
    :loading="executing"
    :autofocus="false"
    submit-text="執行升級"
    :submit-disabled="executeDisabled"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="askConfirm"
  >
    <el-form
      label-position="top"
      @submit.prevent
    >
      <el-row :gutter="16">
        <el-col :span="8">
          <el-form-item label="升級來源學年度">
            <el-select
              v-model="year"
              @change="onYearChange"
            >
              <el-option
                v-for="y in yearOptions"
                :key="y.value"
                :label="y.label"
                :value="y.value"
              />
            </el-select>
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="六年級轉退班的退班日">
            <el-date-picker
              v-model="withdrawnOn"
              class="promotion-date"
              type="date"
              value-format="YYYY-MM-DD"
              format="YYYY-MM-DD"
              :clearable="false"
            />
          </el-form-item>
        </el-col>
      </el-row>
    </el-form>
    <el-alert
      v-if="staleNotice"
      class="promotion-alert"
      type="warning"
      :closable="false"
      show-icon
      title="名單在預覽後有變動，已重新預覽，請再次確認"
    />
    <el-alert
      v-if="preview?.already_promoted"
      class="promotion-alert"
      type="error"
      :closable="false"
      show-icon
      title="此學年度已執行過升級"
    />
    <el-alert
      v-if="previewError"
      class="promotion-alert"
      type="error"
      :closable="false"
      show-icon
      :title="previewError"
    />
    <div
      v-if="preview"
      v-loading="previewLoading"
    >
      <div class="promotion-summary">
        <strong>{{ preview.from_academic_year }} → {{ preview.to_academic_year }} 學年度：升級 {{ preview.promote.length }} 位、六年級轉退班 {{ preview.graduate.length }} 位</strong>
      </div>
      <el-alert
        class="promotion-alert"
        type="info"
        :closable="false"
        show-icon
        title="升級不會變更安親班班級，請於升級後到學生工作台調整"
      />
      <el-tabs v-model="tab">
        <el-tab-pane
          :label="`升級（${preview.promote.length}）`"
          name="promote"
        >
          <el-table
            :data="preview.promote"
            row-key="id"
            border
            size="small"
            max-height="260"
          >
            <el-table-column
              prop="student_no"
              label="學號"
              width="96"
            />
            <el-table-column
              prop="name"
              label="姓名"
              width="100"
            />
            <!-- @vue-generic {PromotionItem} -->
            <el-table-column label="年級">
              <template #default="{ row }: { row: PromotionItem }">
                {{ gradeChange(row) }}
              </template>
            </el-table-column>
            <!-- @vue-generic {PromotionItem} -->
            <el-table-column label="目前班級">
              <template #default="{ row }: { row: PromotionItem }">
                {{ row.class_name ?? '—' }}
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane
          :label="`六年級轉退班（${preview.graduate.length}）`"
          name="graduate"
        >
          <el-table
            :data="preview.graduate"
            row-key="id"
            border
            size="small"
            max-height="260"
          >
            <el-table-column
              prop="student_no"
              label="學號"
              width="96"
            />
            <el-table-column
              prop="name"
              label="姓名"
              width="100"
            />
            <!-- @vue-generic {PromotionItem} -->
            <el-table-column label="年級">
              <template #default="{ row }: { row: PromotionItem }">
                {{ gradeChange(row) }}
              </template>
            </el-table-column>
            <!-- @vue-generic {PromotionItem} -->
            <el-table-column label="目前班級">
              <template #default="{ row }: { row: PromotionItem }">
                {{ row.class_name ?? '—' }}
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
    <div
      v-else-if="previewLoading"
      v-loading="true"
      class="promotion-placeholder"
    />
  </FormDialog>

  <!-- 不可復原的批次操作：輸入「確認升級」才可執行 -->
  <el-dialog
    v-model="confirmOpen"
    title="確認執行學年升級"
    width="420px"
    :close-on-click-modal="false"
    append-to-body
  >
    <p
      v-if="preview"
      class="promotion-confirm__text"
    >
      將升級 {{ preview.promote.length }} 位、六年級轉退班 {{ preview.graduate.length }} 位，此操作無法復原。請輸入「{{ CONFIRM_PHRASE }}」以執行。
    </p>
    <el-input
      v-model="confirmText"
      :placeholder="CONFIRM_PHRASE"
    />
    <template #footer>
      <div class="promotion-confirm__footer">
        <el-button @click="confirmOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :disabled="!confirmReady"
          @click="execute"
        >
          確定
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.promotion-date {
  width: 100%;
}

.promotion-alert {
  margin-bottom: 12px;
}

.promotion-summary {
  margin-bottom: 12px;
  font-size: 14px;
}

.promotion-placeholder {
  min-height: 160px;
}

.promotion-confirm__text {
  margin: 0 0 12px;
  line-height: 1.7;
}

.promotion-confirm__footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.promotion-confirm__footer :deep(.el-button + .el-button) {
  margin-left: 0;
}
</style>
