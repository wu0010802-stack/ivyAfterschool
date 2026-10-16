<script setup lang="ts">
// FRONTEND-239：單次考試各科平均、最高、最低與填寫狀況（domain_spec M8：不做排名）。
// 設計稿：docs/mockups/page-exam-detail.html（各科平均分頁）。
// - 各計數與平均只計目前應考名單（BACKEND-559）：每科 已填 + 缺考 + 未填 = 應考人數；未填 > 0 以 warning 色標示。
// - refreshKey 變更時重新載入；載入失敗以 EmptyState error +「重試」取代表格。
import { ref, watch } from 'vue'
import { fetchExamSummary, type ExamSummary, type SubjectSummary } from '@/api/exams'
import EmptyState from '@/components/common/EmptyState.vue'
import { errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  examId: string
  /** 變更時重新載入（切到分頁、發布 / 取消發布、科目變更後） */
  refreshKey: number
}>()

const data = ref<ExamSummary | null>(null)
const state = ref<'loading' | 'error' | 'ready'>('loading')
const errorText = ref('')
// 連續觸發時只採用最後一次請求的回應
let seq = 0

async function load(): Promise<void> {
  const mySeq = ++seq
  state.value = 'loading'
  try {
    const summary = await fetchExamSummary(props.examId)
    if (mySeq !== seq) return
    data.value = summary
    state.value = 'ready'
  } catch (err) {
    if (mySeq !== seq) return
    errorText.value = errorMessage(err, '伺服器暫時沒有回應，請稍後再試')
    state.value = 'error'
  }
}

watch(() => [props.examId, props.refreshKey], () => void load(), { immediate: true })

function numText(n: number | null): string {
  return n === null ? '—' : String(n)
}

function averageText(row: SubjectSummary): string {
  return row.average === null ? '—' : row.average.toFixed(1)
}

/** 平均得分率 = average / full_score 的整數百分比 */
function rateText(row: SubjectSummary): string {
  if (row.average === null || row.full_score <= 0) return ''
  return `${Math.round((row.average / row.full_score) * 100)}%`
}
</script>

<template>
  <div class="summary">
    <el-skeleton
      v-if="state === 'loading'"
      :rows="5"
      animated
    />
    <EmptyState
      v-else-if="state === 'error' || !data"
      variant="error"
      title="無法載入各科平均"
      :description="errorText"
    >
      <template #action>
        <el-button
          class="touch"
          data-test="retry"
          @click="load"
        >
          重試
        </el-button>
      </template>
    </EmptyState>
    <template v-else>
      <div class="summary__head">
        <span class="summary__roster">應考 {{ data.roster_count }} 人</span>
        <span class="summary__note">平均只計有分數的學生，缺考與未填不計入；不做排名</span>
      </div>
      <EmptyState
        v-if="!data.subjects.length"
        variant="inline"
        title="尚未設定科目"
      />
      <el-table
        v-else
        :data="data.subjects"
        border
        class="summary__table"
      >
        <el-table-column
          prop="subject_name"
          label="科目"
          min-width="110"
        />
        <!-- @vue-generic {SubjectSummary} -->
        <el-table-column
          label="滿分"
          width="80"
          align="right"
        >
          <template #default="{ row }: { row: SubjectSummary }">
            <span class="summary__num">{{ numText(row.full_score) }}</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {SubjectSummary} -->
        <el-table-column
          label="平均"
          width="120"
          align="right"
        >
          <template #default="{ row }: { row: SubjectSummary }">
            <div
              class="summary__avg"
              :class="{ 'summary__dash': row.average === null }"
            >
              {{ averageText(row) }}
            </div>
            <div
              v-if="row.average !== null"
              class="summary__rate"
            >
              得分率 {{ rateText(row) }}
            </div>
          </template>
        </el-table-column>
        <!-- @vue-generic {SubjectSummary} -->
        <el-table-column
          label="最高"
          width="80"
          align="right"
        >
          <template #default="{ row }: { row: SubjectSummary }">
            <span
              class="summary__num"
              :class="{ 'summary__dash': row.max === null }"
            >{{ numText(row.max) }}</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {SubjectSummary} -->
        <el-table-column
          label="最低"
          width="80"
          align="right"
        >
          <template #default="{ row }: { row: SubjectSummary }">
            <span
              class="summary__num"
              :class="{ 'summary__dash': row.min === null }"
            >{{ numText(row.min) }}</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {SubjectSummary} -->
        <el-table-column
          label="已填"
          width="80"
          align="right"
        >
          <template #default="{ row }: { row: SubjectSummary }">
            <span class="summary__num">{{ row.scored_count }}</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {SubjectSummary} -->
        <el-table-column
          label="缺考"
          width="80"
          align="right"
        >
          <template #default="{ row }: { row: SubjectSummary }">
            <span class="summary__num">{{ row.absent_count }}</span>
          </template>
        </el-table-column>
        <!-- @vue-generic {SubjectSummary} -->
        <el-table-column
          label="未填"
          width="80"
          align="right"
        >
          <template #default="{ row }: { row: SubjectSummary }">
            <span
              class="summary__num"
              :class="{ 'is-warning': row.missing_count > 0 }"
            >{{ row.missing_count }}</span>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </div>
</template>

<style scoped>
.summary__head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: baseline;
  margin-bottom: 12px;
}

.summary__roster {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.summary__note {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.summary__table {
  max-width: 860px;
}

.summary__num,
.summary__avg {
  font-variant-numeric: tabular-nums;
}

.summary__avg {
  font-weight: 600;
}

.summary__rate {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.summary__dash {
  font-weight: normal;
  color: var(--el-text-color-placeholder);
}

.summary .is-warning {
  font-weight: 600;
  color: var(--el-color-warning-dark-2);
}

.touch.el-button {
  min-height: 44px;
}
</style>
