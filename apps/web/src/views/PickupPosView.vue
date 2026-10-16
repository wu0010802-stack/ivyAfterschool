<script setup lang="ts">
// FRONTEND-189：接送 POS 頁（/pickup，pickup:read，meta.tablet）。設計稿：docs/mockups/page-pickup-pos.html。
// 移植 ivy FE:src/views/DismissalQueueView.vue 的頁面骨架（連線狀態、POS board 容器、建立 dialog）；去掉 PageHeader
// （頁名只在外框頂欄）、歷史篩選分頁、手機卡片列表、娃娃車、教師端連動。
// - 工具列：今天日期、唯讀 tag、四個計數 chip（0 時中性灰、載入中 / 失敗「–」）、連線膠囊、提示音切換、代理接送核驗、
//   代建接送請求（pickup:operate）。平板 1024 寬度一列，寬度 < 900 才換行。
// - 提示音（FRONTEND-187）：board.onArrived / onNewRequest 與 transient pickup.arrived 都交給 chime（chime 以 request id 去重）；
//   本機 board.create 建立的請求由 board 不觸發 onNewRequest（FRONTEND-188）。第一次 pointerdown 時 unlock。
// - 家長到達：呼叫 DismissalPosBoard（FRONTEND-190）的 focusRequest，以 request id 去重；佇列還沒有該卡（找不到）時不記為已定位，
//   之後 pickup 推播到了會再定位一次。
// - 名單或佇列第一次載入失敗：EmptyState error + 重試；載入成功後的重新整理失敗維持畫面。
import { Bell, MuteNotification, Plus, Stamp } from '@element-plus/icons-vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { PickupQueueCounts, PickupRequest } from '@/api/pickupRequests'
import EmptyState from '@/components/common/EmptyState.vue'
import PickupCreateDialog from '@/components/pickup/PickupCreateDialog.vue'
import DismissalPosBoard from '@/components/pickup/pos/DismissalPosBoard.vue'
import { useDismissalChime, type ChimeRequest } from '@/composables/useDismissalChime'
import { useNowClock } from '@/composables/useDismissalUrgency'
import { usePickupBoard } from '@/composables/usePickupBoard'
import { formatDateWithWeekday, todayTaipei } from '@/shared/utils/datetime'
import { useNotificationsStore, type TransientNotification } from '@/stores/notifications'
import { usePermission } from '@/utils/permission'

type DataState = 'loading' | 'error' | 'data'
type ChipType = 'danger' | 'warning' | 'info'

const COUNT_CHIPS: { key: keyof PickupQueueCounts; label: string; type: ChipType }[] = [
  { key: 'needs_reply', label: '待回覆', type: 'danger' },
  { key: 'pending', label: '等待確認', type: 'warning' },
  { key: 'acknowledged', label: '已確認', type: 'info' },
  { key: 'arrived', label: '家長已到', type: 'danger' },
]
const COUNT_PLACEHOLDER = '–'
/** 日期標籤跨午夜更新的週期 */
const DATE_TICK_MS = 60_000
/** 班級欄 key：全部班級 / 未分班不帶 classFilter（與 useDismissalRoster 一致） */
const NO_FILTER_KEYS = new Set(['all', 'unassigned'])

const route = useRoute()
const router = useRouter()
const { can } = usePermission()
const canOperate = computed(() => can('pickup:operate'))
const canOverride = computed(() => can('pickup:override'))

const board = usePickupBoard({ withRoster: true, withAuthorizations: true })
const chime = useDismissalChime()
const notifications = useNotificationsStore()
const posBoard = ref<InstanceType<typeof DismissalPosBoard> | null>(null)

// ---- 工具列 ----
const { now } = useNowClock(DATE_TICK_MS)
const todayLabel = computed(() => {
  void now.value
  return formatDateWithWeekday(todayTaipei())
})

const dataState = computed<DataState>(() => {
  const missing = board.queue.value === null || board.roster.value === null
  if (!missing) return 'data'
  return board.error.value !== null && !board.loading.value ? 'error' : 'loading'
})
const ready = computed(() => dataState.value === 'data')

