<script setup lang="ts">
// FRONTEND-200：代理接送核驗頁（/pickup/authorizations，pickup:read，meta.tablet）。
// 設計稿：docs/mockups/page-pickup-authorizations.html。
// 移植 ivy FE:src/views/PickupAuthorizationsView.vue 的清單、狀態篩選、搜尋與核驗 dialog 開啟流程；
// 去掉歷史區間（改為日期選擇）、手機卡片欄位設定，寫入權限改為 pickup:operate。
// - 今天的清單由 usePickupBoard（FRONTEND-188）擁有：推播到了重抓清單（序號防護），核驗結果以回傳的授權寫回。
//   過去日期直接呼叫 listPickupAuthorizations({ date })，不收推播、只能查看。
// - 狀態計數算在該日（有「只顯示」時為該生）全部授權上，不受搜尋與狀態篩選影響；active 排前，其餘依核驗 / 建立時間新到舊。
// - 核驗 dialog 以 id 從今天的清單取「現值」傳入（推播重抓後錯誤次數、鎖定即時反映），清單暫時找不到時沿用最後一份。
// - route.query.verify：今天的清單第一次載入後，該授權有效且可核驗就自動開啟，並從網址移除（只用一次）。
// - 平板為主：工具列、狀態分段、卡片「核驗」≥ 44px。
import { Search } from '@element-plus/icons-vue'
import { computed, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { listPickupAuthorizations, type StaffAuthorization, type VerifyResult } from '@/api/pickupAuthorizations'
import EmptyState from '@/components/common/EmptyState.vue'
import AuthorizationCard from '@/components/pickup/AuthorizationCard.vue'
import AuthorizationVerifyDialog from '@/components/pickup/AuthorizationVerifyDialog.vue'
import { usePickupBoard } from '@/composables/usePickupBoard'
import { AUTHORIZATION_STATUS_META } from '@/shared/constants/statusLabels'
import type { AuthorizationEffectiveStatus, ISODate } from '@/shared/types/api'
import { addDays, formatDateWithWeekday, todayTaipei } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'
import { usePermission } from '@/utils/permission'

type StatusFilter = 'all' | AuthorizationEffectiveStatus
type DataState = 'loading' | 'error' | 'data'

/** 可回看的天數 */
const HISTORY_DAYS = 30
const STATUS_KEYS: AuthorizationEffectiveStatus[] = ['active', 'completed', 'cancelled', 'expired']
const SKELETON_COUNT = 4

const route = useRoute()
const router = useRouter()
const { can } = usePermission()
const board = usePickupBoard({ withAuthorizations: true })

const today = todayTaipei()
const minDate = addDays(today, -HISTORY_DAYS)

// ---- 日期與資料 ----
const date = ref<ISODate>(today)
const isToday = computed(() => date.value === today)
const dateLabel = computed(() => formatDateWithWeekday(date.value))

/** 今天的清單是否成功載入過（之後的重新整理失敗仍保留畫面） */
const todayLoaded = ref(false)
watch(board.loading, (loading) => {
  if (!loading && board.error.value === null) todayLoaded.value = true
})
const todayState = computed<DataState>(() => {
  if (todayLoaded.value) return 'data'
  if (!board.loading.value && board.error.value !== null) return 'error'
  return 'loading'
})

const pastItems = shallowRef<StaffAuthorization[] | null>(null)
const pastError = ref<string | null>(null)
let pastSeq = 0

async function loadPast(target: ISODate): Promise<void> {
  const mySeq = ++pastSeq
  pastItems.value = null
  pastError.value = null
  try {
    const res = await listPickupAuthorizations({ date: target })
    if (mySeq === pastSeq) pastItems.value = res
  } catch (err) {
    if (mySeq === pastSeq) pastError.value = errorMessage(err, '請稍後再試一次')
  }
}

watch(date, (value) => {
  if (value === today) pastSeq += 1
  else void loadPast(value)
})

const pastState = computed<DataState>(() => {
  if (pastError.value !== null) return 'error'
  return pastItems.value === null ? 'loading' : 'data'
})
const dataState = computed<DataState>(() => (isToday.value ? todayState.value : pastState.value))
const errorText = computed(() => (isToday.value ? board.error.value : pastError.value) ?? '')
const dayItems = computed<StaffAuthorization[]>(() =>
  isToday.value ? board.authorizations.value : (pastItems.value ?? []),
)

function isOutOfRange(d: Date): boolean {
  const pad = (n: number) => String(n).padStart(2, '0')
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return ymd < minDate || ymd > today
}

function onDateChange(value: ISODate | null): void {
  if (value) date.value = value
}

function retry(): void {
  if (isToday.value) void board.reload()
  else void loadPast(date.value)
}

// ---- 只顯示某生（route.query.student_id）----
const studentFilter = computed<string | null>(() => {
  const value = route.query.student_id
  return typeof value === 'string' && value !== '' ? value : null
})
const scopeItems = computed(() =>
  studentFilter.value ? dayItems.value.filter((a) => a.student_id === studentFilter.value) : dayItems.value,
)
const studentFilterName = computed(() => {
  const id = studentFilter.value
  const match = id ? (scopeItems.value[0] ?? board.authorizations.value.find((a) => a.student_id === id)) : undefined
  return match?.student.name ?? '指定學生'
})

function clearStudentFilter(): void {
  const query: LocationQueryRaw = { ...route.query }
  delete query.student_id
  void router.replace({ query })
}

// ---- 狀態篩選與搜尋 ----
const statusFilter = ref<StatusFilter>('all')
const keyword = ref('')

const chips = computed(() => [
  { key: 'all' as StatusFilter, label: '全部', count: scopeItems.value.length },
  ...STATUS_KEYS.map((key) => ({
    key: key as StatusFilter,
    label: AUTHORIZATION_STATUS_META[key].label,
    count: scopeItems.value.filter((a) => a.effective_status === key).length,
  })),
])

/** 去空白與「-」、不分大小寫 */
function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/[\s-]/g, '').toLowerCase()
}

