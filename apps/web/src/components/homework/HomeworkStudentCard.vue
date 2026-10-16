<script setup lang="ts">
// FRONTEND-153：作業看板的逐生卡片。設計稿：docs/mockups/page-homework-board.html（HomeworkStudentCard 段）。
// - 標題：姓名、「學號・班級」；出勤 chip 只在 expected / left / leave / absent 顯示；請假 / 缺席整張卡淡化（is-dimmed）。
// - 整體狀態 tag；整體 done 但依項目推導（FRONTEND-152 deriveOverallStatus）不是 done → 手動標記，tag 旁灰字「手動標記」。
// - 預計可接送列：canWrite 且 isToday 時整列是按鈕（≥ 44px、右側箭頭），點擊 = ⋮「設定預計可接送時間」；否則純顯示。
// - 項目：HomeworkItemRow（FRONTEND-154）依 sort_order；無項目「今天沒有作業項目」。
// - canWrite：「＋ 新增作業」與 ⋮（設定預計可接送時間［只有今天］／標記整體完成［非 done］／改回依項目判斷［手動標記］）。
// - 整體完成且今天：右上「可接送」綠色徽章，框線轉成功色淡色。
import { AlarmClock, ArrowRight, CircleCheck, MoreFilled, Plus, RefreshLeft } from '@element-plus/icons-vue'
import { computed } from 'vue'
import type { BoardStudent, HomeworkItem } from '@/api/homework'
import HomeworkItemRow from '@/components/homework/HomeworkItemRow.vue'
import { deriveOverallStatus } from '@/composables/useHomeworkBoard'
import {
  ATTENDANCE_STATUS_META,
  HOMEWORK_OVERALL_STATUS_META,
  statusMeta,
} from '@/shared/constants/statusLabels'
import type { HomeworkItemStatus } from '@/shared/types/api'

const props = defineProps<{
  student: BoardStudent
  canWrite: boolean
  isToday: boolean
  /** 送出中的作業項目 id（項目列顯示小轉圈） */
  pendingItemIds: ReadonlySet<string>
}>()

const emit = defineEmits<{
  'set-status': [item: HomeworkItem, status: HomeworkItemStatus]
  'add-item': [student: BoardStudent]
  'edit-item': [item: HomeworkItem]
  'remove-item': [item: HomeworkItem]
  'edit-eta': [student: BoardStudent]
  'set-overall': [student: BoardStudent, mode: 'done' | 'auto']
}>()

type MenuCommand = 'eta' | 'done' | 'auto'

const DIMMED_ATTENDANCE = new Set(['leave', 'absent'])

const sortedItems = computed(() => [...props.student.items].sort((a, b) => a.sort_order - b.sort_order))

const attendance = computed(() => {
  const status = props.student.attendance_status
  return status && status !== 'present' ? statusMeta(ATTENDANCE_STATUS_META, status) : null
})

const dimmed = computed(() => DIMMED_ATTENDANCE.has(props.student.attendance_status ?? ''))
const overallStatus = computed(() => props.student.progress.overall_status)
const overall = computed(() => statusMeta(HOMEWORK_OVERALL_STATUS_META, overallStatus.value))
const isDone = computed(() => overallStatus.value === 'done')
const isManualDone = computed(() => isDone.value && deriveOverallStatus(props.student.items) !== 'done')
const ready = computed(() => isDone.value && props.isToday)
const etaClickable = computed(() => props.canWrite && props.isToday)
const etaLabel = computed(() => `設定 ${props.student.name} 的預計可接送時間`)

function onCommand(command: MenuCommand): void {
  if (command === 'eta') emit('edit-eta', props.student)
  else emit('set-overall', props.student, command)
}

function onEtaClick(): void {
  if (etaClickable.value) emit('edit-eta', props.student)
}
</script>