const countChips = computed(() =>
  COUNT_CHIPS.map((chip) => {
    const value = ready.value ? board.counts.value[chip.key] : null
    return {
      ...chip,
      text: value === null ? COUNT_PLACEHOLDER : String(value),
      type: value ? chip.type : 'info',
      effect: value ? 'light' : 'plain',
    } as const
  }),
)

const wsOpen = computed(() => board.wsStatus.value === 'open')

function goAuthorizations(): void {
  void router.push('/pickup/authorizations')
}

// ---- 代建（工具列：未預選學生；中欄選了班級時只查該班）----
const createOpen = ref(false)
const classFilter = computed(() => {
  const key = route.query.class
  if (typeof key !== 'string' || NO_FILTER_KEYS.has(key)) return undefined
  const cls = board.roster.value?.classes.find((c) => c.class_id === key)
  return cls?.class_id ? { id: cls.class_id, name: cls.class_name ?? '' } : undefined
})

function onCreated(req: PickupRequest): void {
  void focusRequest(req.id)
}

// ---- 提示音 ----
const unlocked = ref(false)

function onPointerDown(): void {
  if (unlocked.value) return
  unlocked.value = true
  chime.unlock()
}

// ---- 家長到達：定位並閃爍 ----
const focusedArrivals = new Set<string>()

async function focusRequest(requestId: string): Promise<boolean> {
  return (await posBoard.value?.focusRequest(requestId)) ?? false
}

async function focusArrival(requestId: string): Promise<void> {
  if (focusedArrivals.has(requestId)) return
  focusedArrivals.add(requestId)
  // 佇列還沒有這張卡（transient 比 pickup 推播早到）：不記為已定位，推播到了再試
  if (!(await focusRequest(requestId))) focusedArrivals.delete(requestId)
}

function onArrived(req: PickupRequest): void {
  chime.onArrived(req)
  void focusArrival(req.id)
}

/** transient 只帶 student_id / student_name / request_id：班級從佇列或名單查 */
function chimeRequestOf(payload: Record<string, unknown>): ChimeRequest | null {
  const id = payload.request_id
  if (typeof id !== 'string' || !id) return null
  const queue = board.queue.value
  const known = [...(queue?.open ?? []), ...(queue?.closed ?? [])].find((r) => r.id === id)
  if (known) return known
  const studentId = payload.student_id
  const cls = board.roster.value?.classes.find((c) => c.students.some((s) => s.student_id === studentId))
  const name = typeof payload.student_name === 'string' ? payload.student_name : ''
  return { id, student: { name, class_name: cls?.class_name ?? null } }
}

function onTransient(n: TransientNotification): void {
  if (n.event !== 'pickup.arrived') return
  const req = chimeRequestOf(n.payload)
  if (!req) return
  chime.onArrived(req)
  void focusArrival(req.id)
}

const offs = [
  board.onArrived(onArrived),
  board.onNewRequest((req) => chime.onNewRequest(req)),
  notifications.onTransient(onTransient),
]
onBeforeUnmount(() => {
  for (const off of offs) off()
})
</script>

