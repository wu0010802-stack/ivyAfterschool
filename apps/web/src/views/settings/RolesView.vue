<script setup lang="ts">
// FRONTEND-071：角色權限頁（/settings/roles，roles:read）。移植 ivy FE:src/views/settings/SettingsRolesView.vue 的
// 左右兩欄、`?role=` 記住選中角色（角色 code，重新整理或分享網址都停在同一個角色）與未儲存變更守衛。
// 設計稿：docs/mockups/page-settings-roles.html。左 RoleCardsGrid（showStaffCount），右 RoleDetailPanel。
// 選取角色只改 ?role=；未儲存變更的確認一律由 onBeforeRouteUpdate / onBeforeRouteLeave 處理（點卡片、上一頁、離開同一條路）。
// saved / created / deleted 後重新載入角色清單；deleted 後選第一個，created 後選新角色。
import { Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { fetchPermissionCatalog, listRoles, type PermissionCatalog, type Role } from '@/api/roles'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import RoleCardsGrid from '@/components/settings/RoleCardsGrid.vue'
import RoleCreateDialog from '@/components/settings/RoleCreateDialog.vue'
import RoleDetailPanel from '@/components/settings/RoleDetailPanel.vue'
import { confirmDiscardChanges } from '@/composables/useFormDirty'
import { PERMISSIONS } from '@/constants/permissions'
import { errorMessage } from '@/shared/utils/errorMessage'
import { usePermission } from '@/utils/permission'

/** 與 RoleCardsGrid 的排序一致：系統角色 admin → director → clerk → tutor，其餘依名稱 */
const SYSTEM_ORDER = ['admin', 'director', 'clerk', 'tutor']

function systemRank(code: string): number {
  const i = SYSTEM_ORDER.indexOf(code)
  return i === -1 ? SYSTEM_ORDER.length : i
}

function sortRoles(roles: Role[]): Role[] {
  return [...roles].sort(
    (a, b) => systemRank(a.code) - systemRank(b.code) || a.name.localeCompare(b.name, 'zh-Hant'),
  )
}

const route = useRoute()
const router = useRouter()
const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.ROLES_WRITE))

const roles = ref<Role[]>([])
const catalog = ref<PermissionCatalog>({ groups: [] })
const loading = ref(true)
const loadError = ref<string | null>(null)
const createOpen = ref(false)
const detail = ref<InstanceType<typeof RoleDetailPanel> | null>(null)

const sortedRoles = computed(() => sortRoles(roles.value))

const selectedRole = computed<Role | null>(() => {
  const code = route.query.role
  return roles.value.find((r) => r.code === code) ?? sortedRoles.value[0] ?? null
})

function selectCode(code: string): Promise<unknown> {
  if (route.query.role === code) return Promise.resolve()
  return router.replace({ query: { ...route.query, role: code } })
}

function onSelect(id: string): void {
  const role = roles.value.find((r) => r.id === id)
  if (role) void selectCode(role.code)
}

/** 詳情沒有未儲存變更，或使用者選「放棄變更」時回 true */
async function confirmLeave(): Promise<boolean> {
  if (!detail.value?.isDirty) return true
  return confirmDiscardChanges()
}

onBeforeRouteUpdate(() => confirmLeave())
onBeforeRouteLeave(() => confirmLeave())

async function load(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    const [list, cat] = await Promise.all([listRoles(), fetchPermissionCatalog()])
    roles.value = list
    catalog.value = cat
  } catch (err) {
    loadError.value = errorMessage(err, '請稍後再試一次')
  } finally {
    loading.value = false
  }
}

/** 寫入後重新抓清單：保留目前畫面（不顯示骨架），失敗時沿用舊清單並提示 */
async function reloadRoles(): Promise<void> {
  try {
    roles.value = await listRoles()
  } catch (err) {
    ElMessage.error(errorMessage(err, '無法重新載入角色清單，請重新整理頁面'))
  }
}

async function onSaved(): Promise<void> {
  await reloadRoles()
}

async function onDeleted(): Promise<void> {
  await reloadRoles()
  const first = sortedRoles.value[0]
  if (first) await selectCode(first.code)
}

async function onCreated(role: Role): Promise<void> {
  await reloadRoles()
  await selectCode(role.code)
}

onMounted(load)
</script>

<template>
  <div class="roles-page">
    <PageHeader
      title="角色權限"
      subtitle="設定每個角色可以使用的功能；員工的個別調整在「員工帳號」頁"
    >
      <template
        v-if="canWrite"
        #actions
      >
        <el-button
          type="primary"
          :icon="Plus"
          :disabled="loading || loadError !== null"
          @click="createOpen = true"
        >
          新增角色
        </el-button>
      </template>
    </PageHeader>

    <div
      v-if="loadError !== null"
      class="roles-page__panel"
    >
      <EmptyState
        variant="error"
        title="無法載入角色"
        :description="loadError"
      >
        <template #action>
          <el-button @click="load">
            重試
          </el-button>
        </template>
      </EmptyState>
    </div>

    <div
      v-else
      class="roles-page__layout"
    >
      <aside class="roles-page__panel roles-page__list">
        <p
          class="roles-page__list-title"
          data-test="roles-count"
        >
          角色（{{ loading ? '—' : roles.length }}）
        </p>
        <el-skeleton
          v-if="loading"
          animated
        >
          <template #template>
            <el-skeleton-item
              v-for="i in 5"
              :key="i"
              variant="rect"
              class="roles-page__card-skeleton"
            />
          </template>
        </el-skeleton>
        <RoleCardsGrid
          v-else
          :roles="roles"
          :model-value="selectedRole?.id ?? null"
          show-staff-count
          @update:model-value="onSelect"
        />
      </aside>

      <section class="roles-page__panel">
        <div
          v-if="loading"
          class="roles-page__detail-skeleton"
        >
          <el-skeleton
            :rows="8"
            animated
          />
        </div>
        <RoleDetailPanel
          v-else-if="selectedRole"
          :key="selectedRole.id"
          ref="detail"
          :role="selectedRole"
          :catalog="catalog"
          @saved="onSaved"
          @deleted="onDeleted"
        />
      </section>
    </div>

    <RoleCreateDialog
      v-if="canWrite"
      v-model="createOpen"
      :roles="roles"
      :catalog="catalog"
      @created="onCreated"
    />
  </div>
</template>

<style scoped>
.roles-page__layout {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.roles-page__panel {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

/* 左欄捲動時固定在上方 */
.roles-page__list {
  position: sticky;
  top: 0;
  padding: 12px;
}

.roles-page__list-title {
  margin: 0 0 10px 2px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.roles-page__card-skeleton {
  height: 76px;
  margin-bottom: 8px;
  border-radius: 8px;
}

.roles-page__detail-skeleton {
  padding: 20px;
}
</style>
