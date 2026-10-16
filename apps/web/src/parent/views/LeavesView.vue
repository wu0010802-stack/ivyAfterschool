<script setup lang="ts">
/**
 * 請假（/leaves）：申請請假、紀錄列表、詳情（補上傳附件）與取消。
 * 列表依 children.selectedId 載入（含已取消，依開始日新到舊），以請求序號丟棄切換小孩 / 重新整理後的過期回應。
 * 申請：sheet 內 LeaveForm（按鈕列固定在 sheet 底部），建立成功後依序上傳附件；送出到上傳結束 sheet 不可關閉。
 * 取消：列與詳情共用 ConfirmDialog，確認後以回應取代該筆；409 表示別處已變更，重抓第一頁。
 */
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { isApiError } from '@/shared/types/api'
import { formatDateWithWeekday, todayTaipei } from '@/shared/utils/datetime'
import { DEFAULT_PARENT_LIMITS, getParentLimits, type ParentLimits } from '../api/config'
import {
  cancelLeave,
  createLeave,
  listChildLeaves,
  uploadLeaveAttachment,
  type LeaveAttachment,
  type ParentLeave,
} from '../api/leaves'
import ChildContextHeader from '../components/ChildContextHeader.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import LeaveDetailSheet from '../components/leaves/LeaveDetailSheet.vue'
import LeaveForm, { type LeaveFormInput } from '../components/leaves/LeaveForm.vue'
import LeaveListItem from '../components/leaves/LeaveListItem.vue'
import M3Button from '../components/m3/M3Button.vue'
import M3Card from '../components/m3/M3Card.vue'
import M3Icon from '../components/m3/M3Icon.vue'
import ParentBottomSheet from '../components/ParentBottomSheet.vue'
import ParentEmptyState from '../components/ParentEmptyState.vue'
import PullToRefresh from '../components/PullToRefresh.vue'
import SkeletonBlock from '../components/SkeletonBlock.vue'
import { useChildrenStore } from '../stores/children'
import { useSnackbarStore } from '../stores/snackbar'

const children = useChildrenStore()
const snackbar = useSnackbarStore()

const limits = ref<ParentLimits>(DEFAULT_PARENT_LIMITS)
const today = ref(todayTaipei())

const status = ref<'loading' | 'ready' | 'error'>('loading')
const items = ref<ParentLeave[]>([])
const total = ref(0)
const page = ref(1)
const loadingMore = ref(false)

// 每次載入第一頁 / 重新整理遞增；較舊請求的回應（序號不符）一律丟棄
let requestSeq = 0

// 沒有選中的小孩時不打 API：小孩清單載入中顯示骨架，載入失敗顯示錯誤，載入完成但沒有小孩視為沒有紀錄
const view = computed<'loading' | 'data' | 'empty' | 'error'>(() => {
  if (children.selectedId === null) {
    if (children.error && !children.loaded) return 'error'
    return children.loaded ? 'empty' : 'loading'
  }
  if (status.value === 'ready') return items.value.length > 0 ? 'data' : 'empty'
  return status.value
})

const hasMore = computed(() => view.value === 'data' && items.value.length < total.value)
const childName = computed(() => children.selectedChild?.name ?? '')

function applyFirstPage(result: { items: ParentLeave[]; total: number }): void {
  items.value = result.items
  total.value = result.total
  page.value = 1
  status.value = 'ready'
}

