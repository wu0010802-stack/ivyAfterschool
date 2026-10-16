<script setup lang="ts">
// FRONTEND-236：單一成績格（分數、缺考、驗證、儲存狀態）。設計稿：docs/mockups/component-exams.html。
// - 允許空白（未填）、0~fullScore、最多一位小數；不合法即時紅框 + tooltip / title，不 emit。
// - 合法且與 props 不同才在 blur / Enter 時 emit；輸入「缺」或「-」等同勾選缺考。
// - saved 標記在 state 轉 idle 時淡出（轉換時機由 useScoreAutosave FRONTEND-237 決定）。
// FRONTEND-296：每格備註（domain_spec M8，最多 200 字、空白視為無備註）。
// - change 的 payload 為 {score, is_absent, note}：分數 / 缺考變更時 note 帶目前的原值；備註確定時 score / is_absent 帶 props 目前值。
// - 入口：「缺」右邊的圖示鈕（tabindex -1），或焦點在分數輸入框 / 缺考格的「缺」勾選上按 Shift+F2。
// - 編輯框是錨在圖示下方的 el-popover（teleport 到 body）：Enter 確定、Shift+Enter 換行、Esc 取消；
//   點編輯框外面視同確定（超過 200 字時不關閉、焦點拉回文字框）；再點同一格的圖示視同點外面。
// - 以確定 / 取消 / Enter / Esc 關閉時焦點回到同一格的分數輸入框（全選）；缺考格回到「缺」勾選。
//   Element Plus popover 的 focus trap 在 visible 轉 false 的那次 flush 裡把焦點還給觸發前的元素，所以本元件在 nextTick 之後才聚焦。
import { ChatLineSquare, ChatSquare, Check, Loading, WarningFilled } from '@element-plus/icons-vue'
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

type CellState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
interface CellValue {
  score: number | null
  is_absent: boolean
  note: string | null
}

const props = withDefaults(
  defineProps<{
    score: number | null
    isAbsent: boolean
    note: string | null
    fullScore: number
    state: CellState
    errorMessage?: string
    readonly: boolean
  }>(),
  { errorMessage: '' },
)

const emit = defineEmits<{ change: [value: CellValue] }>()

const ABSENT_INPUTS = new Set(['缺', '-'])
/** 與後端 ScoreCellIn.note 的 max_length 一致，以 trim 後的 code point 數計 */
const NOTE_MAX = 200

const formatScore = (n: number | null): string => (n === null ? '' : String(n))

const text = ref(formatScore(props.score))

watch(
  () => [props.score, props.isAbsent] as const,
  () => {
    text.value = formatScore(props.score)
  },
)

type Parsed = { ok: true; value: Omit<CellValue, 'note'> } | { ok: false; message: string }

function parse(raw: string): Parsed {
  const t = raw.trim()
  if (t === '') return { ok: true, value: { score: null, is_absent: false } }
  if (ABSENT_INPUTS.has(t)) return { ok: true, value: { score: null, is_absent: true } }
  if (/^\d+\.\d{2,}$/.test(t)) return { ok: false, message: '最多一位小數' }
  if (!/^\d+(\.\d)?$/.test(t) || Number(t) > props.fullScore) {
    return { ok: false, message: `需介於 0~${props.fullScore}` }
  }
  return { ok: true, value: { score: Number(t), is_absent: false } }
}

const localError = computed(() => {
  const parsed = parse(text.value)
  return parsed.ok ? '' : parsed.message
})

// 本地驗證錯誤優先於後端錯誤
const tip = computed(() => localError.value || (props.state === 'error' ? props.errorMessage : ''))

function commit(): void {
  const parsed = parse(text.value)
  if (!parsed.ok) return
  if (parsed.value.is_absent) {
    text.value = ''
    emit('change', { ...parsed.value, note: props.note })
    return
  }
  if (parsed.value.score === props.score && !props.isAbsent) return
  emit('change', { ...parsed.value, note: props.note })
}

function onAbsentChange(value: string | number | boolean): void {
  text.value = ''
  emit('change', { score: null, is_absent: value === true, note: props.note })
}

