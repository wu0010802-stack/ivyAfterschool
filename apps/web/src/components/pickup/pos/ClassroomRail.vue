<script setup lang="ts">
// FRONTEND-191：接送 POS 左側班級欄（純展示 + 選取，不決定預設值）。設計稿：docs/mockups/page-pickup-pos.html（ClassroomRail 段）。
// 移植 ivy FE:src/components/dismissal/pos/DismissalPosClassroomRail.vue：選中狀態完全由 selectedKey prop 決定，元件內不另存。
// - 每項兩行：班名（粗體）／「{total} 人」+ 右側徽章——有家長已到 → danger「{n} 已到」，否則有進行中 → warning「{n} 接送中」，都沒有不顯示。
// - 選中項 is-active + aria-current="true"；↑↓ 鍵切換並把焦點移到新選中的項目；觸控高度 ≥ 56px。
import { nextTick, ref } from 'vue'
import type { RailItem } from '@/composables/useDismissalRoster'

const props = defineProps<{
  items: RailItem[]
  selectedKey: string
}>()

const emit = defineEmits<{
  'update:selectedKey': [key: string]
}>()

interface Badge {
  cls: 'is-danger' | 'is-warning'
  text: string
}

const buttons = ref<HTMLButtonElement[]>([])

function badgeOf(item: RailItem): Badge | null {
  if (item.arrivedCount > 0) return { cls: 'is-danger', text: `${item.arrivedCount} 已到` }
  if (item.openCount > 0) return { cls: 'is-warning', text: `${item.openCount} 接送中` }
  return null
}

function move(delta: number): void {
  const index = props.items.findIndex((it) => it.key === props.selectedKey)
  const nextIndex = Math.min(props.items.length - 1, Math.max(0, index + delta))
  const next = props.items[nextIndex]
  if (!next || next.key === props.selectedKey) return
  emit('update:selectedKey', next.key)
  void nextTick(() => buttons.value.find((b) => b.dataset.key === next.key)?.focus())
}
</script>

<template>
  <nav
    class="rail"
    aria-label="班級列表"
    @keydown.up.prevent="move(-1)"
    @keydown.down.prevent="move(1)"
  >
    <button
      v-for="it in items"
      :key="it.key"
      ref="buttons"
      type="button"
      class="rail__item"
      :class="{ 'is-active': it.key === selectedKey }"
      :data-key="it.key"
      :aria-current="it.key === selectedKey ? 'true' : undefined"
      @click="emit('update:selectedKey', it.key)"
    >
      <span class="rail__name">{{ it.label }}</span>
      <span class="rail__meta">
        <span>{{ it.total }} 人</span>
        <span
          v-if="badgeOf(it)"
          class="rail__badge"
          :class="badgeOf(it)?.cls"
        >{{ badgeOf(it)?.text }}</span>
      </span>
    </button>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rail__item {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  width: 100%;
  min-height: 56px;
  padding: 8px 10px;
  font-family: inherit;
  color: var(--el-text-color-regular);
  text-align: left;
  cursor: pointer;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.rail__item:hover {
  border-color: var(--el-color-primary-light-5);
}

.rail__item:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.rail__item.is-active {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary);
  box-shadow: inset 0 0 0 1px var(--el-color-primary);
}

.rail__name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.3;
}

.rail__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.rail__badge {
  padding: 0 7px;
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
  border-radius: 999px;
  font-variant-numeric: tabular-nums;
}

.rail__badge.is-danger {
  color: var(--el-color-white);
  background: var(--el-color-danger);
}

.rail__badge.is-warning {
  color: var(--el-color-warning-dark-2);
  background: var(--el-color-warning-light-8);
}
</style>
