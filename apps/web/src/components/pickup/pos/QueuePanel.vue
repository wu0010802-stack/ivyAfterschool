<script setup lang="ts">
// FRONTEND-194：接送 POS 右欄佇列（進行中 / 今日已結束）。設計稿：docs/mockups/page-pickup-pos.html（QueuePanel 段）。
// 移植 ivy FE:src/components/dismissal/pos/DismissalPosQueuePanel.vue 的 TransitionGroup 進出場動畫與 useNowClock 提供 now
// 給子卡；新增進行中 / 已結束分區。本元件不打 API：items 由 useDismissalPosQueue（FRONTEND-185）排好序傳入，事件原樣轉發。
// 送出中防連點（例如連點「確認」）不在這裡處理，由 board 層（FRONTEND-188 / 189）負責。
import { ArrowDown, ArrowUp, Back } from '@element-plus/icons-vue'
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { PickupRequest } from '@/api/pickupRequests'
import EmptyState from '@/components/common/EmptyState.vue'
import type { PosQueueItem } from '@/composables/useDismissalPosQueue'
import { useNowClock } from '@/composables/useDismissalUrgency'
import QueueCard from './QueueCard.vue'

const props = withDefaults(
  defineProps<{
    /** staging → active → closed（順序由 useDismissalPosQueue 決定，這裡只分區、不重排） */
    items: PosQueueItem[]
    canOperate: boolean
    /** 第一次載入中：3 張骨架卡、計數顯示「—」 */
    loading?: boolean
  }>(),
  { loading: false },
)

const emit = defineEmits<{
  reply: [request: PickupRequest]
  acknowledge: [request: PickupRequest]
  complete: [request: PickupRequest]
  cancel: [item: PosQueueItem]
}>()

/** 定位後的閃爍時間，與 QueueCard 的 is-flash 動畫長度一致 */
const FLASH_MS = 1500
const SKELETON_COUNT = 3

const { now } = useNowClock()

const openItems = computed(() => props.items.filter((i) => i.phase !== 'closed'))
const closedItems = computed(() => props.items.filter((i) => i.phase === 'closed'))
const hasActive = computed(() => openItems.value.some((i) => i.phase === 'active'))
const showSwipeHint = computed(() => props.canOperate && !props.loading && hasActive.value)

const closedOpen = ref(false)

// ---- focus：捲到該請求卡並閃爍 ----
const flashId = ref<string | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null
const root = ref<HTMLElement | null>(null)

function clearFlashTimer(): void {
  if (flashTimer === null) return
  clearTimeout(flashTimer)
  flashTimer = null
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 捲到 requestId 對應的卡片並閃爍 1.5 秒；在已結束區時先展開。找不到回 false。
 * 重複呼叫會重新開始閃爍（先移除 class、強制 reflow 再加回，CSS 動畫才會重播）。
 */
async function focus(requestId: string): Promise<boolean> {
  const target = props.items.find((i) => i.request?.id === requestId || i.id === requestId)
  clearFlashTimer()
  flashId.value = null
  if (!target) return false
  if (target.phase === 'closed') closedOpen.value = true
  await nextTick()
  const el = root.value?.querySelector<HTMLElement>(`[id="qc-${target.id}"]`)
  if (!el) return false
  el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' })
  void el.offsetWidth
  flashId.value = target.id
  flashTimer = setTimeout(() => {
    flashTimer = null
    flashId.value = null
  }, FLASH_MS)
  return true
}

onBeforeUnmount(clearFlashTimer)

defineExpose({ focus })
</script>

<template>
  <div
    ref="root"
    class="queue-panel"
  >
    <div class="queue-panel__head">
      <span class="queue-panel__title">進行中（{{ loading ? '—' : openItems.length }}）</span>
      <span
        v-if="showSwipeHint"
        class="queue-panel__hint"
      >
        <el-icon><Back /></el-icon>左滑卡片可取消
      </span>
    </div>

    <template v-if="loading">
      <div
        v-for="i in SKELETON_COUNT"
        :key="i"
        class="queue-panel__skeleton"
      >
        <el-skeleton
          :rows="3"
          animated
        />
      </div>
    </template>

    <template v-else>
      <EmptyState
        v-if="openItems.length === 0"
        variant="inline"
        title="目前沒有接送請求"
        :description="canOperate ? '點中間的學生卡即可代建' : ''"
      />
      <TransitionGroup
        name="qlist"
        tag="div"
        data-test="queue-active"
      >
        <QueueCard
          v-for="item in openItems"
          :key="item.id"
          :class="{ 'is-flash': flashId === item.id }"
          :item="item"
          :now="now"
          :can-operate="canOperate"
          @reply="(r) => emit('reply', r)"
          @acknowledge="(r) => emit('acknowledge', r)"
          @complete="(r) => emit('complete', r)"
          @cancel="(i) => emit('cancel', i)"
        />
      </TransitionGroup>

      <template v-if="closedItems.length > 0">
        <el-button
          class="queue-panel__closed-toggle"
          text
          bg
          :aria-expanded="String(closedOpen)"
          @click="closedOpen = !closedOpen"
        >
          <span class="queue-panel__closed-label">
            <span>今日已結束（{{ closedItems.length }}）</span>
            <el-icon>
              <ArrowUp v-if="closedOpen" />
              <ArrowDown v-else />
            </el-icon>
          </span>
        </el-button>
        <div
          v-if="closedOpen"
          class="queue-panel__closed"
          data-test="queue-closed"
        >
          <QueueCard
            v-for="item in closedItems"
            :key="item.id"
            :class="{ 'is-flash': flashId === item.id }"
            :item="item"
            :now="now"
            :can-operate="false"
          />
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.queue-panel__head {
  display: flex;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 10px;
}

.queue-panel__title {
  font-size: 15px;
  font-weight: 600;
}

.queue-panel__hint {
  display: inline-flex;
  gap: 2px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.queue-panel__skeleton {
  box-sizing: border-box;
  padding: 14px;
  margin-bottom: 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

/* 整列按鈕，觸控目標 44px */
.queue-panel__closed-toggle.el-button {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  margin-top: 2px;
  font-size: 14px;
}

.queue-panel__closed-toggle :deep(> span) {
  width: 100%;
}

.queue-panel__closed-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.queue-panel__closed {
  margin-top: 10px;
}

/* 卡片進場 / 移除 / 重排序 */
.qlist-enter-active {
  transition:
    opacity 0.24s ease,
    transform 0.24s ease;
}

.qlist-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}

.qlist-move {
  transition: transform 0.24s ease;
}

.qlist-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.qlist-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

@media (prefers-reduced-motion: reduce) {
  .qlist-enter-active,
  .qlist-leave-active,
  .qlist-move {
    transition: opacity 0.15s linear;
  }

  .qlist-enter-from,
  .qlist-leave-to {
    transform: none;
  }
}
</style>