const readonlyText = computed(() => {
  if (props.isAbsent) return '缺考'
  return props.score === null ? '—' : formatScore(props.score)
})

// ---- 備註 ----
interface InputExpose {
  input?: HTMLInputElement
  textarea?: HTMLTextAreaElement
}

const noteId = useId()
const hasNote = computed(() => props.note !== null && props.note !== '')
const noteLabel = computed(() => (hasNote.value ? `備註：${props.note}` : '新增備註'))

const root = ref<HTMLElement | null>(null)
const scoreInput = ref<InputExpose | null>(null)
const noteInput = ref<InputExpose | null>(null)
const panel = ref<HTMLElement | null>(null)
const editing = ref(false)
const draft = ref('')
// 再點同一格的圖示視同點外面：pointerdown 已確定並關閉，接著的 click 不再開啟
let swallowClick = false

const noteLength = (s: string): number => Array.from(s.trim()).length
const noteCount = computed(() => noteLength(draft.value))
const noteOver = computed(() => noteCount.value > NOTE_MAX)

function focusNoteInput(): void {
  const ta = noteInput.value?.textarea
  if (!ta) return
  ta.focus({ preventScroll: true })
  const end = ta.value.length
  ta.setSelectionRange(end, end)
}

/** 關閉後焦點回到同一格：分數輸入框（全選）；缺考格回到「缺」勾選 */
function focusCell(): void {
  if (props.isAbsent) {
    root.value?.querySelector<HTMLInputElement>('.score-cell__absent input[type=checkbox]')?.focus({ preventScroll: true })
    return
  }
  const input = scoreInput.value?.input
  if (!input) return
  input.focus({ preventScroll: true })
  input.select()
}

function popperEl(): HTMLElement | null {
  return panel.value?.closest<HTMLElement>('.el-popper') ?? null
}

function closeEditor(returnFocus: boolean): void {
  editing.value = false
  document.removeEventListener('pointerdown', onOutsidePointerdown, true)
  document.removeEventListener('focusin', onFocusGuard, true)
  // 等 popover 的 focus trap 在這次 flush 裡還完焦點，再聚焦本格
  if (returnFocus) void nextTick(focusCell)
}

/** 確定：trim，空字串視為 null；與 props 相同只關閉、不 emit */
function confirmNote(returnFocus: boolean): void {
  if (noteOver.value) return
  const trimmed = draft.value.trim()
  const next = trimmed === '' ? null : trimmed
  closeEditor(returnFocus)
  if (next === (props.note ?? null)) return
  emit('change', { score: props.score, is_absent: props.isAbsent, note: next })
}

function cancelNote(): void {
  closeEditor(true)
}

function clearNote(): void {
  draft.value = ''
  void nextTick(focusNoteInput)
}

/** 點編輯框外面視同確定；超過 200 字時不關閉、焦點拉回文字框 */
function onOutsidePointerdown(e: Event): void {
  if (!editing.value) return
  const target = e.target as Node | null
  if (target && popperEl()?.contains(target)) return
  const trigger = root.value?.querySelector('.score-cell__note')
  if (target && trigger?.contains(target)) swallowClick = true
  if (noteOver.value) {
    setTimeout(focusNoteInput, 0)
    return
  }
  confirmNote(false)
}

/**
 * 超過 200 字時焦點一律留在編輯框：Element Plus 的 focus trap 遇到滑鼠造成的 focusout 會釋放並把焦點讓出去，
 * 所以不能只在 pointerdown 時聚焦一次；焦點跑到編輯框外就拉回文字框。
 */
function onFocusGuard(e: FocusEvent): void {
  if (!editing.value || !noteOver.value) return
  const target = e.target as Node | null
  if (target && popperEl()?.contains(target)) return
  setTimeout(focusNoteInput, 0)
}

function openEditor(): void {
  if (editing.value) return
  draft.value = props.note ?? ''
  editing.value = true
  document.addEventListener('pointerdown', onOutsidePointerdown, true)
  document.addEventListener('focusin', onFocusGuard, true)
  void nextTick(focusNoteInput)
}