function activityTime(a: StaffAuthorization): number {
  return Date.parse(a.verified_at ?? a.created_at)
}

const visibleItems = computed(() => {
  const q = normalize(keyword.value)
  const rank = (a: StaffAuthorization) => (a.effective_status === 'active' ? 0 : 1)
  return scopeItems.value
    .filter((a) => statusFilter.value === 'all' || a.effective_status === statusFilter.value)
    .filter((a) => !q || [a.proxy_name, a.proxy_phone, a.student.name, a.code_last4].some((v) => normalize(v).includes(q)))
    .sort((x, y) => rank(x) - rank(y) || activityTime(y) - activityTime(x))
})

const emptyTitle = computed(() => (isToday.value ? '今天沒有代理接送授權' : `${dateLabel.value}沒有代理接送授權`))

function clearFilters(): void {
  keyword.value = ''
  statusFilter.value = 'all'
}

// ---- 權限 ----
const canOperate = computed(() => can('pickup:operate'))
const canOverride = computed(() => can('pickup:override'))
const canVerify = computed(() => canOperate.value && isToday.value)

// ---- 核驗 ----
const verifyOpen = ref(false)
const verifyId = ref<string | null>(null)
/** 清單暫時找不到該授權時沿用（例如重抓中途） */
const verifySnapshot = shallowRef<StaffAuthorization | null>(null)
const verifyTarget = computed<StaffAuthorization | null>(
  () => board.authorizations.value.find((a) => a.id === verifyId.value) ?? verifySnapshot.value,
)

function openVerify(auth: StaffAuthorization): void {
  verifySnapshot.value = auth
  verifyId.value = auth.id
  verifyOpen.value = true
}

function onVerified(result: VerifyResult): void {
  verifySnapshot.value = result.authorization
  board.applyAuthorization(result.authorization)
}

/** 從 POS 完成交付導過來：今天的清單第一次載入後自動開啟，網址參數只用一次 */
const pendingVerifyId = typeof route.query.verify === 'string' && route.query.verify !== '' ? route.query.verify : null
if (pendingVerifyId) {
  const stop = watch(
    todayLoaded,
    (loaded) => {
      if (!loaded) return
      stop()
      const target = board.authorizations.value.find((a) => a.id === pendingVerifyId)
      if (target && target.effective_status === 'active' && canVerify.value) openVerify(target)
      const query: LocationQueryRaw = { ...route.query }
      delete query.verify
      void router.replace({ query })
    },
    { immediate: true },
  )
}
</script>

