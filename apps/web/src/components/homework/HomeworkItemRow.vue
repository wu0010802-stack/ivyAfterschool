<script setup lang="ts">
// FRONTEND-154：作業項目列。設計稿：docs/mockups/page-homework-board.html（HomeworkItemRow 段）。
// - 左：科目 tag（無科目不顯示）+ 標題（單行省略，tooltip 顯示全文）；pending 時標題旁小轉圈，切換仍可再點（由 FRONTEND-152 序列化）。
// - 右：四段切換（未開始 / 進行中 / 訂正中 / 完成），每段 ≥ 48×44（平板觸控），目前段以狀態色實心填滿；點目前段不 emit。
// - ⋮（44×44）：編輯 / 刪除；長按整列 600ms 開同一個選單，長按放開後的那次 click 不算切換。唯讀時四段 disabled、沒有 ⋮。
// - 長按放開的 click 會先被 Element Plus 下拉「點外面就收起」的判定（@vueuse onClickOutside，window 捕獲階段，選單打開時
//   才註冊）收起選單。所以在打開選單「之前」先於 window 捕獲階段註冊一次性的攔截：同一目標上先註冊者先執行，
//   stopImmediatePropagation 讓那次 click 既不收起選單、也不會到達本列切換狀態。觸控長按放開可能不產生 click，
//   下一次 pointerdown 就解除攔截，之後的點擊不受影響。
import { Delete, Edit, Loading, MoreFilled } from '@element-plus/icons-vue'
import { onBeforeUnmount, ref } from 'vue'
import type { HomeworkItem } from '@/api/homework'
import { HOMEWORK_ITEM_STATUS_META } from '@/shared/constants/statusLabels'
import type { HomeworkItemStatus } from '@/shared/types/api'

const props = defineProps<{
  item: HomeworkItem
  canWrite: boolean
  pending: boolean
}>()

const emit = defineEmits<{
  'set-status': [status: HomeworkItemStatus]
  edit: []
  remove: []
}>()

const STATUS_ORDER: HomeworkItemStatus[] = ['todo', 'doing', 'correcting', 'done']
const LONG_PRESS_MS = 600

const menu = ref<{ handleOpen: () => void } | null>(null)
let pressTimer: ReturnType<typeof setTimeout> | null = null
/** 解除「吞掉長按放開的 click」的 window 攔截；沒有攔截時為 null */
let releaseGuard: (() => void) | null = null

function clearPress(): void {
  if (pressTimer === null) return
  clearTimeout(pressTimer)
  pressTimer = null
}

function disarmReleaseGuard(): void {
  releaseGuard?.()
}

/** 必須在打開選單之前呼叫：要比 Element Plus 選單打開時註冊的 window click 監聽更早註冊 */
function armReleaseGuard(): void {
  disarmReleaseGuard()
  const swallowClick = (event: MouseEvent): void => {
    event.stopImmediatePropagation()
    event.preventDefault()
    disarmReleaseGuard()
  }
  window.addEventListener('click', swallowClick, true)
  window.addEventListener('pointerdown', disarmReleaseGuard, true)
  releaseGuard = () => {
    window.removeEventListener('click', swallowClick, true)
    window.removeEventListener('pointerdown', disarmReleaseGuard, true)
    releaseGuard = null
  }
}

function pressStart(): void {
  clearPress()
  if (!props.canWrite) return
  pressTimer = setTimeout(() => {
    pressTimer = null
    armReleaseGuard()
    menu.value?.handleOpen()
  }, LONG_PRESS_MS)
}

onBeforeUnmount(() => {
  clearPress()
  disarmReleaseGuard()
})

function pick(status: HomeworkItemStatus): void {
  if (!props.canWrite || status === props.item.status) return
  emit('set-status', status)
}

function onCommand(command: 'edit' | 'remove'): void {
  if (command === 'edit') emit('edit')
  else emit('remove')
}
</script>

<template>
  <div
    class="hw-item"
    @pointerdown="pressStart"
    @pointerup="clearPress"
    @pointerleave="clearPress"
    @pointercancel="clearPress"
    @contextmenu.prevent
  >
    <div class="hw-item__text">
      <el-tag
        v-if="item.subject_name"
        size="small"
        type="info"
        effect="plain"
        disable-transitions
      >
        {{ item.subject_name }}
      </el-tag>
      <el-tooltip
        :content="item.title"
        placement="top"
        :show-after="400"
      >
        <span class="hw-item__title">{{ item.title }}</span>
      </el-tooltip>
      <el-icon
        v-if="pending"
        class="hw-item__pending is-loading"
        aria-label="儲存中"
      >
        <Loading />
      </el-icon>
    </div>
    <div
      class="hw-seg"
      role="radiogroup"
      :aria-label="`${item.title} 狀態`"
    >
      <button
        v-for="s in STATUS_ORDER"
        :key="s"
        type="button"
        class="hw-seg__btn"
        :class="[`tone-${HOMEWORK_ITEM_STATUS_META[s].tone}`, { 'is-active': item.status === s }]"
        role="radio"
        :aria-checked="item.status === s"
        :disabled="!canWrite"
        @click.stop="pick(s)"
      >
        {{ HOMEWORK_ITEM_STATUS_META[s].label }}
      </button>
    </div>
    <el-dropdown
      v-if="canWrite"
      ref="menu"
      trigger="click"
      @command="onCommand"
    >
      <el-button
        class="hw-item__menu"
        text
        aria-label="作業選項"
      >
        <el-icon><MoreFilled /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            command="edit"
            :icon="Edit"
          >
            編輯
          </el-dropdown-item>
          <el-dropdown-item
            command="remove"
            :icon="Delete"
          >
            刪除
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>

<style scoped>
.hw-item {
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 52px;
  user-select: none;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.hw-item__text {
  display: flex;
  flex: 1;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.hw-item__title {
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hw-item__pending {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--el-color-primary);
}

/* 四段切換：每段 ≥ 48×44（平板觸控下限），目前段以狀態色實心填滿、白字 */
.hw-seg {
  display: inline-flex;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}

.hw-seg__btn {
  min-width: 48px;
  height: 44px;
  padding: 0 6px;
  font-family: inherit;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--el-bg-color);
  border: none;
  border-left: 1px solid var(--el-border-color-lighter);
}

.hw-seg__btn:first-child {
  border-left: none;
}

.hw-seg__btn:disabled {
  color: var(--el-text-color-placeholder);
  cursor: not-allowed;
  background: var(--el-fill-color-lighter);
}

.hw-seg__btn.is-active.tone-info {
  color: var(--el-color-white);
  background: var(--el-color-info);
}

.hw-seg__btn.is-active.tone-warning {
  color: var(--el-color-white);
  background: var(--el-color-warning);
}

.hw-seg__btn.is-active.tone-danger {
  color: var(--el-color-white);
  background: var(--el-color-danger);
}

.hw-seg__btn.is-active.tone-success {
  color: var(--el-color-white);
  background: var(--el-color-success);
}

/* 唯讀：目前段仍以色塊顯示、降透明度 */
.hw-seg__btn.is-active:disabled {
  opacity: 0.6;
}

.hw-item__menu {
  width: 44px;
  height: 44px;
  margin-left: 0;
}
</style>