/** popover 進場動畫結束後若焦點還不在文字框（例如開啟當下尚未可聚焦），再聚焦一次 */
function onEditorShown(): void {
  if (editing.value && document.activeElement !== noteInput.value?.textarea) focusNoteInput()
}

function onNoteClick(): void {
  if (swallowClick) {
    swallowClick = false
    return
  }
  openEditor()
}

/** Shift+F2（同 Excel 編輯附註）：焦點在分數輸入框或缺考格的「缺」勾選上時開啟；ScoreGrid 不使用這個鍵 */
function onRootKeydown(e: KeyboardEvent): void {
  if (e.key === 'F2' && e.shiftKey && !editing.value) {
    e.preventDefault()
    openEditor()
  }
}

/** 編輯框內的 Enter / Esc 不冒泡到 ScoreGrid 的鍵盤導覽 */
function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelNote()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement | null)?.tagName === 'TEXTAREA') {
    // 中文輸入法組字中的 Enter 不算確定
    if (e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    e.stopPropagation()
    confirmNote(true)
  }
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutsidePointerdown, true)
  document.removeEventListener('focusin', onFocusGuard, true)
})
</script>

<template>
  <span
    v-if="readonly"
    class="score-cell__view"
  >
    <span
      class="score-cell__text"
      :class="{ 'is-absent': isAbsent, 'is-empty': !isAbsent && score === null }"
    >{{ readonlyText }}</span>
    <el-tooltip
      v-if="hasNote"
      :trigger="['hover', 'focus']"
      placement="top"
      popper-class="score-note-tip"
    >
      <template #content>
        <div class="score-note-tip__text">
          {{ note }}
        </div>
      </template>
      <button
        type="button"
        class="score-cell__note has-note"
        data-test="note-view"
        :aria-label="noteLabel"
      >
        <el-icon><ChatLineSquare data-icon="ChatLineSquare" /></el-icon>
      </button>
    </el-tooltip>
  </span>
  <div
    v-else
    ref="root"
    class="score-cell"
    :class="{ 'is-error': state === 'error', 'is-invalid': !!localError }"
    :title="tip || undefined"
    @keydown="onRootKeydown"
  >
    <el-tooltip
      :content="tip"
      :disabled="!tip"
      placement="top"
    >
      <!-- 多包一層 span：el-tooltip 會把自己的 aria-* 蓋到直接子節點上，aria-describedby 要留在輸入框 -->
      <span class="score-cell__wrap">
        <el-input
          ref="scoreInput"
          v-model="text"
          class="score-cell__input"
          inputmode="decimal"
          :disabled="isAbsent"
          :placeholder="isAbsent ? '缺考' : ''"
          :aria-describedby="hasNote ? noteId : undefined"
          @blur="commit"
          @keyup.enter="commit"
        />
      </span>
    </el-tooltip>
    <el-checkbox
      class="score-cell__absent"
      :model-value="isAbsent"
      size="small"
      @change="onAbsentChange"
    >
      缺
    </el-checkbox>
    <el-popover
      :visible="editing"
      placement="bottom"
      :width="300"
      popper-class="score-note-pop"
      @after-enter="onEditorShown"
    >
      <template #reference>
        <span class="score-cell__note-anchor">
          <el-tooltip
            :disabled="editing"
            placement="top"
            :show-after="250"
            popper-class="score-note-tip"
          >
            <template #content>
              <div class="score-note-tip__text">
                {{ hasNote ? note : '新增備註（Shift+F2）' }}
              </div>
            </template>
            <!-- 同上：tooltip 會移除可聚焦子節點上的 aria-expanded / aria-haspopup，圖示鈕外再包一層 -->
            <span class="score-cell__wrap">
              <button
                type="button"
                tabindex="-1"
                class="score-cell__note"
                :class="{ 'has-note': hasNote, 'is-open': editing }"
                data-test="note-trigger"
                :aria-label="noteLabel"
                aria-haspopup="dialog"
                :aria-expanded="editing ? 'true' : 'false'"
                @click="onNoteClick"
              >
                <el-icon>
                  <ChatLineSquare
                    v-if="hasNote"
                    data-icon="ChatLineSquare"
                  />
                  <ChatSquare
                    v-else
                    data-icon="ChatSquare"
                  />
                </el-icon>
              </button>
            </span>
          </el-tooltip>
        </span>
      </template>
      <div
        v-if="editing"
        ref="panel"
        class="note-editor"
        :class="{ 'is-over': noteOver }"
        role="group"
        aria-label="編輯備註"
        @keydown="onPanelKeydown"
      >
        <div class="note-editor__head">
          <span class="note-editor__title">備註</span>
          <span class="note-editor__sub">家長端成績明細會顯示</span>
        </div>
        <el-input
          ref="noteInput"
          v-model="draft"
          type="textarea"
          :autosize="{ minRows: 3, maxRows: 6 }"
          placeholder="例如：補考、病假、提早離開"
          aria-label="備註內容"
          :aria-invalid="noteOver ? 'true' : 'false'"
          data-test="note-input"
        />
        <div class="note-editor__meta">
          <span
            v-if="noteOver"
            class="note-editor__error"
            role="alert"
          >備註最多 200 字</span>
          <span
            v-else
            class="note-editor__keys"
          >Enter 確定　Shift+Enter 換行</span>
          <span
            class="note-editor__count"
            :class="{ 'is-over': noteOver }"
          >{{ noteCount }} / {{ NOTE_MAX }}</span>
        </div>
        <div class="note-editor__foot">
          <el-button
            v-if="draft.length"
            text
            @click="clearNote"
          >
            清空
          </el-button>
          <span class="note-editor__spacer" />
          <el-button @click="cancelNote">
            取消
          </el-button>
          <el-button
            type="primary"
            :disabled="noteOver"
            @click="confirmNote(true)"
          >
            確定
          </el-button>
        </div>
      </div>
    </el-popover>
    <span
      v-if="hasNote"
      :id="noteId"
      class="score-cell__sr-only"
    >備註：{{ note }}</span>
    <span
      v-if="state === 'dirty'"
      class="score-cell__dirty"
      aria-label="尚未儲存"
      data-test="mark-dirty"
    />
    <span
      v-else-if="state === 'saving'"
      class="score-cell__mark"
      data-test="mark-saving"
    >
      <el-icon
        class="score-cell__spin"
        aria-label="儲存中"
      ><Loading /></el-icon>
    </span>
    <transition name="score-cell-fade">
      <span
        v-if="state === 'saved'"
        class="score-cell__mark"
        data-test="mark-saved"
      >
        <el-icon
          class="score-cell__ok"
          aria-label="已儲存"
        ><Check /></el-icon>
      </span>
    </transition>
    <span
      v-if="state === 'error' && !localError"
      class="score-cell__mark"
      data-test="mark-error"
    >
      <el-icon class="score-cell__err"><WarningFilled /></el-icon>
    </span>
  </div>
