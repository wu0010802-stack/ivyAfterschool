<script setup lang="ts">
// FRONTEND-235：學生 × 科目成績輸入格（domain_spec M8：後台格狀輸入、逐格自動儲存）。
// 設計稿：docs/mockups/page-exam-detail.html（成績輸入分頁）；格子外觀與備註互動照 docs/mockups/component-exams.html。
// 鍵盤導覽參考 ivy FE:src/composables/useGridKeyboardNav.ts::useGridKeyboardNav（容器層 keydown + data-row / data-col），
// 補上 Tab / Shift+Tab 換列、→ / ← 依游標位置、Esc 還原與缺考格改聚焦「缺」。
// - 每格是 ScoreCell，值（含 note）與狀態由 useScoreAutosave 提供；ScoreCell 的 change 原樣交給 edit。
// - 備註圖示不在 Tab 順序裡，focusCell 只找分數輸入框 / 缺考格的「缺」；Shift+F2 交給 ScoreCell，這裡不攔截。
//   備註編輯框 teleport 到 body，裡面的鍵盤事件不會冒泡到格子的 keydown。
// - 已發布考試尚未選擇是否通知家長時（notifyParents null）useScoreAutosave 不送出；本元件在格子變更後同一個 debounce
//   到期仍在等選擇時開 RenotifyChoiceDialog。expose 的 flush() 不開 dialog（view 離開、發布、重新載入前呼叫）。
// - 考試由草稿變成已發布（考試頁發布後呼叫 expose 的 markPublished()，或 load() 拿到的狀態改變）：
//   尚未送出的格子不再以草稿身分送出，改等通知選擇，並以同一個 debounce 開 dialog。
// - 表格高度是 100%：由父層（考試頁）給定內容區剩餘高度，表頭固定、只捲表格本體。
// - 每場考試各有一個 useScoreAutosave（放在 detached effect scope，examId 固定）。examId 變更時丟棄前一場考試
//   尚未送出（dirty / 等待通知選擇 / 儲存失敗）的格子：已送出中的請求照原考試完成，之後不再送出前一場的格子，
//   也不會以新的 examId 送出；表格清空到新考試載入完成。換參數前的送出與「放棄變更」確認由考試頁負責。
import { CircleCheck, Loading, WarningFilled } from '@element-plus/icons-vue'
import {
  computed,
  effectScope,
  nextTick,
  onBeforeUnmount,
  reactive,
  ref,
  shallowRef,
  watch,
  type EffectScope,
  type Ref,
  type ShallowRef,
} from 'vue'
import { useRouter } from 'vue-router'
import {
  fetchScoreGrid,
  type Exam,
  type ExamSubject,
  type ScoreCell as ScoreCellData,
  type ScoreGridStudent,
} from '@/api/exams'
import EmptyState from '@/components/common/EmptyState.vue'
import {
  DEFAULT_DEBOUNCE_MS,
  useScoreAutosave,
  type ScoreCellEdit,
  type UseScoreAutosave,
} from '@/composables/useScoreAutosave'
import { errorMessage } from '@/shared/utils/errorMessage'
import RenotifyChoiceDialog from './RenotifyChoiceDialog.vue'
import ScoreCell from './ScoreCell.vue'

const props = defineProps<{
  examId: string
  canWrite: boolean
}>()

const emit = defineEmits<{ 'dirty-change': [hasUnsaved: boolean] }>()

const router = useRouter()

const state = ref<'loading' | 'error' | 'ready'>('loading')
const errorText = ref('')
const exam = shallowRef<Exam | null>(null)
const students = shallowRef<ScoreGridStudent[]>([])
const subjects = shallowRef<ExamSubject[]>([])

// RenotifyChoiceDialog 的開關與提示計時器（換考試時一併關閉）
const dialogOpen = ref(false)
let promptTimer: ReturnType<typeof setTimeout> | null = null

function clearPromptTimer(): void {
  if (promptTimer !== null) clearTimeout(promptTimer)
  promptTimer = null
}

// ---- 每場考試一個自動儲存 session ----
interface ExamSession {
  examId: string
  initial: ShallowRef<ScoreCellData[]>
  /** 草稿固定 false；已發布從 null（尚未選擇）開始 */
  notifyParents: Ref<boolean | null>
  /** 本 session 認定的考試狀態（null = 尚未載入）；markPublished 之後即為已發布，與 notifyParents 的選擇分開記 */
  status: Exam['status'] | null
  autosave: UseScoreAutosave
  scope: EffectScope
}