async function loadFirst(): Promise<void> {
  const childId = children.selectedId
  const seq = ++requestSeq
  today.value = todayTaipei()
  status.value = 'loading'
  items.value = []
  total.value = 0
  page.value = 1
  loadingMore.value = false
  detailOpen.value = false
  if (childId === null) return
  try {
    const result = await listChildLeaves(childId, 1)
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
    const result = await listChildLeaves(childId, page.value + 1)
    if (seq !== requestSeq) return
    if (result.items.length === 0) {
      // 後端已沒有更多：不再顯示按鈕
      total.value = items.value.length
      return
    }
    // 新建立的請假插在最前面後，伺服器分頁會往前位移，下一頁可能含已顯示的那筆
    const seen = new Set(items.value.map((l) => l.id))
    items.value = [...items.value, ...result.items.filter((l) => !seen.has(l.id))]
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
  today.value = todayTaipei()
  loadingMore.value = false
  try {
    const result = await listChildLeaves(childId, 1)
    if (seq === requestSeq) applyFirstPage(result)
  } catch {
    if (seq === requestSeq) snackbar.show('更新失敗，請稍後再試', { tone: 'error' })
  }
}

function retry(): void {
  if (children.selectedId === null) void children.load(true)
  else void loadFirst()
}

function replaceLeave(updated: ParentLeave): void {
  items.value = items.value.map((l) => (l.id === updated.id ? updated : l))
}

// ---- 申請 ----
const formOpen = ref(false)
const formKey = ref(0)
const submitting = ref(false)
const createError = ref('')
const uploadStep = ref<{ current: number; total: number } | null>(null)
const formHead = useTemplateRef<HTMLElement>('formHead')

function openForm(): void {
  formKey.value += 1
  createError.value = ''
  uploadStep.value = null
  formOpen.value = true
}

function createErrorText(error: unknown): string {
  if (!isApiError(error)) return '建立請假失敗，請稍後再試'
  if (error.code === 'leave_overlap') {
    const details = error.details as { start_date?: string; end_date?: string } | null
    return details?.start_date && details.end_date
      ? `這段期間已有請假（${details.start_date}～${details.end_date}）`
      : '這段期間已有請假'
  }
  if (error.code === 'leave_date_out_of_window') {
    return `請假日期需在今天前 ${limits.value.leave_past_days} 天到後 ${limits.value.leave_future_days} 天內`
  }
  if (error.code === 'no_service_days_in_range') return '選擇的日期都不是上課日'
  return error.message
}

function uploadErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 413) return `檔案超過 ${limits.value.leave_max_attachment_mb} MB`
    if (error.status === 415) return '檔案格式不支援'
    if (error.code === 'attachment_limit_reached') return `每筆請假最多 ${limits.value.leave_max_attachments} 個附件`
  }
  return '附件上傳失敗，請稍後再試'
}

async function onSubmit(input: LeaveFormInput): Promise<void> {
  const childId = children.selectedId
  if (childId === null || submitting.value) return
  createError.value = ''
  submitting.value = true
  let created: ParentLeave
  try {
    created = await createLeave({
      student_id: childId,
      leave_type: input.leave_type,
      start_date: input.start_date,
      end_date: input.end_date,
      reason: input.reason,
    })
  } catch (error) {
    submitting.value = false
    createError.value = createErrorText(error)
    // 送出鈕在表單最下方，不捲回頂端就看不到錯誤橫幅
    void nextTick(() => {
      const scroller = formHead.value?.closest('.sheet__body')
      if (scroller) scroller.scrollTop = 0
    })
    return
  }

  const uploaded: LeaveAttachment[] = []
  let failed = 0
  for (const [index, file] of input.files.entries()) {
    uploadStep.value = { current: index + 1, total: input.files.length }
    try {
      uploaded.push(await uploadLeaveAttachment(created.id, file))
    } catch {
      failed += 1
    }
  }
  uploadStep.value = null
  submitting.value = false
  formOpen.value = false

  const leave: ParentLeave = { ...created, attachments: [...created.attachments, ...uploaded] }
  // 送出期間若小孩已被換掉，就不插入目前的清單
  if (children.selectedId === childId) {
    items.value = [leave, ...items.value.filter((l) => l.id !== leave.id)]
    total.value += 1
    status.value = 'ready'
  }
  if (failed === 0) {
    snackbar.show('請假已送出')
  } else {
    snackbar.show(`請假已送出，但有 ${failed} 個附件上傳失敗，可在請假詳情重新上傳`, {
      tone: 'error',
      duration: 8000,
      action: { label: '查看', onClick: () => openDetailById(leave.id) },
    })
  }
}

// ---- 詳情 ----
const detailOpen = ref(false)
const detailId = ref<string | null>(null)
const detailUploading = ref(false)
// 詳情一律由清單取得最新的一筆；關閉後保留 id，離場動畫期間內容不會消失
const detailLeave = computed(() => items.value.find((l) => l.id === detailId.value) ?? null)

function openDetail(leave: ParentLeave): void {
  detailId.value = leave.id
  detailOpen.value = true
}

function openDetailById(id: string): void {
  const leave = items.value.find((l) => l.id === id)
  if (leave) openDetail(leave)
}