<template>
  <article
    class="hw-card"
    :class="{ 'is-dimmed': dimmed, 'is-ready': ready }"
  >
    <span
      v-if="ready"
      class="hw-card__ready"
    >可接送</span>
    <div class="hw-card__head">
      <div class="hw-card__who">
        <div class="hw-card__name">
          {{ student.name }}
        </div>
        <div class="hw-card__meta">
          {{ student.student_no }}・{{ student.class_name ?? '未分班' }}
        </div>
        <div class="hw-card__tags">
          <el-tag
            v-if="attendance"
            :type="attendance.tone"
            effect="plain"
            size="small"
            disable-transitions
          >
            {{ attendance.label }}
          </el-tag>
          <el-tag
            :type="overall.tone"
            size="small"
            disable-transitions
          >
            {{ overall.label }}
          </el-tag>
          <span
            v-if="isManualDone"
            class="hw-card__manual"
          >手動標記</span>
        </div>
      </div>
      <el-dropdown
        v-if="canWrite"
        trigger="click"
        @command="onCommand"
      >
        <el-button
          class="hw-card__menu"
          text
          :aria-label="`${student.name} 的選項`"
        >
          <el-icon :size="18">
            <MoreFilled />
          </el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-if="isToday"
              command="eta"
              :icon="AlarmClock"
            >
              設定預計可接送時間
            </el-dropdown-item>
            <el-dropdown-item
              v-if="!isDone"
              command="done"
              :icon="CircleCheck"
            >
              標記整體完成
            </el-dropdown-item>
            <el-dropdown-item
              v-if="isManualDone"
              command="auto"
              :icon="RefreshLeft"
            >
              改回依項目判斷
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <component
      :is="etaClickable ? 'button' : 'div'"
      class="hw-card__eta"
      :class="{ 'is-button': etaClickable }"
      :type="etaClickable ? 'button' : undefined"
      :aria-label="etaClickable ? etaLabel : undefined"
      @click="onEtaClick"
    >
      <el-icon><AlarmClock /></el-icon>
      <div class="hw-card__eta-body">
        <div
          v-if="student.progress.ready_eta"
          class="hw-card__eta-time"
        >
          預計 {{ student.progress.ready_eta }} 可接送
        </div>
        <div
          v-else
          class="hw-card__eta-time is-unset"
        >
          尚未設定預計時間
        </div>
        <div
          v-if="student.progress.note"
          class="hw-card__eta-note"
        >
          {{ student.progress.note }}
        </div>
      </div>
      <el-icon
        v-if="etaClickable"
        class="hw-card__eta-chev"
      >
        <ArrowRight />
      </el-icon>
    </component>

    <div class="hw-card__items">
      <div
        v-if="sortedItems.length === 0"
        class="hw-card__noitems"
      >
        今天沒有作業項目
      </div>
      <HomeworkItemRow
        v-for="it in sortedItems"
        :key="it.id"
        :item="it"
        :can-write="canWrite"
        :pending="pendingItemIds.has(it.id)"
        @set-status="(status) => emit('set-status', it, status)"
        @edit="emit('edit-item', it)"
        @remove="emit('remove-item', it)"
      />
    </div>

    <el-button
      v-if="canWrite"
      class="hw-card__add"
      text
      type="primary"
      :icon="Plus"
      @click="emit('add-item', student)"
    >
      新增作業
    </el-button>
  </article>
</template>

<style scoped>
.hw-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.hw-card.is-dimmed {
  opacity: 0.55;
}

.hw-card.is-ready {
  border-color: var(--el-color-success-light-5);
}

.hw-card__head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 8px 8px 16px;
}

.hw-card__who {
  flex: 1;
  min-width: 0;
}

.hw-card__name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 600;
}

.hw-card__meta {
  margin-top: 2px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.hw-card__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.hw-card__manual {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.hw-card__ready {
  position: absolute;
  top: -9px;
  right: 52px;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-white);
  background: var(--el-color-success);
  border-radius: 999px;
}

.hw-card__menu {
  width: 44px;
  height: 44px;
}

.hw-card__eta {
  display: flex;
  gap: 8px;
  margin: 0 16px 8px;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.hw-card__eta > .el-icon {
  margin-top: 2px;
  color: var(--el-text-color-secondary);
}

.hw-card__eta.is-button {
  align-items: center;
  width: calc(100% - 32px);
  min-height: 44px;
  font-family: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  border: 1px solid transparent;
}

.hw-card__eta.is-button:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
}

.hw-card__eta.is-button:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.hw-card__eta-body {
  flex: 1;
  min-width: 0;
}

.hw-card__eta > .hw-card__eta-chev {
  margin-top: 0;
  color: var(--el-text-color-placeholder);
}

.hw-card__eta-time {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.hw-card__eta-time.is-unset {
  font-weight: 400;
  color: var(--el-text-color-secondary);
}

.hw-card__eta-note {
  display: -webkit-box;
  margin-top: 2px;
  overflow: hidden;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.hw-card__items {
  flex: 1;
  padding: 0 8px 0 16px;
}

.hw-card__noitems {
  padding: 10px 0 12px;
  font-size: 13px;
  color: var(--el-text-color-placeholder);
}

.hw-card__add {
  height: 44px;
  margin: 4px 8px 8px;
}
</style>