function createSession(examId: string): ExamSession {
  // detached：換考試時由本元件停止，不跟著元件以外的 scope
  const scope = effectScope(true)
  const initial = shallowRef<ScoreCellData[]>([])
  const notifyParents = ref<boolean | null>(false)
  const autosave = scope.run(() => useScoreAutosave({ examId: ref(examId), initial, notifyParents }))!
  return { examId, initial, notifyParents, autosave, scope, status: null }
}

/** 丟棄前一場考試尚未送出的格子：送出迴圈看到 null 就不再送出，停止 scope 清掉 debounce 與 watcher */
function discardSession(s: ExamSession): void {
  s.notifyParents.value = null
  s.scope.stop()
}

const session = shallowRef<ExamSession>(createSession(props.examId))

function current(): UseScoreAutosave {
  return session.value.autosave
}

const notifyParents = computed<boolean | null>({
  get: () => session.value.notifyParents.value,
  set: (v) => {
    session.value.notifyParents.value = v
  },
})
const hasUnsaved = computed(() => current().hasUnsaved.value)
const failedCount = computed(() => current().failedCount.value)
const saving = computed(() => current().saving.value)
const awaitingNotifyChoice = computed(() => current().awaitingNotifyChoice.value)

// ---- 載入 ----
let loadSeq = 0

/** 重新載入同一場考試時保留畫面上的表格直到新資料回來；第一次載入與換考試時顯示 skeleton */
async function load(): Promise<void> {
  const seq = ++loadSeq
  const s = session.value
  if (!exam.value) state.value = 'loading'
  try {
    const data = await fetchScoreGrid(s.examId)
    if (seq !== loadSeq) return
    exam.value = data.exam
    students.value = data.students
    subjects.value = [...data.subjects].sort((a, b) => a.sort_order - b.sort_order)
    s.initial.value = data.cells
    // 第一次載入或 session 認定的狀態改變：重新決定是否需要選擇通知；同一場已發布考試維持本次編輯期間的選擇
    // （markPublished 之後 session 已認定為已發布，重新載入拿到 published 不再重設）
    if (s.status === null) {
      s.status = data.exam.status
      s.notifyParents.value = data.exam.status === 'published' ? null : false
    } else if (s.status !== data.exam.status) {
      if (data.exam.status === 'published') becamePublished(s)
      else {
        s.status = data.exam.status
        s.notifyParents.value = false
      }
    }
    state.value = 'ready'
  } catch (err) {
    if (seq !== loadSeq) return
    errorText.value = errorMessage(err, '伺服器暫時沒有回應，請稍後再試')
    state.value = 'error'
  }
}

/**
 * session 由草稿變成已發布：通知選擇改為 null（尚未選擇），之後重新載入拿到 published 不再重設（已選的保留）。
 * 有未送出的格子時以同一個 debounce 開 RenotifyChoiceDialog（發布當下尚未送出的修改也要詢問）。
 */
function becamePublished(s: ExamSession): void {
  s.status = 'published'
  s.notifyParents.value = null
  if (s.autosave.hasUnsaved.value) schedulePrompt()
}

/** 換考試：丟棄前一場未送出的格子；exam 清空讓 load 顯示 skeleton，新考試載入前不顯示前一場的表格 */
function switchExam(examId: string): void {
  discardSession(session.value)
  session.value = createSession(examId)
  exam.value = null
  clearPromptTimer()
  dialogOpen.value = false
}

watch(
  () => props.examId,
  (examId, previous) => {
    if (previous !== undefined && examId !== previous) switchExam(examId)
    void load()
  },
  { immediate: true },
)

watch(hasUnsaved, (v) => emit('dirty-change', v))

const isPublished = computed(() => exam.value?.status === 'published')

const dirtyCount = computed(() => {
  let n = 0
  for (const st of students.value) {
    for (const sub of subjects.value) {
      if (current().cellState(st.id, sub.subject_id) === 'dirty') n += 1
    }
  }
  return n
})

function goSubjects(): void {
  void router.replace({ query: { tab: 'subjects' } })
}

// ---- 格子 ----
const cellKeys = reactive<Record<string, number>>({})
/** Esc 還原時重建 ScoreCell：卸載當下 blur 觸發的 change 不採用 */
const ignoring = new Set<string>()

function keyOf(studentId: string, subjectId: string): string {
  return `${studentId}:${subjectId}`
}

function cellKey(studentId: string, subjectId: string): string {
  const k = keyOf(studentId, subjectId)
  return `${k}:${cellKeys[k] ?? 0}`
}