<template>
  <div
    class="pos"
    @pointerdown="onPointerDown"
  >
    <div class="pos-top">
      <div class="pos-toolbar">
        <span class="pos-date">{{ todayLabel }}</span>
        <el-tag
          v-if="!canOperate"
          type="info"
          effect="plain"
          disable-transitions
        >
          僅檢視
        </el-tag>
        <div
          class="pos-counts"
          role="status"
          aria-label="接送計數"
        >
          <el-tag
            v-for="c in countChips"
            :key="c.key"
            class="pos-count"
            :type="c.type"
            :effect="c.effect"
            disable-transitions
          >
            {{ c.label }} {{ c.text }}
          </el-tag>
        </div>
        <span class="pos-spacer" />
        <el-tooltip
          :content="wsOpen ? '即時連線正常' : '即時連線中斷，畫面每 15 秒自動更新'"
          placement="bottom"
        >
          <span
            class="pos-conn"
            :class="wsOpen ? 'is-open' : 'is-reconnecting'"
            role="status"
          >
            <span class="pos-conn__dot" />{{ wsOpen ? '即時' : '重新連線中' }}
          </span>
        </el-tooltip>
        <el-button
          class="touch"
          :type="chime.muted.value ? 'warning' : undefined"
          :plain="chime.muted.value"
          :icon="chime.muted.value ? MuteNotification : Bell"
          @click="chime.toggleMute()"
        >
          {{ chime.muted.value ? '提示音：關' : '提示音：開' }}
        </el-button>
        <el-button
          class="touch"
          :icon="Stamp"
          @click="goAuthorizations"
        >
          代理接送核驗
        </el-button>
        <el-button
          v-if="canOperate"
          class="touch"
          type="primary"
          :icon="Plus"
          :disabled="!ready"
          @click="createOpen = true"
        >
          代建接送請求
        </el-button>
      </div>
      <el-alert
        v-if="!unlocked"
        class="pos-hint"
        type="info"
        :closable="false"
        show-icon
        title="點一下畫面以啟用提示音"
      />
    </div>

    <div
      v-if="dataState === 'error'"
      class="pos-error"
    >
      <EmptyState
        variant="error"
        title="無法載入接送資料"
        :description="board.error.value ?? ''"
      >
        <template #action>
          <el-button
            class="touch"
            @click="board.reload()"
          >
            重試
          </el-button>
        </template>
      </EmptyState>
    </div>
    <DismissalPosBoard
      v-else
      ref="posBoard"
      :board="board"
      :can-operate="canOperate"
      :can-override="canOverride"
    />

    <PickupCreateDialog
      v-if="canOperate"
      v-model="createOpen"
      :class-filter="classFilter"
      :board="board"
      @created="onCreated"
    />
  </div>
</template>

<style scoped>
/* 三欄貼齊內容區四邊：抵銷 AdminLayout 內容區的 padding（桌機 20、≤1024 為 16、≤767 為 12），只讓三欄各自捲動 */
.pos {
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin: -20px;
  height: calc(100% + 40px);
}

@media (max-width: 1024px) {
  .pos {
    margin: -16px;
    height: calc(100% + 32px);
  }
}

@media (max-width: 767px) {
  .pos {
    margin: -12px;
    height: calc(100% + 24px);
  }
}

.pos-top {
  flex-shrink: 0;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-light);
}

/* 平板 1024 寬度下所有狀態（載入中 / 失敗、斷線、兩位數計數）都維持一列；只有寬度 < 900 才換行 */
.pos-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 10px 12px;
}

@media (min-width: 900px) {
  .pos-toolbar {
    flex-wrap: nowrap;
  }
}

.pos-toolbar > * {
  flex-shrink: 0;
}

.pos-toolbar .el-button + .el-button {
  margin-left: 0;
}

.touch.el-button {
  min-height: 44px;
  padding-right: 10px;
  padding-left: 10px;
}

.pos-date {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.pos-counts {
  display: flex;
  gap: 4px;
  align-items: center;
}

.pos-count.el-tag {
  padding: 0 7px;
  font-variant-numeric: tabular-nums;
}

.pos-toolbar > .pos-spacer {
  flex: 1;
  flex-shrink: 1;
}

/* 固定寬度：「即時」與「重新連線中」切換時工具列不跳動、不換行 */
.pos-conn {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 92px;
  height: 32px;
  padding: 0 8px;
  font-size: 12px;
  white-space: nowrap;
  border-radius: 999px;
}

.pos-conn.is-open {
  color: var(--el-color-success-dark-2);
  background: var(--el-color-success-light-9);
}

.pos-conn.is-reconnecting {
  color: var(--el-color-warning-dark-2);
  background: var(--el-color-warning-light-9);
}

.pos-conn__dot {
  width: 8px;
  height: 8px;
  background: currentcolor;
  border-radius: 50%;
}

.pos-hint {
  width: auto;
  margin: 0 12px 10px;
}

.pos-error {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  min-height: 0;
  background: var(--el-bg-color-page);
}
</style>
