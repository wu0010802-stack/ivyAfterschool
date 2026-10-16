<script setup lang="ts">
/**
 * 即時連線狀態橫幅（ParentLayout 放在頂部列正下方，PARENT-024；稿 parent-component-connection-banner.html）。
 * 移植 ivy ConnectionBanner 的 wsBannerDelayMs 延遲顯示概念；去掉 SSE / 離線佇列狀態。
 * - 離線（navigator.onLine，監聽 window online / offline）：立即顯示、沒有按鈕；離線優先於 ws 斷線。
 * - ws 斷線：parentWs.enabled 且 status 為 reconnecting / closed 持續超過 delayMs 才顯示（短暫斷線不閃爍）；
 *   回到 open 立即隱藏；網路恢復時若 ws 仍斷，從恢復那刻重新計時；enabled 為 false（未登入、4401 / 4403）不顯示。
 * - 「立即更新」呼叫 parentWs.pollNow()，不顯示 loading、不隱藏橫幅（直到 ws 恢復 open）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useParentWsStore } from '../stores/parentWs'
import M3Icon from './m3/M3Icon.vue'

const props = withDefaults(defineProps<{ delayMs?: number }>(), { delayMs: 3000 })

const parentWs = useParentWsStore()

const online = ref(typeof navigator === 'undefined' || navigator.onLine !== false)
/** ws 已斷線超過 delayMs */
const wsDownLong = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const wsDown = computed(
  () =>
    online.value &&
    parentWs.enabled &&
    (parentWs.status === 'reconnecting' || parentWs.status === 'closed'),
)

function clearTimer(): void {
  if (timer === null) return
  clearTimeout(timer)
  timer = null
}

function schedule(down: boolean): void {
  clearTimer()
  if (!down) {
    wsDownLong.value = false
    return
  }
  if (props.delayMs <= 0) {
    wsDownLong.value = true
    return
  }
  // wsDown 一變回 false 就會進到上面的 clearTimer，所以到期時仍是斷線
  timer = setTimeout(() => {
    timer = null
    wsDownLong.value = true
  }, props.delayMs)
}

// 斷線 → 開始計時；恢復（open）或離線 → 立即取消；離線期間 wsDown 為 false，網路恢復才重新計時
watch(wsDown, schedule, { immediate: true })

const variant = computed<'offline' | 'ws' | null>(() => {
  if (!online.value) return 'offline'
  return wsDownLong.value ? 'ws' : null
})

const message = computed(() =>
  variant.value === 'offline' ? '目前離線，恢復網路後會自動更新' : '即時更新中斷，正在重新連線…',
)

function onOnline(): void {
  online.value = true
}

function onOffline(): void {
  online.value = false
}

onMounted(() => {
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
})

onBeforeUnmount(() => {
  window.removeEventListener('online', onOnline)
  window.removeEventListener('offline', onOffline)
  clearTimer()
})
</script>

<template>
  <Transition name="conn-banner">
    <div
      v-if="variant"
      class="conn-banner"
      :class="`conn-banner--${variant}`"
      role="status"
    >
      <M3Icon
        :name="variant === 'offline' ? 'wifi_off' : 'sync_problem'"
        :size="20"
      />
      <span class="conn-banner__text m3-body-medium">{{ message }}</span>
      <button
        v-if="variant === 'ws'"
        type="button"
        class="conn-banner__action m3-label-large"
        @click="parentWs.pollNow()"
      >
        立即更新
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.conn-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 4px 4px 4px 16px;
  overflow: hidden;
}

.conn-banner--offline {
  background: var(--m3-warning-container);
  color: var(--m3-on-warning-container);
}

.conn-banner--ws {
  background: var(--m3-secondary-container);
  color: var(--m3-on-secondary-container);
}

.conn-banner__text {
  flex: 1;
  min-width: 0;
  padding: 10px 0;
  overflow-wrap: anywhere;
}

/* 文字按鈕：40px 視覺高，::after 透明延伸成 48px 點擊區 */
.conn-banner__action {
  position: relative;
  flex: none;
  height: 40px;
  padding: 0 12px;
  border: none;
  border-radius: var(--m3-shape-full);
  background: transparent;
  color: inherit;
  font-weight: 700;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.conn-banner__action::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 48px;
  transform: translateY(-50%);
}

/* state layer：顏色取 currentColor */
.conn-banner__action::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: currentColor;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.conn-banner__action:hover::before {
  opacity: var(--m3-state-hover);
}

.conn-banner__action:active::before {
  opacity: var(--m3-state-pressed);
}

.conn-banner__action:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 0;
}

.conn-banner__action:focus-visible::before {
  opacity: var(--m3-state-focus);
}

/* 高度展開 + 淡入 / 收合 300ms */
.conn-banner-enter-active,
.conn-banner-leave-active {
  max-height: 96px;
  transition:
    max-height var(--m3-dur-medium-2) var(--m3-easing-standard),
    opacity var(--m3-dur-medium-2) var(--m3-easing-standard);
}

.conn-banner-enter-from,
.conn-banner-leave-to {
  max-height: 0;
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .conn-banner-enter-active,
  .conn-banner-leave-active {
    transition: none;
  }
}
</style>
