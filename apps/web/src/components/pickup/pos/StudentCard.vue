<script setup lang="ts">
// FRONTEND-193：接送 POS 中欄學生卡。設計稿：docs/mockups/page-pickup-pos.html（StudentCard 段）。
// 移植 ivy FE:src/components/dismissal/pos/DismissalPosStudentCard.vue 的卡片密度（姓名大字 + 狀態徽章 + ⋮）、
// div[role=button] 包巢狀按鈕、倒數中停用選單；狀態與選單項目改為本專案（去掉娃娃車 / 請假補登）。
// - 狀態由父層以 useStudentPosStatus（FRONTEND-183）算好傳入，本元件不自己判斷。
// - 點卡片：接送中 / 家長已到 → focus-request（唯讀者也可）；在班等待 / 尚未到班且 canOperate 且非 staging → quick-dispatch；其他無動作。
//   Enter / 空白鍵只在卡片本身收到時處理（.self）：⋮ 上的按鍵冒泡上來只開選單，不可同時發起代建。
// - ⋮（canOperate 且至少一項才顯示）：代建接送請求…（在班等待 / 尚未到班、非 staging）、查看代理授權（有代理授權，導到
//   /pickup/authorizations?student_id=）、已離班顯示停用說明「今天已離班」。
import { CircleCheck, Loading, MoreFilled, Plus, Postcard } from '@element-plus/icons-vue'
import { computed, type Component } from 'vue'
import { useRouter } from 'vue-router'
import type { RosterStudent } from '@/api/pickupRequests'
import { POS_STATUS_META, type PosStudentStatusResult } from '@/composables/useStudentPosStatus'
import { HOMEWORK_OVERALL_STATUS_META, LEAVE_TYPE_META, statusMeta } from '@/shared/constants/statusLabels'

const props = defineProps<{
  student: RosterStudent
  status: PosStudentStatusResult
  /** 倒數中：蓋「建立中…」遮罩、不可點、選單停用 */
  staging: boolean
  canOperate: boolean
}>()

const emit = defineEmits<{
  'quick-dispatch': [student: RosterStudent]
  'focus-request': [requestId: string]
  'create-request': [student: RosterStudent]
}>()

interface RequestNote {
  text: string
  cls: '' | 'is-danger' | 'is-info'
}

interface MenuItem {
  key: 'create' | 'auth' | 'left'
  label: string
  icon: Component
  disabled?: boolean
}

const router = useRouter()

const posStatus = computed(() => props.status.status)
const detail = computed(() => props.status.detail)
const meta = computed(() => POS_STATUS_META[posStatus.value])

const statusLabel = computed(() => {
  const leaveType = detail.value.leaveType
  if (posStatus.value === 'on_leave' && leaveType) return `請假（${statusMeta(LEAVE_TYPE_META, leaveType).label}）`
  return meta.value.label
})

/** 請求小字：接送中 → 待回覆 / 等待確認 / 已確認；家長已到只在 needs_reply 時補「待回覆」（tag 已寫家長已到） */
const requestNote = computed<RequestNote | null>(() => {
  const d = detail.value
  if (posStatus.value === 'arrived') return d.needsReply ? { text: '待回覆', cls: 'is-danger' } : null
  if (posStatus.value !== 'requested') return null
  if (d.needsReply) return { text: '待回覆', cls: 'is-danger' }
  return d.requestStatus === 'pending' ? { text: '等待確認', cls: '' } : { text: '已確認', cls: 'is-info' }
})

const homework = computed(() => {
  const status = detail.value.homeworkStatus
  return status ? HOMEWORK_OVERALL_STATUS_META[status] : null
})

const canDispatch = computed(() => posStatus.value === 'waiting' || posStatus.value === 'not_arrived')
const hasRequest = computed(() => posStatus.value === 'requested' || posStatus.value === 'arrived')
const dispatchable = computed(() => canDispatch.value && props.canOperate && !props.staging)
const tappable = computed(() => dispatchable.value || hasRequest.value)

const menuItems = computed<MenuItem[]>(() => {
  if (!props.canOperate) return []
  const items: MenuItem[] = []
  if (canDispatch.value && !props.staging) items.push({ key: 'create', label: '代建接送請求…', icon: Plus })
  if (detail.value.authorizationCount > 0) items.push({ key: 'auth', label: '查看代理授權', icon: Postcard })
  if (posStatus.value === 'picked_up') items.push({ key: 'left', label: '今天已離班', icon: CircleCheck, disabled: true })
  return items
})

const ariaLabel = computed(
  () => `${props.student.name}，${statusLabel.value}${requestNote.value ? `，${requestNote.value.text}` : ''}`,
)