async function onDetailUpload(file: File): Promise<void> {
  const leave = detailLeave.value
  if (!leave || detailUploading.value) return
  detailUploading.value = true
  try {
    const uploaded = await uploadLeaveAttachment(leave.id, file)
    const current = items.value.find((l) => l.id === leave.id)
    if (current) replaceLeave({ ...current, attachments: [...current.attachments, uploaded] })
  } catch (error) {
    snackbar.show(uploadErrorText(error), { tone: 'error' })
  } finally {
    detailUploading.value = false
  }
}

// ---- 取消（列或詳情）----
const cancelTarget = ref<ParentLeave | null>(null)
const cancelOpen = ref(false)
const cancelling = ref(false)

function periodText(leave: ParentLeave): string {
  const first = formatDateWithWeekday(leave.start_date)
  return leave.start_date === leave.end_date ? first : `${first}～${formatDateWithWeekday(leave.end_date)}`
}

const cancelCopy = computed(() => {
  const leave = cancelTarget.value
  if (!leave) return { title: '', message: '', confirm: '', target: '' }
  const target = `${childName.value} · ${leave.leave_type_label} ${periodText(leave)}`
  return leave.start_date >= today.value
    ? { title: '取消這筆請假？', message: '整筆請假將取消，出勤恢復為預計到班', confirm: '取消請假', target }
    : { title: '取消剩餘日子？', message: '今天起的請假會取消，之前的日子保留', confirm: '取消剩餘日子', target }
})

function askCancel(leave: ParentLeave): void {
  cancelTarget.value = leave
  cancelling.value = false
  cancelOpen.value = true
}

async function doCancel(): Promise<void> {
  const leave = cancelTarget.value
  if (!leave || cancelling.value) return
  cancelling.value = true
  try {
    const updated = await cancelLeave(leave.id)
    replaceLeave(updated)
    cancelOpen.value = false
    snackbar.show('已取消請假')
  } catch (error) {
    if (isApiError(error) && (error.code === 'leave_already_ended' || error.code === 'leave_not_active')) {
      // 別處已變更（已結束或已被取消）：關閉對話框並重抓第一頁
      cancelOpen.value = false
      snackbar.show('這筆請假已無法取消', { tone: 'error' })
      void refresh()
    } else {
      // 其他錯誤保留對話框，可直接再按一次確認
      snackbar.show('取消失敗，請稍後再試', { tone: 'error' })
    }
  } finally {
    cancelling.value = false
  }
}

watch(() => children.selectedId, loadFirst, { immediate: true })

onMounted(() => {
  void children.load()
  void getParentLimits().then((value) => {
    limits.value = value
  })
})
</script>

