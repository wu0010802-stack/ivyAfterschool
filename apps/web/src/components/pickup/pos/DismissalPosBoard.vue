<script setup lang="ts">
// FRONTEND-190：接送 POS 三欄容器（左班級欄、中學生卡、右佇列）。設計稿：docs/mockups/page-pickup-pos.html（三欄 POS 段）。
// 移植 ivy FE:src/components/dismissal/pos/DismissalPosBoard.vue 的三欄組裝與「班級選取只影響中欄」；去掉娃娃車 / 請假補登、
// reservation chime。
// - 班級選取存 route.query.class（全部班級時不帶）；名單裡沒有該班時視為全部班級。右欄佇列永遠是全部班級。
// - 中欄頂部固定一列：「{班級}（{n} 人）」+ 搜尋框（只過濾中欄）。
// - 送出中防連點：佇列卡 acknowledge / cancel 呼叫 API 前把請求 id 加入 busyIds、結束後移除；busy 中的請求不再處理新的動作。
//   reply / complete 由各自 dialog 的送出中狀態處理。
// - 取消：倒數卡直接移除；請求卡先 prompt 取消原因。useDismissalPosQueue.cancel 只回 boolean，成功後 board.reload() 讓卡片立即移到已結束。
// - 寬度 < 900：右欄改底部抽屜 + 中欄右下浮動按鈕「佇列（N）」（N = 倒數 + 進行中，有家長已到時紅色數字徽章）。
// - 首次載入（名單 / 佇列仍為 null）顯示骨架；之後的重新整理不閃骨架。
// - defineExpose focusRequest：頁面（FRONTEND-189）在家長到達時定位閃爍。
import { ArrowDown, List, Search } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { StaffAuthorization } from '@/api/pickupAuthorizations'
import type { PickupRequest, RosterStudent } from '@/api/pickupRequests'
import PickupCompleteDialog from '@/components/pickup/PickupCompleteDialog.vue'
import PickupCreateDialog, { type PickupCreatePresetStudent } from '@/components/pickup/PickupCreateDialog.vue'
import PickupReplyDialog from '@/components/pickup/PickupReplyDialog.vue'
import { useDismissalPosQueue, type PosQueueItem } from '@/composables/useDismissalPosQueue'
import { buildClassRail, studentsForRail } from '@/composables/useDismissalRoster'
import type { PickupBoard } from '@/composables/usePickupBoard'
import { errorMessage } from '@/shared/utils/errorMessage'
import ClassroomRail from './ClassroomRail.vue'
import QueuePanel from './QueuePanel.vue'
import StudentGrid from './StudentGrid.vue'

/** 本元件用到的 usePickupBoard（FRONTEND-188）資料與操作 */
export type PosBoardSource = Pick<
  PickupBoard,
  'queue' | 'roster' | 'authorizations' | 'reload' | 'reply' | 'acknowledge' | 'complete' | 'create'
>

const props = defineProps<{
  board: PosBoardSource
  canOperate: boolean
  canOverride: boolean
}>()

/** 班級欄第一項（全部班級）的 key，與 useDismissalRoster.buildClassRail 一致 */
const ALL_KEY = 'all'
/** 寬度小於此值時右欄改底部抽屜 */
const NARROW_BREAKPOINT = 900
const RAIL_SKELETON_COUNT = 5
const CARD_SKELETON_COUNT = 9
const CANCEL_REASON_MAX = 200

const route = useRoute()
const router = useRouter()

// ---- 版面寬度 ----
const narrow = ref(window.innerWidth < NARROW_BREAKPOINT)
const drawerOpen = ref(false)

function onResize(): void {
  narrow.value = window.innerWidth < NARROW_BREAKPOINT
}

onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

watch(narrow, (isNarrow) => {
  if (!isNarrow) drawerOpen.value = false
})

// ---- 左欄 / 中欄 ----
const roster = computed(() => props.board.roster.value)
const railItems = computed(() => (roster.value ? buildClassRail(roster.value) : []))