function onTap(): void {
  if (hasRequest.value) {
    const requestId = detail.value.requestId
    if (requestId) emit('focus-request', requestId)
    return
  }
  if (dispatchable.value) emit('quick-dispatch', props.student)
}

function onCommand(command: MenuItem['key']): void {
  if (command === 'create') emit('create-request', props.student)
  if (command === 'auth') {
    void router.push({ path: '/pickup/authorizations', query: { student_id: props.student.student_id } })
  }
}
</script>

<template>
  <div
    class="scard"
    :class="[`tone-${meta.tone}`, `st-${posStatus}`, { 'is-tappable': tappable }]"
    role="button"
    :tabindex="tappable ? 0 : -1"
    :aria-disabled="tappable ? undefined : 'true'"
    :aria-label="ariaLabel"
    @click="onTap"
    @keydown.enter.self.prevent="onTap"
    @keydown.space.self.prevent="onTap"
  >
    <div class="scard__top">
      <span class="scard__name">{{ student.name }}</span>
      <el-dropdown
        v-if="menuItems.length"
        trigger="click"
        :disabled="staging"
        @command="onCommand"
      >
        <el-button
          class="scard__more"
          text
          :aria-label="`${student.name} 的選項`"
          @click.stop
        >
          <el-icon :size="18">
            <MoreFilled />
          </el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item
              v-for="m in menuItems"
              :key="m.key"
              :command="m.key"
              :disabled="m.disabled"
            >
              <el-icon><component :is="m.icon" /></el-icon>{{ m.label }}
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
    <div class="scard__no">
      {{ student.student_no }}
    </div>
    <div class="scard__status">
      <el-tag
        :type="meta.tone"
        size="small"
        disable-transitions
      >
        {{ statusLabel }}
      </el-tag>
      <span
        v-if="requestNote"
        class="scard__req"
        :class="requestNote.cls"
      >{{ requestNote.text }}</span>
    </div>
    <div
      v-if="posStatus === 'requested' && detail.expectedArrival"
      class="scard__line"
    >
      預計 {{ detail.expectedArrival }} 到
    </div>
    <div
      v-if="homework"
      class="scard__line"
    >
      <el-tag
        :type="homework.tone"
        size="small"
        effect="plain"
        disable-transitions
      >
        {{ homework.label }}
      </el-tag>
      <span v-if="detail.readyEta">{{ detail.readyEta }} 可接送</span>
    </div>
    <div
      v-if="detail.authorizationCount > 0"
      class="scard__line scard__auth"
    >
      <el-icon><Postcard /></el-icon>
      <span>代理 {{ detail.authorizationCount }}</span>
    </div>
    <div
      v-if="staging"
      class="scard__mask"
      aria-hidden="true"
    >
      <el-icon class="is-loading">
        <Loading />
      </el-icon>建立中…
    </div>
  </div>
</template>

<style scoped>
.scard {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 120px;
  padding: 10px 10px 10px 14px;
  overflow: hidden;
  cursor: default;
  user-select: none;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.scard::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 4px;
  content: '';
  background: var(--el-color-info-light-5);
}

.scard.tone-success::before {
  background: var(--el-color-success);
}

.scard.tone-warning::before {
  background: var(--el-color-warning);
}

.scard.tone-danger::before {
  background: var(--el-color-danger);
}

.scard.st-arrived {
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger-light-5);
}

.scard.st-picked_up,
.scard.st-on_leave,
.scard.st-absent {
  background: var(--el-fill-color-lighter);
}

.scard.st-picked_up .scard__name,
.scard.st-on_leave .scard__name,
.scard.st-absent .scard__name {
  color: var(--el-text-color-secondary);
}

.scard.is-tappable {
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s,
    transform 0.1s;
}

.scard.is-tappable:hover {
  border-color: var(--el-color-primary-light-5);
  box-shadow: var(--el-box-shadow-lighter);
}

.scard.is-tappable:active {
  transform: scale(0.98);
}

.scard:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.scard__top {
  display: flex;
  align-items: flex-start;
  gap: 2px;
}

.scard__name {
  flex: 1;
  min-width: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
  word-break: break-all;
}

.scard__more {
  width: 44px;
  height: 44px;
  margin: -10px -10px -12px 0;
}

.scard__no {
  margin-top: -2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.scard__status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 2px;
}

.scard__req {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-warning-dark-2);
}

.scard__req.is-danger {
  color: var(--el-color-danger);
}

.scard__req.is-info {
  color: var(--el-text-color-regular);
}

.scard__line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.scard__auth {
  color: var(--el-color-primary);
}

.scard__mask {
  position: absolute;
  inset: 0;
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--el-mask-color);
}

@media (prefers-reduced-motion: reduce) {
  .scard.is-tappable {
    transition: none;
  }

  .scard.is-tappable:active {
    transform: none;
  }
}
</style>
