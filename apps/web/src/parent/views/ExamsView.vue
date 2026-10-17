<script setup lang="ts">
/**
 * 成績列表（/exams，底部導覽「成績」）。只列已公布的考試（後端只回已發布），依後端順序（考試日期新到舊）；
 * 列表只做索引，不顯示分數、平均或名次。
 * 資料以請求序號保護：切換小孩、重試、下拉重新整理都會讓較舊的回應（含載入更多）被丟棄。
 * 載入更多以 exam_id 去重後附加；失敗只提示、保留已載入的清單與按鈕。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { listChildExams, type ParentExamSummary } from '../api/exams'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import ExamListItem from '../components/exams/ExamListItem.vue'
import M3Button from '../components/m3/M3Button.vue'
import M3Card from '../components/m3/M3Card.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import PullToRefresh from '../components/PullToRefresh.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'

const children = useChildrenStore()
const snackbar = useSnackbarStore()

const status = ref<'loading' | 'ready' | 'error'>('loading')
const items = ref<ParentExamSummary[]>([])
const total = ref(0)
const page = ref(1)
const loadingMore = ref(false)

// 每次載入第一頁 / 重新整理遞增；較舊請求的回應（序號不符）一律丟棄
let requestSeq = 0

// 沒有選中的小孩時不打 API：小孩清單載入中顯示骨架，載入失敗顯示錯誤，載入完成但沒有小孩則視為沒有成績
const view = computed<'loading' | 'data' | 'empty' | 'error'>(() => {
  if (children.selectedId === null) {
    if (children.error && !children.loaded) return 'error'
    return children.loaded ? 'empty' : 'loading'
  }
  if (status.value === 'ready') return items.value.length > 0 ? 'data' : 'empty'
  return status.value
})

const hasMore = computed(() => view.value === 'data' && items.value.length < total.value)

function applyFirstPage(result: { items: ParentExamSummary[]; total: number }): void {
  items.value = result.items
  total.value = result.total
  page.value = 1
  status.value = 'ready'
}

async function loadFirst(): Promise<void> {
  const childId = children.selectedId
  const seq = ++requestSeq
  status.value = 'loading'
  items.value = []
  total.value = 0
  page.value = 1
  loadingMore.value = false
  if (childId === null) return
  try {
    const result = await listChildExams(childId, 1)
    if (seq === requestSeq) applyFirstPage(result)
  } catch {
    if (seq === requestSeq) status.value = 'error'
  }
}

async function loadMore(): Promise<void> {
  const childId = children.selectedId
  if (childId === null || loadingMore.value) return
  const seq = requestSeq
  loadingMore.value = true
  try {
    const result = await listChildExams(childId, page.value + 1)
    if (seq !== requestSeq) return
    if (result.items.length === 0) {
      // 後端已沒有更多（例如期間有考試被取消公布）：不再顯示按鈕
      total.value = items.value.length
      return
    }
    const seen = new Set(items.value.map((e) => e.exam_id))
    items.value = [...items.value, ...result.items.filter((e) => !seen.has(e.exam_id))]
    total.value = result.total
    page.value += 1
  } catch {
    if (seq === requestSeq) snackbar.show('載入更多失敗，請稍後再試', { tone: 'error' })
  } finally {
    if (seq === requestSeq) loadingMore.value = false
  }
}

/** 下拉重新整理：重抓第一頁（重置分頁），期間保留現有內容；失敗只提示 */
async function refresh(): Promise<void> {
  const childId = children.selectedId
  if (childId === null) return
  const seq = ++requestSeq
  loadingMore.value = false
  try {
    const result = await listChildExams(childId, 1)
    if (seq === requestSeq) applyFirstPage(result)
  } catch {
    if (seq === requestSeq) snackbar.show('更新失敗，請稍後再試', { tone: 'error' })
  }
}

function retry(): void {
  if (children.selectedId === null) void children.load(true)
  else void loadFirst()
}

watch(() => children.selectedId, loadFirst, { immediate: true })

onMounted(() => {
  void children.load()
})
</script>

<template>
  <div class="exams-view">
    <PullToRefresh
      :on-refresh="refresh"
      :disabled="view === 'loading'"
    >
      <div class="page-stack">
        <ChildContextHeader
          :children="children.items"
          :selected-id="children.selectedId"
          @select="children.select"
        />

        <template v-if="view !== 'error'">
          <M3Card
            variant="outlined"
            padding="none"
            class="exam-card"
          >
            <ul
              v-if="view === 'data'"
              class="exam-list"
              role="list"
              aria-label="已公布的考試"
            >
              <ExamListItem
                v-for="exam in items"
                :key="exam.exam_id"
                :exam="exam"
              />
            </ul>
            <ParentEmptyState
              v-else-if="view === 'empty'"
              icon="grading"
              title="目前沒有已公布的成績"
              description="安親班公布考試成績後會通知您"
            />
            <SkeletonBlock
              v-else
              variant="row"
              :count="4"
              height="76px"
            />
          </M3Card>
          <M3Button
            v-if="hasMore"
            variant="outlined"
            block
            :loading="loadingMore"
            @click="loadMore"
          >
            載入更多
          </M3Button>
        </template>
        <ParentEmptyState
          v-else
          variant="error"
          title="成績載入失敗"
          @action="retry"
        />
      </div>
    </PullToRefresh>
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、底部 24px 內距（ParentLayout 不再加） */
.exams-view {
  padding: 0 16px 24px;
}

.page-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}

.exam-card {
  overflow: hidden;
}

.exam-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
</style>