function cellProps(studentId: string, sub: ExamSubject) {
  const autosave = current()
  const value = autosave.cellValue(studentId, sub.subject_id)
  return {
    score: value.score,
    isAbsent: value.is_absent,
    note: value.note,
    fullScore: sub.full_score,
    state: autosave.cellState(studentId, sub.subject_id),
    errorMessage: autosave.cellError(studentId, sub.subject_id) ?? '',
  }
}

function rowClass({ row }: { row: ScoreGridStudent }): string {
  return row.in_roster ? '' : 'row-out'
}

// ---- 重新通知選擇 ----

/** 與自動儲存同一個 debounce：到期時仍在等通知選擇就開 dialog（Esc / X 關閉後，下一次變更會再開） */
function schedulePrompt(): void {
  if (notifyParents.value !== null) return
  clearPromptTimer()
  promptTimer = setTimeout(() => {
    promptTimer = null
    if (awaitingNotifyChoice.value) dialogOpen.value = true
  }, DEFAULT_DEBOUNCE_MS)
}

function onCellChange(studentId: string, subjectId: string, value: ScoreCellEdit): void {
  if (ignoring.has(keyOf(studentId, subjectId))) return
  current().edit(studentId, subjectId, value)
  schedulePrompt()
}

/** 選擇後 useScoreAutosave 立即送出等待中的格子 */
function choose(notify: boolean): void {
  clearPromptTimer()
  dialogOpen.value = false
  notifyParents.value = notify
}

async function retry(): Promise<void> {
  await current().retryFailed()
  if (awaitingNotifyChoice.value) dialogOpen.value = true
}

// ---- 鍵盤導覽 ----
const tableWrap = ref<HTMLElement | null>(null)

function cellWrapAt(row: number, col: number): HTMLElement | null {
  return tableWrap.value?.querySelector<HTMLElement>(`.sg-cell[data-row="${row}"][data-col="${col}"]`) ?? null
}

/** 分數輸入框；缺考格（輸入框停用）改為「缺」勾選。備註圖示不在導覽範圍 */
function focusTarget(wrap: HTMLElement): HTMLInputElement | null {
  return (
    wrap.querySelector<HTMLInputElement>('input[inputmode="decimal"]:not([disabled])') ??
    wrap.querySelector<HTMLInputElement>('.score-cell__absent input[type="checkbox"]')
  )
}

function focusInput(input: HTMLInputElement): void {
  input.focus()
  if (input.type !== 'checkbox') input.select()
}

function focusCell(row: number, col: number): boolean {
  const wrap = cellWrapAt(row, col)
  const input = wrap ? focusTarget(wrap) : null
  if (!input) return false
  focusInput(input)
  return true
}

function revert(row: number, col: number): void {
  const st = students.value[row]
  const sub = subjects.value[col]
  if (!st || !sub) return
  const k = keyOf(st.id, sub.subject_id)
  ignoring.add(k)
  cellKeys[k] = (cellKeys[k] ?? 0) + 1
  // nextTick 在重建這次 render 之後執行：卸載時的 blur 已被忽略，再聚焦新的輸入框
  void nextTick(() => {
    ignoring.delete(k)
    focusCell(row, col)
  })
}

function onKeydown(e: KeyboardEvent): void {
  if (!props.canWrite || e.altKey || e.ctrlKey || e.metaKey) return
  // 中文輸入法組字中（例如輸入「缺」）的 Enter 不換格
  if (e.isComposing || e.keyCode === 229) return
  const target = e.target
  if (!(target instanceof HTMLInputElement)) return
  const wrap = target.closest<HTMLElement>('.sg-cell[data-row][data-col]')
  if (!wrap) return
  const row = Number(wrap.dataset.row)
  const col = Number(wrap.dataset.col)
  const lastRow = students.value.length - 1
  const lastCol = subjects.value.length - 1
  const isText = target.type !== 'checkbox'
  const caretAtEnd = !isText || (target.selectionStart === target.value.length && target.selectionEnd === target.value.length)
  const caretAtStart = !isText || (target.selectionStart === 0 && target.selectionEnd === 0)

  let to: [number, number] | null = null
  switch (e.key) {
    case 'Enter':
      to = e.shiftKey ? [row - 1, col] : [row + 1, col]
      break
    case 'ArrowDown':
      to = [row + 1, col]
      break
    case 'ArrowUp':
      to = [row - 1, col]
      break
    case 'Tab':
      if (e.shiftKey) to = col > 0 ? [row, col - 1] : row > 0 ? [row - 1, lastCol] : null
      else to = col < lastCol ? [row, col + 1] : row < lastRow ? [row + 1, 0] : null
      // 表格第一格的 Shift+Tab 與最後一格的 Tab：交給瀏覽器，離開表格
      if (!to) return
      break
    case 'ArrowRight':
      if (!caretAtEnd) return
      to = [row, col + 1]
      break
    case 'ArrowLeft':
      if (!caretAtStart) return
      to = [row, col - 1]
      break
    case 'Escape':
      if (isText) {
        e.preventDefault()
        revert(row, col)
      }
      return
    default:
      return
  }
  e.preventDefault()
  // 到表格邊界停在原格
  if (to[0] < 0 || to[0] > lastRow || to[1] < 0 || to[1] > lastCol) return
  focusCell(to[0], to[1])
}