const selectedKey = computed(() => {
  const raw = route.query.class
  const key = typeof raw === 'string' && raw ? raw : ALL_KEY
  if (railItems.value.length > 0 && !railItems.value.some((it) => it.key === key)) return ALL_KEY
  return key
})

function selectClass(key: string): void {
  if (key === selectedKey.value) return
  void router.replace({ query: { ...route.query, class: key === ALL_KEY ? undefined : key } })
}

const query = ref('')
const students = computed(() => (roster.value ? studentsForRail(roster.value, selectedKey.value, query.value) : []))
const gridTitle = computed(() => {
  const item = railItems.value.find((it) => it.key === selectedKey.value)
  return item ? `${item.label}（${item.total} 人）` : ''
})

/** student_id → 班級名稱（RosterStudent 沒有班級欄位） */
const classNameOf = computed(() => {
  const map = new Map<string, string>()
  for (const c of roster.value?.classes ?? []) {
    for (const s of c.students) map.set(s.student_id, c.class_name ?? '')
  }
  return map
})

// ---- 右欄 ----
const posQueue = useDismissalPosQueue(props.board.queue)
const queueItems = posQueue.items
const queueLoading = computed(() => props.board.queue.value === null)
const openCount = computed(() => queueItems.value.filter((i) => i.phase !== 'closed').length)
const arrivedCount = computed(
  () => queueItems.value.filter((i) => i.phase === 'active' && i.request?.status === 'arrived').length,
)

type QueuePanelInstance = InstanceType<typeof QueuePanel>
const sidePanel = ref<QueuePanelInstance | null>(null)
const drawerPanel = ref<QueuePanelInstance | null>(null)

/** 捲到該請求卡並閃爍；窄版先打開抽屜。找不到回 false */
async function focusRequest(requestId: string): Promise<boolean> {
  if (narrow.value && !drawerOpen.value) {
    drawerOpen.value = true
    await nextTick()
  }
  const panel = narrow.value ? drawerPanel.value : sidePanel.value
  return panel ? panel.focus(requestId) : false
}

function quickDispatch(student: RosterStudent): void {
  if (!props.canOperate) return
  posQueue.addToQueue({
    id: student.student_id,
    name: student.name,
    className: classNameOf.value.get(student.student_id) ?? '',
  })
}

// ---- 送出中防連點 ----
const busyIds = reactive(new Set<string>())

async function withBusy(id: string, run: () => Promise<void>): Promise<void> {
  if (busyIds.has(id)) return
  busyIds.add(id)
  try {
    await run()
  } finally {
    busyIds.delete(id)
  }
}

function acknowledge(request: PickupRequest): void {
  if (!props.canOperate) return
  void withBusy(request.id, async () => {
    try {
      await props.board.acknowledge(request.id)
    } catch (err) {
      ElMessage.error(errorMessage(err, `確認失敗：${request.student.name}`))
    }
  })
}

/** 取消原因；按「返回」或關閉回 null */
async function promptCancelReason(): Promise<string | null> {
  try {
    const { value } = await ElMessageBox.prompt('取消原因（選填，家長發起的請求會通知家長）', '取消接送請求', {
      confirmButtonText: '取消請求',
      cancelButtonText: '返回',
      inputPlaceholder: '例如：家長改明天接',
      inputValidator: (v: string) => !v || v.length <= CANCEL_REASON_MAX || `最多 ${CANCEL_REASON_MAX} 字`,
    })
    return (value ?? '').trim()
  } catch {
    return null
  }
}

async function cancelItem(item: PosQueueItem): Promise<void> {
  if (!props.canOperate) return
  if (item.phase === 'staging') {
    void posQueue.cancel(item)
    return
  }
  if (item.phase !== 'active' || busyIds.has(item.id)) return
  const reason = await promptCancelReason()
  if (reason === null) return
  await withBusy(item.id, async () => {
    const ok = await posQueue.cancel(item, reason || undefined)
    if (!ok) return
    ElMessage.success(`已取消 ${item.studentName} 的接送請求`)
    await props.board.reload()
  })
}