<template>
  <div class="pa">
    <div class="pa-toolbar">
      <el-date-picker
        :model-value="date"
        class="pa-date touch"
        type="date"
        size="large"
        value-format="YYYY-MM-DD"
        format="YYYY/MM/DD"
        aria-label="日期"
        :clearable="false"
        :disabled-date="isOutOfRange"
        @update:model-value="onDateChange"
      />
      <el-input
        v-model="keyword"
        class="pa-search touch"
        size="large"
        placeholder="代理人、電話、學生、末四碼"
        aria-label="搜尋代理人、電話、學生、末四碼"
        clearable
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <span class="pa-spacer" />
      <template v-if="studentFilter">
        <el-tag
          size="large"
          disable-transitions
        >
          只顯示：{{ studentFilterName }}
        </el-tag>
        <el-button
          class="touch"
          @click="clearStudentFilter"
        >
          清除
        </el-button>
      </template>
      <el-tag
        v-if="!canOperate"
        type="info"
        effect="plain"
        disable-transitions
      >
        僅檢視
      </el-tag>
    </div>

    <el-radio-group
      v-model="statusFilter"
      class="pa-chips"
      aria-label="狀態篩選"
    >
      <el-radio-button
        v-for="c in chips"
        :key="c.key"
        :value="c.key"
      >
        {{ c.label }} {{ dataState === 'loading' ? '—' : c.count }}
      </el-radio-button>
    </el-radio-group>

    <el-alert
      v-if="!isToday"
      type="info"
      :closable="false"
      show-icon
      :title="`檢視 ${dateLabel}的紀錄：僅供查詢，不能核驗`"
    />

    <EmptyState
      v-if="dataState === 'error'"
      variant="error"
      title="無法載入代理接送授權"
      :description="errorText"
    >
      <template #action>
        <el-button
          class="touch"
          @click="retry"
        >
          重試
        </el-button>
      </template>
    </EmptyState>
    <div
      v-else-if="dataState === 'loading'"
      class="pa-grid"
      aria-busy="true"
    >
      <div
        v-for="i in SKELETON_COUNT"
        :key="i"
        class="pa-skel"
      >
        <el-skeleton
          :rows="3"
          animated
        />
      </div>
    </div>
    <EmptyState
      v-else-if="!scopeItems.length"
      :title="emptyTitle"
      :description="isToday ? '家長在家長端建立代理接送授權後，會即時出現在這裡' : ''"
    />
    <EmptyState
      v-else-if="!visibleItems.length"
      variant="inline"
      title="沒有符合條件的授權"
      description="試著調整搜尋文字或狀態篩選"
    >
      <template #action>
        <el-button
          class="touch"
          @click="clearFilters"
        >
          清除篩選
        </el-button>
      </template>
    </EmptyState>
    <div
      v-else
      class="pa-grid"
    >
      <AuthorizationCard
        v-for="a in visibleItems"
        :key="a.id"
        :authorization="a"
        :can-verify="canVerify"
        @verify="openVerify"
      />
    </div>

    <AuthorizationVerifyDialog
      v-if="verifyTarget"
      v-model="verifyOpen"
      :authorization="verifyTarget"
      :can-override="canOverride"
      @verified="onVerified"
    />
  </div>
</template>

<style scoped>
.pa {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.touch.el-button {
  min-height: 44px;
  padding-right: 16px;
  padding-left: 16px;
}

.touch :deep(.el-input__wrapper),
.pa-toolbar :deep(.pa-date .el-input__wrapper) {
  min-height: 44px;
}

.pa-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.pa-toolbar .el-button + .el-button {
  margin-left: 0;
}

/* el-date-picker 的 class 由內層元素接收（沒有 scope 屬性），以 :deep 指定 */
.pa-toolbar :deep(.pa-date) {
  --el-date-editor-width: 170px;

  width: 170px;
  height: 44px;
}

.pa-toolbar .pa-search {
  width: 280px;
}

.pa-spacer {
  flex: 1;
}

.pa-chips :deep(.el-radio-button__inner) {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0 18px;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.pa-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
  gap: 12px;
}

.pa-skel {
  padding: 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}
</style>
