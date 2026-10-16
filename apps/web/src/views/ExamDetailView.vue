<script setup lang="ts">
// FRONTEND-234：考試詳情（/exams/:id，exams:read）。新做（domain_spec §4、M8）。設計稿：docs/mockups/page-exam-detail.html。
// - header：返回「考試列表」、名稱 / 副標 / 狀態列；動作依權限隱藏（不是 disabled）：刪除（write、草稿）、編輯資訊（write）、
//   發布（publish、草稿）、取消發布（publish、已發布）；兩者都沒有時顯示「你只有檢視權限」。
// - 分頁存在 route.query.tab（scores 預設 / summary / subjects），lazy 載入、切走不卸載。
// - 成績格（ScoreGrid）有未儲存 / 儲存中 / 失敗的格子時：離開路由或只換考試 id、發布、取消發布、重新載入成績格之前先 flush，
//   仍未儲存就 confirmDiscardChanges。選「放棄變更」時以 key 重建成績格（ScoreGrid 的 reload 會保留未儲存的格子）。
// - 版面：本頁根元素是高度 100% 的 flex 欄（AdminLayout 的 main 有確定高度），面板、分頁與成績分頁一路 min-height: 0，
//   ScoreGrid 根元素 height 100%、表頭固定只捲表格本體；其他分頁內容過長時在分頁內捲動。
import { ArrowLeft, Delete, Document, Edit, Lock, Promotion, RefreshLeft } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import {
  deleteExam,
  fetchExamSummary,
  getExam,
  publishExam,
  unpublishExam,
  type Exam,
} from '@/api/exams'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import ExamFormDialog from '@/components/exams/ExamFormDialog.vue'
import ExamSubjectsEditor from '@/components/exams/ExamSubjectsEditor.vue'
import ExamSummaryTable from '@/components/exams/ExamSummaryTable.vue'
import ScoreGrid from '@/components/exams/ScoreGrid.vue'
import { useConfirmDelete } from '@/composables/useConfirmDelete'
import { confirmDiscardChanges } from '@/composables/useFormDirty'
import { PERMISSIONS } from '@/constants/permissions'
import { EXAM_STATUS_META } from '@/shared/constants/statusLabels'
import { isApiError } from '@/shared/types/api'
import { formatDateTime, formatDateWithWeekday } from '@/shared/utils/datetime'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'
import { gradeLabel } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

const props = defineProps<{ id: string }>()

type TabName = 'scores' | 'summary' | 'subjects'
const TABS: readonly TabName[] = ['scores', 'summary', 'subjects']

const route = useRoute()
const router = useRouter()
const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.EXAMS_WRITE))
const canPublish = computed(() => can(PERMISSIONS.EXAMS_PUBLISH))

// ---- 載入考試 ----
const pageState = ref<'loading' | 'notfound' | 'error' | 'ready'>('loading')
const errorText = ref('')
const exam = ref<Exam | null>(null)
let loadSeq = 0

/** silent：重新載入時保留畫面（發布、編輯資訊等之後），失敗只提示 */
async function loadExam(silent = false): Promise<void> {
  const seq = ++loadSeq
  if (!silent) pageState.value = 'loading'
  try {
    const data = await getExam(props.id)
    if (seq !== loadSeq) return
    exam.value = data
    pageState.value = 'ready'
  } catch (err) {
    if (seq !== loadSeq) return
    if (silent) {
      ElMessage.error(errorMessage(err, '無法重新載入考試，請重新整理頁面'))
      return
    }
    if (isApiError(err) && err.status === 404) {
      pageState.value = 'notfound'
      return
    }
    errorText.value = errorMessage(err, '伺服器暫時沒有回應，請稍後再試')
    pageState.value = 'error'
  }
}

watch(
  () => props.id,
  () => {
    exam.value = null
    void loadExam()
  },
  { immediate: true },
)

const isPublished = computed(() => exam.value?.status === 'published')

/** 「三年級」「低年級A班」「低年級A班・二年級」 */
function targetLabel(e: Exam): string {
  const parts: string[] = []
  if (e.class) parts.push(e.class.name)
  if (e.grade_level !== null) parts.push(gradeLabel(e.grade_level))
  return parts.join('・') || '—'
}

const subtitle = computed(() => {
  const e = exam.value
  if (!e) return ''
  return [e.exam_type.name, formatDateWithWeekday(e.exam_date), targetLabel(e), `應考 ${e.roster_count} 人`].join('・')
})