</template>

<style scoped>
.score-cell {
  position: relative;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.score-cell__wrap {
  display: inline-flex;
}

.score-cell__input {
  width: 64px;
}

.score-cell__input :deep(.el-input__inner) {
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.score-cell.is-error :deep(.el-input__wrapper),
.score-cell.is-invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.score-cell__absent {
  height: 24px;
}

.score-cell__absent :deep(.el-checkbox__label) {
  padding-left: 4px;
  font-size: 13px;
}

/* 狀態標記貼在輸入框右上角，不推動版面 */
.score-cell__mark {
  position: absolute;
  top: -5px;
  left: 54px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  pointer-events: none;
}

.score-cell__dirty {
  position: absolute;
  top: 1px;
  left: 53px;
  width: 0;
  height: 0;
  pointer-events: none;
  border-top: 10px solid var(--el-color-warning);
  border-left: 10px solid transparent;
  border-top-right-radius: 3px;
}

.score-cell__spin {
  font-size: 13px;
  color: var(--el-color-primary);
  background: var(--el-bg-color);
  border-radius: 50%;
  animation: score-cell-spin 1s linear infinite;
}

.score-cell__ok {
  padding: 1px;
  font-size: 13px;
  color: var(--el-color-white);
  background: var(--el-color-success);
  border-radius: 50%;
}

.score-cell__err {
  font-size: 14px;
  color: var(--el-color-danger);
  background: var(--el-bg-color);
  border-radius: 50%;
}

.score-cell-fade-leave-active {
  transition: opacity 0.4s ease;
}

.score-cell-fade-leave-to {
  opacity: 0;
}

@keyframes score-cell-spin {
  to {
    transform: rotate(360deg);
  }
}

.score-cell__text {
  display: inline-block;
  min-width: 40px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.score-cell__text.is-absent {
  color: var(--el-color-warning-dark-2);
}

.score-cell__text.is-empty {
  color: var(--el-text-color-placeholder);
}

/* 備註圖示鈕接在「缺」右邊（實際間距 4px）；整格約 120px，放得進 140px 科目欄，不加列高 */
.score-cell__note-anchor {
  display: inline-flex;
  margin-left: -2px;
}

.score-cell__note {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 32px;
  padding: 0;
  font-size: 15px;
  color: var(--el-text-color-placeholder);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 4px;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease;
}

/* 可點範圍：透明延伸到約 28×40（往右延伸進儲存格內距；左邊只延伸 2px，不蓋到「缺」） */
.score-cell__note::before {
  position: absolute;
  inset: -4px -8px -4px -2px;
  content: '';
}

.score-cell__note:hover,
.score-cell__note.is-open {
  color: var(--el-color-primary);
  background: var(--el-fill-color-light);
}

.score-cell__note.has-note {
  color: var(--el-color-primary);
  opacity: 1;
}

/* 沒有備註：滑鼠移到格子上或格子聚焦時才出現；平板（沒有滑過）常駐 */
.score-cell:hover .score-cell__note,
.score-cell:focus-within .score-cell__note,
.score-cell__note.is-open {
  opacity: 1;
}

.score-cell__note:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
  opacity: 1;
}

@media (hover: none) {
  .score-cell__note {
    opacity: 1;
  }
}

/* readonly：數字照舊置中，備註圖示掛在文字右側、不推動數字 */
.score-cell__view {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.score-cell__view .score-cell__note {
  position: absolute;
  top: 50%;
  left: 100%;
  height: 24px;
  margin-left: 2px;
  transform: translateY(-50%);
}

.score-cell__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  white-space: nowrap;
  clip: rect(0 0 0 0);
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .score-cell__spin {
    animation: none;
  }

  .score-cell-fade-leave-active {
    transition: none;
  }

  .score-cell__note {
    transition: none;
  }
}
</style>

<style>
/*
 * 備註的 tooltip 與編輯框 teleport 到 body，scoped style 碰不到；以 score-note-* / note-editor 命名空間寫非 scoped 規則。
 */
.score-note-tip {
  max-width: 260px;
}

.score-note-tip__text {
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.score-note-pop.el-popover.el-popper {
  padding: 12px;
}

.note-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
}

.note-editor__head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.note-editor__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.note-editor__sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.note-editor.is-over .el-textarea__inner {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.note-editor__meta {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 18px;
  font-size: 12px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
}

.note-editor__error {
  color: var(--el-color-danger);
}

.note-editor__count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}

.note-editor__count.is-over {
  font-weight: 600;
  color: var(--el-color-danger);
}

.note-editor__foot {
  display: flex;
  gap: 8px;
  align-items: center;
}

.note-editor__foot .el-button + .el-button {
  margin-left: 0;
}

.note-editor__spacer {
  flex: 1;
}

/* 平板：沒有實體鍵盤時不顯示鍵盤提示；按鈕撐到 44px */
@media (hover: none) {
  .note-editor__keys {
    visibility: hidden;
  }
}

@media (pointer: coarse) {
  .note-editor__foot .el-button {
    min-height: 44px;
  }
}
</style>