<template>
  <div class="leaves-view">
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
        <M3Button
          icon="add"
          block
          :disabled="children.selectedId === null"
          @click="openForm"
        >
          申請請假
        </M3Button>

        <template v-if="view !== 'error'">
          <div class="lv-section">
            <h2 class="lv-section__title m3-title-small">
              請假紀錄
            </h2>
            <span
              v-if="view === 'data'"
              class="lv-section__count m3-body-small"
            >共 {{ total }} 筆</span>
          </div>
          <M3Card
            variant="outlined"
            padding="none"
            class="leave-card"
          >
            <ul
              v-if="view === 'data'"
              class="leave-list"
              role="list"
              aria-label="請假紀錄"
            >
              <LeaveListItem
                v-for="leave in items"
                :key="leave.id"
                :leave="leave"
                :today="today"
                @open="openDetail"
                @cancel="askCancel"
              />
            </ul>
            <ParentEmptyState
              v-else-if="view === 'empty'"
              icon="event_busy"
              title="還沒有請假紀錄"
              description="需要請假時按「申請請假」"
            />
            <SkeletonBlock
              v-else
              variant="row"
              :count="3"
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
          title="請假紀錄載入失敗"
          @action="retry"
        />
      </div>
    </PullToRefresh>

    <!-- 申請請假：送出到附件上傳結束前不可關閉 -->
    <ParentBottomSheet
      v-model="formOpen"
      title="申請請假"
      full-height
      :dismissible="!submitting"
    >
      <div
        ref="formHead"
        class="lv-form-head"
      >
        <div class="lv-form-for m3-body-medium">
          <span
            class="lv-form-for__avatar m3-label-large"
            aria-hidden="true"
          >{{ Array.from(childName)[0] ?? '' }}</span>
          <span>為 <strong>{{ childName }}</strong> 申請請假</span>
        </div>
        <div
          v-if="createError"
          class="lv-alert m3-body-medium"
          role="alert"
        >
          <M3Icon
            name="error"
            filled
          />
          <span>{{ createError }}</span>
        </div>
        <div
          v-if="uploadStep"
          class="lv-progress m3-body-medium"
          role="status"
        >
          <span
            class="lv-spinner"
            aria-hidden="true"
          />
          <span>請假已建立，正在上傳附件（{{ uploadStep.current }}/{{ uploadStep.total }}）…</span>
        </div>
      </div>
      <div class="lv-form-wrap">
        <LeaveForm
          :key="formKey"
          :today="today"
          :limits="limits"
          :submitting="submitting"
          @submit="onSubmit"
          @cancel="formOpen = false"
        />
      </div>
    </ParentBottomSheet>

    <LeaveDetailSheet
      v-model="detailOpen"
      :leave="detailLeave"
      :student-name="childName"
      :today="today"
      :limits="limits"
      :uploading="detailUploading"
      @cancel="askCancel"
      @upload="onDetailUpload"
    />

    <!-- 取消確認：疊在詳情 sheet 之上 -->
    <ConfirmDialog
      v-if="cancelTarget"
      :open="cancelOpen"
      :title="cancelCopy.title"
      :message="cancelCopy.message"
      :confirm-label="cancelCopy.confirm"
      cancel-label="先不要"
      destructive
      :loading="cancelling"
      @confirm="doCancel"
      @cancel="cancelOpen = false"
    >
      <p class="lv-confirm-target m3-body-medium">
        {{ cancelCopy.target }}
      </p>
    </ConfirmDialog>
  </div>
</template>

<style scoped>
/* 頁面自帶左右 16px、底部 24px 內距（ParentLayout 不再加） */
.leaves-view {
  padding: 0 16px 24px;
}

.page-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 8px;
}

.lv-section {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 4px -4px;
}

.lv-section__title {
  margin: 0;
  color: var(--m3-on-surface);
}

.lv-section__count {
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.leave-card {
  overflow: hidden;
}

.leave-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 申請 sheet：表單上方的「為誰申請」、建立錯誤、附件上傳進度 */
.lv-form-head {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.lv-form-for {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-surface-container);
  color: var(--m3-on-surface);
}

.lv-form-for__avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--m3-shape-full);
  background: var(--m3-tertiary-container);
  color: var(--m3-on-tertiary-container);
}

.lv-alert {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-error-container);
  color: var(--m3-on-error-container);
}

.lv-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-secondary-container);
  color: var(--m3-on-secondary-container);
}

.lv-spinner {
  flex: none;
  width: 18px;
  height: 18px;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: lv-spin 0.8s linear infinite;
}

@keyframes lv-spin {
  to {
    transform: rotate(360deg);
  }
}

.lv-confirm-target {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--m3-shape-small);
  background: var(--m3-surface-container-highest);
  color: var(--m3-on-surface);
}

/*
 * LeaveForm 的按鈕列固定在 sheet 可視區底部（外觀同 ParentBottomSheet footer），初始畫面就看得到「送出請假」，
 * 表單內容在它上方捲動。sticky 的停靠位置會避開捲動容器（ParentBottomSheet 的內容區）的 padding，
 * 所以包住 LeaveForm 的元素與按鈕列都以 --sheet-body-pad（內容區底部內距 24px）往下補回去，按鈕列才會貼齊 sheet 底緣；
 * z-index 高於 M3TextField 的浮動標籤（2）。不改 LeaveForm 的介面。
 */
.lv-form-wrap {
  --sheet-body-pad: 24px;

  margin-bottom: calc(-1 * var(--sheet-body-pad));
}

.lv-form-wrap :deep(.lf-actions) {
  position: sticky;
  z-index: 3;
  bottom: calc(-1 * var(--sheet-body-pad));
  margin: 0 -24px;
  padding: 16px 24px calc(16px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--m3-outline-variant);
  background: var(--m3-surface-container-low);
}
</style>