// ---- 分頁 ----
function tabFromQuery(): TabName {
  const raw = route.query.tab
  return typeof raw === 'string' && (TABS as readonly string[]).includes(raw) ? (raw as TabName) : 'scores'
}

/**
 * 本地分頁狀態與 route.query.tab 雙向同步：el-tabs 點擊當下就切換並掛載 lazy 分頁，
 * 若只靠網址（router.replace 之後才更新）會先以舊的 refreshKey 掛上各科平均、再因 key 遞增重抓一次。
 */
const tab = ref<TabName>(tabFromQuery())
const summaryKey = ref(0)

watch(
  () => route.query.tab,
  () => {
    tab.value = tabFromQuery()
  },
)
watch(tab, (t) => {
  if (t === 'summary') summaryKey.value += 1
  if (tabFromQuery() !== t) void router.replace({ query: { ...route.query, tab: t } })
})

/** 科目設定需要各科已輸入成績數（移除有成績的科目前確認）；序號防護：快速換考試時只套用最新一次的回應 */
const scoredCounts = ref<Record<string, number>>({})
let scoredSeq = 0
async function loadScoredCounts(): Promise<void> {
  const seq = ++scoredSeq
  try {
    const summary = await fetchExamSummary(props.id)
    if (seq !== scoredSeq) return
    scoredCounts.value = Object.fromEntries(summary.subjects.map((s) => [s.subject_id, s.scored_count]))
  } catch {
    // 拿不到筆數時沿用上一次的值；科目設定本身仍可操作
  }
}
watch(
  () => [tab.value, props.id] as const,
  ([t]) => {
    if (t === 'subjects') void loadScoredCounts()
  },
  { immediate: true },
)

// ---- 成績格 ----
const scoreGrid = ref<InstanceType<typeof ScoreGrid> | null>(null)
/** 遞增即重建成績格：丟棄未儲存的格子並重新載入 */
const gridKey = ref(0)

type GridSettle = 'clean' | 'discard' | 'cancel'

/** 送出成績格未儲存的格子（不開重新通知 dialog）；仍有未儲存 / 失敗時詢問是否放棄。成績格未掛載時視為乾淨 */
async function settleGrid(): Promise<GridSettle> {
  const grid = scoreGrid.value
  if (!grid || !grid.hasUnsaved) return 'clean'
  await grid.flush()
  if (!grid.hasUnsaved) return 'clean'
  return (await confirmDiscardChanges('page')) ? 'discard' : 'cancel'
}

/** 重新載入成績格；settled 為已先處理過未儲存格子的結果（避免重複詢問） */
async function refreshGrid(settled?: GridSettle): Promise<void> {
  const result = settled ?? (await settleGrid())
  if (result === 'cancel') return
  if (result === 'discard') {
    gridKey.value += 1
    return
  }
  await scoreGrid.value?.reload()
}

/** 發布 / 取消發布 / 編輯資訊 / 科目變更之後：重新載入考試、各科平均與成績格 */
async function reloadAll(settled?: GridSettle): Promise<void> {
  await loadExam(true)
  summaryKey.value += 1
  if (tab.value === 'subjects') void loadScoredCounts()
  await refreshGrid(settled)
}

// ---- 離開保護 ----
/** 刪除成功後直接回列表，不再送出成績格也不詢問 */
let skipLeaveGuard = false

async function canLeave(): Promise<boolean> {
  if (skipLeaveGuard) return true
  return (await settleGrid()) !== 'cancel'
}

onBeforeRouteLeave(() => canLeave())
// /exams/:id 只換參數時元件沿用：換考試比照離開路由；只換分頁（query）不處理
onBeforeRouteUpdate((to, from) => (to.params.id === from.params.id ? true : canLeave()))

function goList(): void {
  void router.push('/exams')
}

// ---- 動作 ----
const busy = ref<'' | 'publish' | 'unpublish' | 'delete'>('')
const formOpen = ref(false)

async function confirmBox(message: string, title: string, confirmText: string, cancelText: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, {
      type: 'warning',
      confirmButtonText: confirmText,
      cancelButtonText: cancelText,
    })
    return true
  } catch {
    return false
  }
}

async function onStatusConflict(settled?: GridSettle): Promise<void> {
  ElMessage.warning('考試狀態已變更，已重新載入')
  await reloadAll(settled)
}