// ---- dialog ----
const replyRequest = ref<PickupRequest | null>(null)
const replyOpen = ref(false)
const completeRequest = ref<PickupRequest | null>(null)
const completeOpen = ref(false)
const createStudent = ref<PickupCreatePresetStudent | null>(null)
const createOpen = ref(false)

function openReply(request: PickupRequest): void {
  replyRequest.value = request
  replyOpen.value = true
}

function openComplete(request: PickupRequest): void {
  completeRequest.value = request
  completeOpen.value = true
}

function openCreate(student: RosterStudent): void {
  createStudent.value = {
    id: student.student_id,
    name: student.name,
    student_no: student.student_no,
    class_name: classNameOf.value.get(student.student_id) ?? null,
  }
  createOpen.value = true
}

function verifyAuthorization(auth: StaffAuthorization): void {
  void router.push({ path: '/pickup/authorizations', query: { verify: auth.id } })
}

defineExpose({ focusRequest })
</script>

<template>
  <div
    class="pos-board"
    :class="{ 'is-narrow': narrow }"
  >
    <!-- 左：班級欄 -->
    <aside
      class="pos-board__rail"
      aria-label="班級"
    >
      <template v-if="roster === null">
        <el-skeleton
          v-for="i in RAIL_SKELETON_COUNT"
          :key="i"
          class="pos-board__rail-skeleton"
          animated
        >
          <template #template>
            <el-skeleton-item
              variant="rect"
              class="pos-board__rail-skeleton-item"
            />
          </template>
        </el-skeleton>
      </template>
      <ClassroomRail
        v-else
        :items="railItems"
        :selected-key="selectedKey"
        @update:selected-key="selectClass"
      />
    </aside>

    <!-- 中：學生卡 -->
    <section
      class="pos-board__grid"
      aria-label="學生"
    >
      <div class="pos-board__head">
        <span class="pos-board__title">{{ gridTitle }}</span>
        <el-input
          v-model="query"
          class="pos-board__search"
          size="large"
          placeholder="搜尋姓名或學號"
          aria-label="搜尋姓名或學號"
          clearable
          :prefix-icon="Search"
        />
      </div>
      <div
        v-if="roster === null"
        class="pos-board__cards"
      >
        <div
          v-for="i in CARD_SKELETON_COUNT"
          :key="i"
          class="pos-board__card-skeleton"
        >
          <el-skeleton
            :rows="2"
            animated
          />
        </div>
      </div>
      <StudentGrid
        v-else
        :students="students"
        :roster-classes="roster.classes"
        :staging-ids="posQueue.stagingIds.value"
        :can-operate="canOperate"
        :group-by-class="selectedKey === ALL_KEY"
        :query="query"
        @quick-dispatch="quickDispatch"
        @focus-request="focusRequest"
        @create-request="openCreate"
      />
    </section>

    <!-- 右：佇列 -->
    <aside
      v-if="!narrow"
      class="pos-board__queue"
      aria-label="接送佇列"
    >
      <QueuePanel
        ref="sidePanel"
        :items="queueItems"
        :can-operate="canOperate"
        :busy-ids="busyIds"
        :loading="queueLoading"
        @reply="openReply"
        @acknowledge="acknowledge"
        @complete="openComplete"
        @cancel="cancelItem"
      />
    </aside>

    <!-- 寬度 < 900：右欄改底部抽屜 -->
    <template v-else>
      <el-badge
        class="pos-board__fab"
        :value="arrivedCount"
        :hidden="arrivedCount === 0"
      >
        <el-button
          type="primary"
          :icon="List"
          @click="drawerOpen = true"
        >
          佇列（{{ openCount }}）
        </el-button>
      </el-badge>
      <el-drawer
        v-model="drawerOpen"
        class="pos-board__drawer"
        direction="btt"
        size="70%"
        append-to-body
        :show-close="false"
      >
        <template #header>
          <span class="pos-board__drawer-title">接送佇列</span>
          <el-button
            class="pos-board__drawer-close"
            text
            :icon="ArrowDown"
            @click="drawerOpen = false"
          >
            收合
          </el-button>
        </template>
        <QueuePanel
          ref="drawerPanel"
          :items="queueItems"
          :can-operate="canOperate"
          :busy-ids="busyIds"
          :loading="queueLoading"
          @reply="openReply"
          @acknowledge="acknowledge"
          @complete="openComplete"
          @cancel="cancelItem"
        />
      </el-drawer>
    </template>

    <PickupReplyDialog
      v-if="replyRequest"
      v-model="replyOpen"
      :request="replyRequest"
      :board="board"
    />
    <PickupCompleteDialog
      v-if="completeRequest"
      v-model="completeOpen"
      :request="completeRequest"
      :authorizations="board.authorizations.value"
      :can-override="canOverride"
      :board="board"
      @verify-authorization="verifyAuthorization"
    />
    <PickupCreateDialog
      v-if="createStudent"
      v-model="createOpen"
      :preset-student="createStudent"
      :board="board"
    />
  </div>
