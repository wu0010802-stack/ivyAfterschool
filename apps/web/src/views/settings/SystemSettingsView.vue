<script setup lang="ts">
// FRONTEND-058：系統設定頁（/settings/system，settings:read）。參考 ivy FE:src/components/settings/SettingsLineTab.vue
// 的「讀取 → 表單 → 儲存」流程；儲存由各 SettingCard（FRONTEND-057）自己處理。
// 設計稿：docs/mockups/page-settings-system.html。分組由 API 回傳的 group 動態產生（registry 驅動，BACKEND-106），
// 已知分組依固定順序與中文標題，未知分組排最後並以 group 原字串為標題；分頁存在 ?tab=。
// 切換分頁 / 切換 ?tab= / 離開路由時，任一卡片有未儲存變更 → confirmDiscardChanges；放棄 → 還原那些卡片。
import type { TabPaneName } from 'element-plus'
import { computed, onMounted, ref, type ComponentPublicInstance } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { listSettings, type Setting } from '@/api/settings'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import SettingCard from '@/components/settings/SettingCard.vue'
import { confirmDiscardChanges } from '@/composables/useFormDirty'
import { errorMessage } from '@/shared/utils/errorMessage'

/** 已知分組的中文標題；物件順序即分頁順序 */
const GROUP_TITLES: Record<string, string> = {
  org: '安親班資料',
  pickup: '接送',
  homework: '作業進度',
  leave: '請假',
  notification: '通知',
  line: 'LINE 串接',
}
const GROUP_ORDER = Object.keys(GROUP_TITLES)

interface SettingGroupView {
  key: string
  label: string
  items: Setting[]
}

type CardInstance = InstanceType<typeof SettingCard>

const route = useRoute()
const router = useRouter()

const settings = ref<Setting[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

function groupRank(group: string): number {
  const i = GROUP_ORDER.indexOf(group)
  return i === -1 ? GROUP_ORDER.length : i
}

const groups = computed<SettingGroupView[]>(() => {
  // sort 是穩定排序：未知分組之間保留 API 首次出現的順序
  const keys = [...new Set(settings.value.map((s) => s.group))].sort((a, b) => groupRank(a) - groupRank(b))
  return keys.map((key) => ({
    key,
    label: GROUP_TITLES[key] ?? key,
    items: settings.value.filter((s) => s.group === key),
  }))
})

const activeTab = computed(() => {
  const tab = route.query.tab
  if (typeof tab === 'string' && groups.value.some((g) => g.key === tab)) return tab
  return groups.value[0]?.key ?? ''
})

function onTabChange(name: TabPaneName): void {
  void router.replace({ query: { ...route.query, tab: String(name) } })
}

const cards = new Map<string, CardInstance>()

function registerCard(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el) cards.set(key, el as CardInstance)
  else cards.delete(key)
}

function dirtyCards(): CardInstance[] {
  return [...cards.values()].filter((c) => c.isDirty)
}

/** 沒有未儲存變更或使用者選「放棄變更」（並還原那些卡片）時回 true */
async function confirmLeave(): Promise<boolean> {
  const dirty = dirtyCards()
  if (!dirty.length) return true
  if (!(await confirmDiscardChanges('page'))) return false
  for (const c of dirty) c.reset()
  return true
}

/** el-tabs before-leave：回傳的 Promise reject 時不切換 */
function beforeTabLeave(): boolean | Promise<boolean> {
  if (!dirtyCards().length) return true
  return confirmLeave().then((ok) => (ok ? true : Promise.reject(new Error('keep editing'))))
}

onBeforeRouteUpdate(() => confirmLeave())
onBeforeRouteLeave(() => confirmLeave())

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    settings.value = await listSettings()
  } catch (err) {
    loadError.value = errorMessage(err, '請稍後再試一次')
  } finally {
    loading.value = false
  }
}

function onSaved(saved: Setting): void {
  settings.value = settings.value.map((s) => (s.key === saved.key ? saved : s))
}

onMounted(load)
</script>

<template>
  <div class="settings-page">
    <PageHeader title="系統設定" />

    <template v-if="loading">
      <el-skeleton
        animated
        class="settings-page__tabs-skeleton"
      >
        <template #template>
          <div class="settings-page__tabs-skeleton-row">
            <el-skeleton-item
              v-for="i in 6"
              :key="i"
              variant="text"
              class="settings-page__tabs-skeleton-item"
            />
          </div>
        </template>
      </el-skeleton>
      <div class="settings-page__stack">
        <div
          v-for="i in 2"
          :key="i"
          class="settings-page__panel"
        >
          <el-skeleton
            :rows="4"
            animated
          />
        </div>
      </div>
    </template>

    <div
      v-else-if="loadError !== null"
      class="settings-page__panel"
    >
      <EmptyState
        variant="error"
        title="無法載入系統設定"
        :description="loadError"
      >
        <template #action>
          <el-button @click="load">
            重試
          </el-button>
        </template>
      </EmptyState>
    </div>

    <el-tabs
      v-else
      class="settings-page__tabs"
      :model-value="activeTab"
      :before-leave="beforeTabLeave"
      @update:model-value="onTabChange"
    >
      <el-tab-pane
        v-for="g in groups"
        :key="g.key"
        :name="g.key"
        :label="g.label"
      >
        <div class="settings-page__stack">
          <SettingCard
            v-for="s in g.items"
            :key="s.key"
            :ref="(el) => registerCard(s.key, el)"
            :setting="s"
            @saved="onSaved"
          />
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.settings-page {
  max-width: 880px;
}

.settings-page__tabs :deep(.el-tabs__header) {
  margin-bottom: 16px;
}

.settings-page__stack {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-page__panel {
  padding: 16px 20px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.settings-page__tabs-skeleton {
  margin-bottom: 16px;
}

.settings-page__tabs-skeleton-row {
  display: flex;
  gap: 24px;
  padding-bottom: 12px;
  border-bottom: 2px solid var(--el-border-color-light);
}

.settings-page__tabs-skeleton-item {
  width: 64px;
}
</style>