async function publish(): Promise<void> {
  if (busy.value) return
  busy.value = 'publish'
  try {
    // 先送出成績格未儲存的格子；送出後仍有儲存失敗的格子就不發布
    const grid = scoreGrid.value
    if (grid) {
      await grid.flush()
      if (grid.failedCount > 0) {
        ElMessage.warning(`有 ${grid.failedCount} 格成績尚未儲存成功，請先重試後再發布`)
        return
      }
    }
    let missing = 0
    try {
      const summary = await fetchExamSummary(props.id)
      missing = summary.subjects.reduce((n, s) => n + s.missing_count, 0)
    } catch (err) {
      ElMessage.error(errorMessage(err, '無法取得未填格數，請稍後再試'))
      return
    }
    const missingText = missing > 0 ? `尚有 ${missing} 格未填，家長會看到「未登記」。` : ''
    const ok = await confirmBox(
      `發布後家長即可查看成績並收到通知。${missingText}確定發布嗎？`,
      '發布成績',
      '發布',
      '取消',
    )
    if (!ok) return
    try {
      exam.value = await publishExam(props.id)
    } catch (err) {
      const code = errorCode(err)
      if (code === 'exam_has_no_subjects') {
        ElMessage.warning('請先設定科目')
        tab.value = 'subjects'
      } else if (code === 'exam_already_published') {
        await onStatusConflict()
      } else {
        ElMessage.error(errorMessage(err, '發布失敗，請稍後再試'))
      }
      return
    }
    ElMessage.success('已發布，家長會收到成績通知')
    await reloadAll()
  } finally {
    busy.value = ''
  }
}

async function unpublish(): Promise<void> {
  if (busy.value) return
  const ok = await confirmBox(
    '取消發布後家長將看不到此次成績，已送出的通知不會收回。',
    '取消發布',
    '取消發布',
    '返回',
  )
  if (!ok) return
  busy.value = 'unpublish'
  try {
    const settled = await settleGrid()
    if (settled === 'cancel') return
    try {
      exam.value = await unpublishExam(props.id)
    } catch (err) {
      if (errorCode(err) === 'exam_not_published') await onStatusConflict(settled)
      else ElMessage.error(errorMessage(err, '取消發布失敗，請稍後再試'))
      return
    }
    ElMessage.success('已取消發布')
    await reloadAll(settled)
  } finally {
    busy.value = ''
  }
}

const { confirmDelete } = useConfirmDelete<Exam>({
  request: (row) => deleteExam(row.id),
  confirmMessage: (row) => `刪除後已輸入的成績會一併刪除，確定要刪除「${row.name}」嗎？`,
  onSuccess: () => {
    skipLeaveGuard = true
    goList()
  },
})

async function removeExam(): Promise<void> {
  if (busy.value || !exam.value) return
  busy.value = 'delete'
  try {
    await confirmDelete(exam.value)
  } finally {
    busy.value = ''
  }
}

/** 編輯資訊後：年級 / 班級變更會改變應考名單，重新載入考試與成績格 */
async function onEdited(updated: Exam): Promise<void> {
  exam.value = updated
  await reloadAll()
}

async function onSubjectsSaved(updated: Exam): Promise<void> {
  exam.value = updated
  await reloadAll()
}

async function onSubjectsConflict(): Promise<void> {
  await reloadAll()
}
</script>