</template>

<style scoped>
/* 三欄貼齊內容區（外層為 flex column，由頁面抵銷外框 padding），只讓三欄各自捲動 */
.pos-board {
  position: relative;
  display: grid;
  flex: 1;
  grid-template-columns: 148px minmax(0, 1fr) 320px;
  min-height: 0;
}

@media (min-width: 1025px) {
  .pos-board {
    grid-template-columns: 160px minmax(0, 1fr) 340px;
  }
}

.pos-board.is-narrow {
  grid-template-columns: 148px minmax(0, 1fr);
}

.pos-board__rail {
  box-sizing: border-box;
  min-height: 0;
  padding: 12px 10px;
  overflow: auto;
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-light);
}

.pos-board__rail-skeleton {
  margin-bottom: 6px;
}

.pos-board__rail-skeleton-item {
  height: 56px;
  border-radius: 8px;
}

.pos-board__grid {
  box-sizing: border-box;
  min-height: 0;
  padding: 0 12px 16px;
  overflow: auto;
  background: var(--el-bg-color-page);
}

/* 窄版：底部留出浮動按鈕（bottom 20 + 高 48 + 16）的空間，最後一列卡片與 ⋮ 才捲得出來 */
.pos-board.is-narrow .pos-board__grid {
  padding-bottom: 84px;
}

.pos-board__head {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 0 10px;
  background: var(--el-bg-color-page);
}

.pos-board__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pos-board__search {
  flex-shrink: 0;
  width: 200px;
}

.pos-board__search :deep(.el-input__wrapper) {
  box-sizing: border-box;
  min-height: 44px;
}

.pos-board__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.pos-board__card-skeleton {
  box-sizing: border-box;
  min-height: 120px;
  padding: 12px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.pos-board__queue {
  box-sizing: border-box;
  min-height: 0;
  padding: 12px;
  overflow: auto;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color-light);
}

/* 浮動按鈕：固定在中欄右下（相對 .pos-board，不隨中欄捲動） */
.pos-board__fab {
  position: absolute;
  right: 20px;
  bottom: 20px;
  z-index: 5;
}

.pos-board__fab .el-button {
  min-height: 48px;
  padding: 0 20px;
  font-size: 15px;
  border-radius: 24px;
  box-shadow: var(--el-box-shadow);
}

.pos-board__drawer-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.pos-board__drawer-close.el-button {
  min-height: 44px;
}
</style>

<style>
/* el-drawer 傳送到 body，scoped 樣式碰不到：以 pos-board__drawer 命名空間寫非 scoped 規則 */
.el-drawer.pos-board__drawer {
  border-radius: 12px 12px 0 0;
}

.el-drawer.pos-board__drawer > .el-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 4px 16px;
  margin-bottom: 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.el-drawer.pos-board__drawer > .el-drawer__body {
  min-height: 0;
  padding: 12px;
  overflow: auto;
}
</style>