/** 點格子內任何位置（不是輸入框、「缺」或備註圖示本身）都聚焦該格輸入框 */
function onCellClick(_row: unknown, _column: unknown, cell: HTMLElement, event: Event): void {
  if (!props.canWrite) return
  const target = event.target
  if (target instanceof Element && target.closest('input, label, button, .el-checkbox, .score-cell__note')) return
  const wrap = cell.querySelector<HTMLElement>('.sg-cell')
  const input = wrap ? focusTarget(wrap) : null
  if (input) focusInput(input)
}

// ---- expose ----
/** 送出未儲存的格子並等請求結束；不開 RenotifyChoiceDialog（已發布且尚未選擇時不送出） */
async function flush(): Promise<void> {
  clearPromptTimer()
  await current().flush()
}

/** 考試頁發布成功後呼叫（成績格重新載入前）：之後的修改都等待通知選擇 */
function markPublished(): void {
  if (session.value.status === 'draft') becamePublished(session.value)
}

// 卸載時停止目前 session 的 debounce 與 watcher（考試頁離開前已 flush）
onBeforeUnmount(() => {
  clearPromptTimer()
  session.value.scope.stop()
})

defineExpose({ hasUnsaved, failedCount, flush, reload: load, markPublished })
</script>

<template>
  <div class="score-grid">
    <el-skeleton
      v-if="state === 'loading'"
      class="sg-skeleton"
      :rows="7"
      animated
    />
    <EmptyState
      v-else-if="state === 'error'"
      variant="error"
      title="無法載入成績"
      :description="errorText"
    >
      <template #action>
        <el-button
          class="sg-touch"
          @click="load"
        >
          重試
        </el-button>
      </template>
    </EmptyState>
    <EmptyState
      v-else-if="!subjects.length"
      title="尚未設定科目"
      :description="canWrite ? '設定考試科目與滿分後才能輸入成績' : '有成績編輯權限的人設定科目後，這裡才會出現成績表'"
    >
      <template
        v-if="canWrite"
        #action
      >
        <el-button
          type="primary"
          class="sg-touch"
          @click="goSubjects"
        >
          前往科目設定
        </el-button>
      </template>
    </EmptyState>
    <template v-else>
      <div
        v-if="canWrite"
        class="grid-toolbar"
      >
        <span
          v-if="failedCount"
          class="grid-toolbar__status is-error"
        >
          <el-icon><WarningFilled /></el-icon>{{ failedCount }} 格儲存失敗
          <el-button
            link
            type="primary"
            class="sg-touch"
            @click="retry"
          >
            重試
          </el-button>
        </span>
        <span
          v-else-if="saving"
          class="grid-toolbar__status"
        ><el-icon class="sg-spin"><Loading /></el-icon>儲存中…</span>
        <span
          v-else-if="dirtyCount"
          class="grid-toolbar__status"
        >{{ dirtyCount }} 格尚未儲存</span>
        <span
          v-else
          class="grid-toolbar__status is-ok"
        ><el-icon><CircleCheck /></el-icon>所有變更已儲存</span>
        <span class="sg-keys"><kbd>Enter</kbd> 下一位　<kbd>Tab</kbd> 下一科　<kbd>Esc</kbd> 還原　輸入「缺」標記缺考　<kbd>Shift</kbd>+<kbd>F2</kbd> 備註</span>
        <span class="grid-toolbar__spacer" />
        <span
          v-if="isPublished"
          class="grid-toolbar__notify"
        >
          修改後通知家長：
          <el-radio-group
            class="sg-notify"
            :model-value="notifyParents ?? undefined"
            @update:model-value="(v: string | number | boolean | undefined) => choose(v === true)"
          >
            <el-radio-button :value="true">開</el-radio-button>
            <el-radio-button :value="false">關</el-radio-button>
          </el-radio-group>
          <el-tag
            v-if="notifyParents === null"
            type="warning"
            size="small"
            disable-transitions
          >尚未選擇</el-tag>
        </span>
      </div>
      <div
        ref="tableWrap"
        class="sg-table"
        @keydown="onKeydown"
      >
        <el-table
          :data="students"
          border
          height="100%"
          row-key="id"
          :row-class-name="rowClass"
          @cell-click="onCellClick"
        >
          <el-table-column
            prop="student_no"
            label="學號"
            width="88"
            fixed
          />
          <!-- @vue-generic {ScoreGridStudent} -->
          <el-table-column
            label="姓名"
            width="118"
            fixed
          >
            <template #default="{ row }: { row: ScoreGridStudent }">
              <div class="sg-name">
                {{ row.name }}
              </div>
              <el-tag
                v-if="!row.in_roster"
                class="sg-out-tag"
                size="small"
                type="info"
                disable-transitions
              >
                已不在名單
              </el-tag>
            </template>
          </el-table-column>
          <!-- @vue-generic {ScoreGridStudent} -->
          <el-table-column
            label="班級"
            width="100"
            fixed
            show-overflow-tooltip
          >
            <template #default="{ row }: { row: ScoreGridStudent }">
              {{ row.class_name || '—' }}
            </template>
          </el-table-column>
          <!-- @vue-generic {ScoreGridStudent} -->
          <el-table-column
            v-for="(sub, ci) in subjects"
            :key="sub.subject_id"
            min-width="140"
            align="center"
          >
            <template #header>
              <span class="sg-head"><span class="sg-head__name">{{ sub.subject_name }}</span><span class="sg-head__full">（滿分 {{ sub.full_score }}）</span></span>
            </template>
            <template #default="{ row, $index }: { row: ScoreGridStudent; $index: number }">
              <div
                class="sg-cell"
                :class="{ 'is-readonly': !canWrite }"
                :data-row="$index"
                :data-col="ci"
              >
                <ScoreCell
                  :key="cellKey(row.id, sub.subject_id)"
                  v-bind="cellProps(row.id, sub)"
                  :readonly="!canWrite"
                  @change="(v) => onCellChange(row.id, sub.subject_id, v)"
                />
              </div>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState
              variant="inline"
              title="此考試沒有應考學生，請確認年級或班級設定"
            />
          </template>
        </el-table>
      </div>
    </template>
    <RenotifyChoiceDialog
      v-if="canWrite"
      v-model="dialogOpen"
      :pending-count="dirtyCount"
      @choose="choose"
    />
  </div>