<template>
  <div class="exam-detail">
    <div class="back-row">
      <el-button
        link
        class="back-link"
        :icon="ArrowLeft"
        @click="goList"
      >
        考試列表
      </el-button>
    </div>

    <div
      v-if="pageState === 'loading'"
      class="page-skeleton"
    >
      <el-skeleton animated>
        <template #template>
          <el-skeleton-item
            variant="h1"
            class="page-skeleton__title"
          />
          <el-skeleton-item
            variant="text"
            class="page-skeleton__line"
          />
          <el-skeleton-item
            variant="text"
            class="page-skeleton__line page-skeleton__line--short"
          />
          <el-skeleton-item
            variant="rect"
            class="page-skeleton__body"
          />
        </template>
      </el-skeleton>
    </div>
    <EmptyState
      v-else-if="pageState === 'notfound'"
      title="找不到此考試"
      description="這場考試可能已被刪除，或網址不正確"
      :icon="Document"
    >
      <template #action>
        <el-button
          type="primary"
          class="touch"
          @click="goList"
        >
          回考試列表
        </el-button>
      </template>
    </EmptyState>
    <EmptyState
      v-else-if="pageState === 'error' || !exam"
      variant="error"
      title="無法載入考試"
      :description="errorText"
    >
      <template #action>
        <el-button
          class="touch"
          @click="loadExam()"
        >
          重試
        </el-button>
      </template>
    </EmptyState>
    <template v-else>
      <PageHeader
        :title="exam.name"
        :subtitle="subtitle"
      >
        <div class="exam-meta">
          <el-tag
            :type="EXAM_STATUS_META[exam.status].tone"
            disable-transitions
          >
            {{ EXAM_STATUS_META[exam.status].label }}
          </el-tag>
          <span v-if="isPublished">{{ exam.published_by_name }} 於 {{ formatDateTime(exam.published_at) }} 發布・修改分數會記錄於稽核紀錄</span>
          <span v-else>尚未發布，家長看不到這次成績</span>
          <span
            v-if="exam.note"
            class="exam-meta__note"
            :title="exam.note"
          >備註：{{ exam.note }}</span>
        </div>
        <template #actions>
          <span
            v-if="!canWrite && !canPublish"
            class="readonly-hint"
          ><el-icon><Lock /></el-icon>你只有檢視權限</span>
          <el-button
            v-if="canWrite && !isPublished"
            class="touch"
            type="danger"
            plain
            :icon="Delete"
            :disabled="!!busy"
            @click="removeExam"
          >
            刪除
          </el-button>
          <el-button
            v-if="canWrite"
            class="touch"
            :icon="Edit"
            :disabled="!!busy"
            @click="formOpen = true"
          >
            編輯資訊
          </el-button>
          <el-button
            v-if="canPublish && !isPublished"
            class="touch"
            type="primary"
            :icon="Promotion"
            :loading="busy === 'publish'"
            :disabled="!!busy"
            @click="publish"
          >
            發布
          </el-button>
          <el-button
            v-if="canPublish && isPublished"
            class="touch"
            :icon="RefreshLeft"
            :loading="busy === 'unpublish'"
            :disabled="!!busy"
            @click="unpublish"
          >
            取消發布
          </el-button>
        </template>
      </PageHeader>

      <section class="detail-panel">
        <el-tabs
          v-model="tab"
          class="exam-tabs"
        >
          <el-tab-pane
            label="成績輸入"
            name="scores"
            lazy
          >
            <ScoreGrid
              :key="gridKey"
              ref="scoreGrid"
              :exam-id="id"
              :can-write="canWrite"
            />
          </el-tab-pane>
          <el-tab-pane
            label="各科平均"
            name="summary"
            lazy
          >
            <ExamSummaryTable
              :exam-id="id"
              :refresh-key="summaryKey"
            />
          </el-tab-pane>
          <el-tab-pane
            label="科目設定"
            name="subjects"
            lazy
          >
            <ExamSubjectsEditor
              :exam="exam"
              :scored-counts="scoredCounts"
              :can-write="canWrite"
              @saved="onSubjectsSaved"
              @conflict="onSubjectsConflict"
            />
          </el-tab-pane>
        </el-tabs>
      </section>

      <ExamFormDialog
        v-if="canWrite"
        v-model="formOpen"
        :exam="exam"
        @saved="onEdited"
      />
    </template>
  </div>
</template>

<style scoped>
/* 高度 = AdminLayout main 的內容區；成績分頁的表格填滿剩餘高度，頁面本身不捲 */
.exam-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.back-row,
.exam-detail :deep(.page-header) {
  flex: none;
}

.back-row {
  margin: -6px 0 4px;
}

.back-link.el-button {
  min-height: 32px;
  padding: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
}

.touch.el-button {
  min-height: 44px;
}

.exam-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.exam-meta__note {
  max-width: 440px;
  overflow: hidden;
  color: var(--el-text-color-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.readonly-hint {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  min-height: 44px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.page-skeleton {
  padding: 8px 0;
}

.page-skeleton__title {
  width: 220px;
  height: 28px;
}

.page-skeleton__line {
  display: block;
  width: 360px;
  margin-top: 12px;
}

.page-skeleton__line--short {
  width: 260px;
}

.page-skeleton__body {
  display: block;
  width: 100%;
  height: 380px;
  margin-top: 24px;
}

/* 白底面板：分頁與成績格一路 min-height: 0 傳下去；高度過小時保底，改由內容區捲動 */
.detail-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 360px;
  padding: 4px 16px 12px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.exam-tabs {
  --el-tabs-header-height: 44px;

  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.exam-tabs :deep(> .el-tabs__header) {
  flex: none;
  margin-bottom: 12px;
}

.exam-tabs :deep(.el-tabs__item) {
  font-size: 15px;
}

.exam-tabs :deep(> .el-tabs__content) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.exam-tabs :deep(> .el-tabs__content > .el-tab-pane) {
  height: 100%;
}
</style>
