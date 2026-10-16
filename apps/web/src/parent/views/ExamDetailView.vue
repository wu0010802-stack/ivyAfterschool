<script setup lang="ts">
/**
 * 單次考試成績明細（/exams/:examId）。標頭卡（名稱、類型標籤、日期、考試備註）+ 各科成績表。
 * 404（未公布、不屬於該小孩、不存在：後端三者回同一個 exam_not_found）顯示「找不到」；其他錯誤顯示重試。
 * 考試屬於特定小孩：在本頁切換小孩（或目前小孩從清單消失）→ router.replace('/exams')，
 * 用 replace 讓返回鍵不會回到不屬於新小孩的明細。成績公布後很少變動，不提供下拉重新整理。
 * 請求以序號保護：切換 examId、重試後較舊的回應一律丟棄。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isApiError } from '@/shared/types/api'
import { formatDate, weekdayLabel } from '@/shared/utils/datetime'
import { getChildExam, type ParentExamDetail } from '../api/exams'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import ExamScoreTable from '../components/exams/ExamScoreTable.vue'
import M3Card from '../components/m3/M3Card.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { useChildrenStore } from '../stores/children'

const route = useRoute()
const router = useRouter()
const children = useChildrenStore()

const status = ref<'loading' | 'ready' | 'notfound' | 'error'>('loading')
const exam = ref<ParentExamDetail | null>(null)

// 每次載入遞增；較舊請求的回應（序號不符）一律丟棄
let requestSeq = 0

const examId = computed(() => {
  const param = route.params.examId
  return (Array.isArray(param) ? param[0] : param) ?? ''
})

// 沒有選中的小孩時不打 API：小孩清單載入中顯示骨架，載入失敗顯示錯誤，載入完成但沒有小孩則找不到這次考試
const view = computed<'loading' | 'data' | 'notfound' | 'error'>(() => {
  if (children.selectedId === null) {
    if (children.error && !children.loaded) return 'error'
    return children.loaded ? 'notfound' : 'loading'
  }
  if (status.value === 'ready') return exam.value ? 'data' : 'loading'
  return status.value
})

// 'YYYY/MM/DD（X）'，與 ExamListItem 同一個寫法；日期不合法時只顯示佔位符
const dateText = computed(() => {
  const date = exam.value?.exam_date ?? null
  const formatted = formatDate(date)
  return date === null || formatted === '—' ? formatted : `${formatted}（${weekdayLabel(date)}）`
})

async function load(): Promise<void> {
  const id = examId.value
  // 已離開明細路由（例如正要 replace 回列表）時不再請求
  if (!id) return
  const seq = ++requestSeq
  status.value = 'loading'
  exam.value = null
  const childId = children.selectedId
  if (childId === null) return
  try {
    const result = await getChildExam(childId, id)
    if (seq !== requestSeq) return
    exam.value = result
    status.value = 'ready'
  } catch (error) {
    if (seq !== requestSeq) return
    status.value = isApiError(error) && error.status === 404 ? 'notfound' : 'error'
  }
}

function retry(): void {
  if (children.selectedId === null) void children.load(true)
  else void load()
}

function goList(): void {
  void router.replace('/exams')
}

watch(
  [() => children.selectedId, examId],
  ([childId], [previousChildId]) => {
    // 小孩從一位換成另一位（首次選到小孩不算）：考試屬於特定小孩，回列表
    if (previousChildId != null && childId !== null && childId !== previousChildId) {
      requestSeq += 1
      goList()
      return
    }
    void load()
  },
  { immediate: true },
)

onMounted(() => {
  void children.load()
})
</script>

<template>
  <div class="exam-detail-view">
    <div class="page-stack">
      <ChildContextHeader
        :children="children.items"
        :selected-id="children.selectedId"
        @select="children.select"
      />

      <template v-if="view === 'data' && exam">
        <M3Card
          variant="outlined"
          class="ed-head"
        >
          <h2 class="ed-head__name m3-title-large">
            {{ exam.name }}
          </h2>
          <div class="ed-head__meta m3-body-medium">
            <span class="exam-type m3-label-medium">{{ exam.exam_type_name }}</span>
            <span>{{ dateText }}</span>
          </div>
          <p
            v-if="exam.note"
            class="ed-head__note m3-body-medium"
          >
            備註：{{ exam.note }}
          </p>
        </M3Card>
        <M3Card
          variant="outlined"
          padding="none"
          class="score-card"
        >
          <ExamScoreTable :subjects="exam.subjects" />
        </M3Card>
      </template>
      <template v-else-if="view === 'loading'">
        <SkeletonBlock variant="card" />
        <M3Card
          variant="outlined"
          padding="none"
          class="score-card"
        >
          <SkeletonBlock
            variant="row"
            :count="4"
          />
        </M3Card>
      </template>
      <ParentEmptyState
        v-else-if="view === 'notfound'"
        icon="search_off"
        title="找不到這次考試的成績"
        description="可能尚未公布或不屬於目前選擇的小孩"
        action-label="回成績列表"
        @action="goList"
      />
      <ParentEmptyState
        v-else
        variant="error"
        title="成績載入失敗"
        @action="retry"
      />
    </div>
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、底部 24px 內距（ParentLayout 不再加） */
.exam-detail-view {
  padding: 0 16px 24px;
}

.page-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}

.ed-head__name {
  margin: 0;
  color: var(--m3-on-surface);
  overflow-wrap: anywhere;
}

.ed-head__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

/* 考試類型標籤：與 ExamListItem 的 .exam-item__type 同一個樣式（類型只是分類，用 tertiary） */
.exam-type {
  display: inline-block;
  max-width: 96px;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--m3-shape-extra-small);
  background: var(--m3-tertiary-container);
  color: var(--m3-on-tertiary-container);
  line-height: 24px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 備註保留換行；沒有備註時整段不渲染 */
.ed-head__note {
  margin: 12px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--m3-outline-variant);
  color: var(--m3-on-surface-variant);
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.score-card {
  overflow: hidden;
}
</style>