</template>

<style scoped>
/* 高度由父層給定；表頭固定，只捲表格本體 */
.score-grid {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.sg-skeleton {
  padding: 8px 0;
}

.sg-touch.el-button {
  min-height: 44px;
}

.grid-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  min-height: 44px;
  margin-bottom: 8px;
  font-size: 13px;
}

.grid-toolbar__status {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  color: var(--el-text-color-secondary);
}

.grid-toolbar__status.is-ok {
  color: var(--el-color-success);
}

.grid-toolbar__status.is-error {
  color: var(--el-color-danger);
}

.grid-toolbar__spacer {
  flex: 1;
}

.grid-toolbar__notify {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}

.sg-keys {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.sg-keys kbd {
  padding: 0 5px;
  margin: 0 2px;
  font-family: inherit;
  font-size: 11px;
  line-height: 18px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 3px;
}

.sg-notify :deep(.el-radio-button__inner) {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 18px;
}

.sg-spin {
  animation: sg-spin 1s linear infinite;
}

@keyframes sg-spin {
  to {
    transform: rotate(360deg);
  }
}

.sg-table {
  flex: 1 1 auto;
  min-height: 0;
}

.sg-table :deep(.el-table__body .el-table__cell) {
  padding: 6px 0;
}

/* 鍵盤移動時，被左側固定欄（學號 88 + 姓名 118 + 班級 100）遮住的格子捲到可見 */
.sg-table :deep(.el-table__body-wrapper .el-scrollbar__wrap) {
  scroll-padding-left: 306px;
}

.sg-head {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.35;
}

.sg-head__full {
  font-size: 12px;
  font-weight: normal;
  color: var(--el-text-color-secondary);
}

.sg-name {
  white-space: nowrap;
}

.sg-out-tag {
  margin-top: 2px;
}

/* 列高 ≥ 48px；點格子內任何位置都聚焦輸入框 */
.sg-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  cursor: text;
}

.sg-cell.is-readonly {
  min-height: 28px;
  cursor: default;
}

/* 已不在名單：只淡化儲存格內容；固定欄底色保持不透明，橫向捲動時不會透出後面的格子 */
.sg-table :deep(.row-out > td > .cell) {
  opacity: 0.55;
}

@media (prefers-reduced-motion: reduce) {
  .sg-spin {
    animation: none;
  }
}
</style>
