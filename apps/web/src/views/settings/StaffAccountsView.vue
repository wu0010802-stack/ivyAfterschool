<script setup lang="ts">
// FRONTEND-064：員工帳號列表頁（/settings/accounts，staff:read）。移植 ivy FE:src/components/settings/SettingsAccountsTab.vue
// 的列表欄位、操作下拉與重設密碼流程；去掉家長帳號清單、portal-only 角色、employee 連動、自訂新密碼輸入（臨時密碼由後端產生）。
// 設計稿：docs/mockups/page-settings-accounts.html。
// - 篩選與頁碼經 usePagedList（syncQuery）同步到網址；狀態篩選的 query 是字串，送 API 前轉成布林。
// - 操作欄（staff:write）：「編輯」+「更多 ▾」（啟用：重設密碼、停用；停用：重新啟用）。自己那列只有「編輯」
//   （後端 cannot_reset_self / cannot_deactivate_self）；權限比自己大的帳號兩者都停用並提示（後端 cannot_manage_staff）。
// - 建立 / 重設密碼 / 重新啟用成功開 TempPasswordDialog；關閉時清空密碼字串。
// - el-table-column 是泛型元件，每欄前的 `@vue-generic {StaffUser}` 註解讓 slot 的 row 有型別（vue-tsc 專用）。
import { ArrowDown, CircleClose, Key, Plus, RefreshRight } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, reactive, ref } from 'vue'
import { fetchPermissionCatalog, listRoles, type PermissionCatalog, type Role } from '@/api/roles'
import {
  activateStaffUser,
  deactivateStaffUser,
  listStaffUsers,
  resetStaffPassword,
  type StaffUser,
  type StaffUserCreated,
  type StaffUserListParams,
} from '@/api/staffUsers'
import AdminListToolbar, { type FilterGroup } from '@/components/common/AdminListToolbar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PageHeader from '@/components/common/PageHeader.vue'
import StaffUserFormDialog from '@/components/settings/StaffUserFormDialog.vue'
import TempPasswordDialog from '@/components/settings/TempPasswordDialog.vue'
import { usePagedList } from '@/composables/usePagedList'
import { PERMISSIONS } from '@/constants/permissions'
import { formatDateTime } from '@/shared/utils/datetime'
import { errorMessage, isCanceled } from '@/shared/utils/errorMessage'
import { useAuthStore } from '@/stores/auth'
import { usePermission } from '@/utils/permission'

interface StaffFilters extends Record<string, unknown> {
  q?: string
  role_id?: string
  /** 網址還原時是 'true' / 'false' 字串 */
  is_active?: boolean | string
}

/** 與 RoleCardsGrid 同序：系統角色 admin → director → clerk → tutor，其餘依名稱 */
const SYSTEM_ORDER = ['admin', 'director', 'clerk', 'tutor']

function systemRank(code: string): number {
  const i = SYSTEM_ORDER.indexOf(code)
  return i === -1 ? SYSTEM_ORDER.length : i
}

function activeValue(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return undefined
}

function toApiParams(f: StaffFilters & { page: number; page_size: number }): StaffUserListParams {
  const params: StaffUserListParams = { page: f.page, page_size: f.page_size }
  if (typeof f.q === 'string' && f.q) params.q = f.q
  if (typeof f.role_id === 'string' && f.role_id) params.role_id = f.role_id
  const active = activeValue(f.is_active)
  if (active !== undefined) params.is_active = active
  return params
}

const list = usePagedList<StaffUser, StaffFilters>({
  fetch: (params) => listStaffUsers(toApiParams(params)),
  initialFilters: { q: undefined, role_id: undefined, is_active: undefined },
  syncQuery: true,
})
const { items, total, page, pageSize, filters, loading, error } = list

const auth = useAuthStore()
const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.STAFF_WRITE))
const selfId = computed(() => auth.user?.id ?? null)

// ---- 角色與權限目錄（篩選選項、個別調整標籤、員工表單） ----
const roles = ref<Role[]>([])
const catalog = ref<PermissionCatalog>({ groups: [] })
const refsLoaded = ref(false)

onMounted(async () => {
  try {
    const [roleList, cat] = await Promise.all([listRoles(), fetchPermissionCatalog()])
    roles.value = roleList
    catalog.value = cat
    refsLoaded.value = true
  } catch (err) {
    if (!isCanceled(err)) ElMessage.error(errorMessage(err, '無法載入角色清單，請重新整理頁面'))
  }
})

const sortedRoles = computed(() =>
  [...roles.value].sort((a, b) => systemRank(a.code) - systemRank(b.code) || a.name.localeCompare(b.name, 'zh-Hant')),
)

const permissionLabels = computed(
  () => new Map(catalog.value.groups.flatMap((g) => g.permissions.map((p) => [p.code, p.label] as const))),
)

function label(code: string): string {
  return permissionLabels.value.get(code) ?? code
}

// ---- 工具列 ----
const filterGroups = computed<FilterGroup[]>(() => [
  { key: 'role_id', label: '角色', options: sortedRoles.value.map((r) => ({ label: r.name, value: r.id })) },
  {
    key: 'is_active',
    label: '狀態',
    options: [
      { label: '啟用', value: true },
      { label: '停用', value: false },
    ],
  },
])

const search = computed(() => (typeof filters.q === 'string' ? filters.q : ''))

const filterValues = computed(() => ({
  role_id: typeof filters.role_id === 'string' && filters.role_id ? filters.role_id : undefined,
  is_active: activeValue(filters.is_active),
}))

function onSearch(value: string): void {
  const q = value || undefined
  if (q === (search.value || undefined)) return
  list.setFilters({ q })
}

function onFilterValues(next: Record<string, unknown>): void {
  list.setFilters({ role_id: next.role_id as string | undefined, is_active: next.is_active as boolean | undefined })
}

// ---- 表格 ----
function rowClass({ row }: { row: StaffUser }): string {
  return row.is_active ? '' : 'acct-row-inactive'
}

function adjustAria(row: StaffUser): string {
  return `額外授予 ${row.extra_permissions.length} 項、移除 ${row.revoked_permissions.length} 項`
}

/** 目標有效權限不是自己權限的子集合 → 操作停用（對應後端 cannot_manage_staff） */
function canManage(row: StaffUser): boolean {
  return row.effective_permissions.every((c) => auth.permissions.has(c))
}

function replaceRow(updated: StaffUser): void {
  items.value = items.value.map((r) => (r.id === updated.id ? updated : r))
}

// ---- 臨時密碼 ----
const tempOpen = ref(false)
const tempFor = reactive({ username: '', displayName: '', password: '' })

function showTemp(u: Pick<StaffUser, 'username' | 'display_name'>, password: string): void {
  Object.assign(tempFor, { username: u.username, displayName: u.display_name, password })
  tempOpen.value = true
}

function onTempModel(open: boolean): void {
  tempOpen.value = open
  if (!open) tempFor.password = ''
}

// ---- 新增 / 編輯 ----
const formOpen = ref(false)
const editing = ref<StaffUser | null>(null)

function openCreate(): void {
  editing.value = null
  formOpen.value = true
}

function openEdit(row: StaffUser): void {
  editing.value = row
  formOpen.value = true
}

function onCreated(result: StaffUserCreated): void {
  showTemp(result.user, result.temp_password)
  void list.reload()
}

// ---- 列操作 ----
const busy = ref(false)

interface ConfirmOptions {
  type: 'warning' | 'info'
  /** 確定鈕紅色（停用） */
  danger?: boolean
}

async function confirm(message: string, title: string, confirmButtonText: string, opts: ConfirmOptions): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, title, {
      type: opts.type,
      confirmButtonText,
      cancelButtonText: '取消',
      ...(opts.danger ? { confirmButtonClass: 'el-button--danger' } : {}),
    })
    return true
  } catch {
    return false
  }
}

async function runRowAction(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await action()
  } catch (err) {
    ElMessage.error(errorMessage(err, '操作失敗，請稍後再試'))
  } finally {
    busy.value = false
  }
}

async function resetPassword(row: StaffUser): Promise<void> {
  const ok = await confirm(`重設後 ${row.display_name} 目前的登入會失效，確定要重設嗎？`, '重設密碼', '重設密碼', {
    type: 'warning',
  })
  if (!ok) return
  await runRowAction(async () => {
    const { temp_password: password } = await resetStaffPassword(row.id)
    showTemp(row, password)
    void list.reload()
  })
}

async function deactivate(row: StaffUser): Promise<void> {
  const ok = await confirm(`停用後 ${row.display_name} 將無法登入，確定要停用嗎？`, '停用帳號', '停用', {
    type: 'warning',
    danger: true,
  })
  if (!ok) return
  await runRowAction(async () => {
    replaceRow(await deactivateStaffUser(row.id))
    ElMessage.success(`已停用 ${row.display_name}`)
  })
}

async function activate(row: StaffUser): Promise<void> {
  const ok = await confirm(
    `重新啟用後會產生新的臨時密碼，${row.display_name} 登入後必須先修改密碼。確定要重新啟用嗎？`,
    '重新啟用帳號',
    '重新啟用',
    { type: 'info' },
  )
  if (!ok) return
  await runRowAction(async () => {
    const result = await activateStaffUser(row.id)
    replaceRow(result.user)
    showTemp(result.user, result.temp_password)
  })
}

function onCommand(command: string | number | object, row: StaffUser): void {
  if (command === 'reset') void resetPassword(row)
  else if (command === 'deactivate') void deactivate(row)
  else if (command === 'activate') void activate(row)
}
</script>

<template>
  <div class="accounts-page">
    <PageHeader
      title="員工帳號"
      subtitle="建立員工登入帳號、指定角色；個別員工的權限可以在角色之外額外加減"
    >
      <template
        v-if="canWrite"
        #actions
      >
        <el-button
          type="primary"
          :icon="Plus"
          :disabled="loading || error !== null || !refsLoaded"
          @click="openCreate"
        >
          新增員工
        </el-button>
      </template>
    </PageHeader>

    <section class="accounts-page__panel">
      <AdminListToolbar
        :search="search"
        search-placeholder="搜尋帳號或姓名"
        :filters="filterGroups"
        :filter-values="filterValues"
        :total="loading || error ? undefined : total"
        @update:search="onSearch"
        @update:filter-values="onFilterValues"
      />

      <EmptyState
        v-if="error"
        variant="error"
        title="無法載入員工帳號"
        :description="error"
      >
        <template #action>
          <el-button @click="list.reload">
            重試
          </el-button>
        </template>
      </EmptyState>
      <template v-else>
        <el-table
          v-loading="loading"
          class="accounts-page__table"
          :data="items"
          :row-class-name="rowClass"
        >
          <!-- @vue-generic {StaffUser} -->
          <el-table-column
            label="帳號"
            min-width="120"
          >
            <template #default="{ row }: { row: StaffUser }">
              <span class="acct-username"><span class="acct-mono">{{ row.username }}</span><el-tag
                v-if="row.id === selfId"
                size="small"
                type="primary"
                effect="plain"
                disable-transitions
              >你</el-tag></span>
            </template>
          </el-table-column>
          <el-table-column
            prop="display_name"
            label="姓名"
            min-width="90"
            show-overflow-tooltip
          />
          <!-- @vue-generic {StaffUser} -->
          <el-table-column
            label="角色"
            min-width="100"
            show-overflow-tooltip
          >
            <template #default="{ row }: { row: StaffUser }">
              {{ row.role.name }}
            </template>
          </el-table-column>
          <!-- @vue-generic {StaffUser} -->
          <el-table-column
            label="個別調整"
            width="96"
          >
            <template #default="{ row }: { row: StaffUser }">
              <el-tooltip
                v-if="row.extra_permissions.length || row.revoked_permissions.length"
                placement="top"
              >
                <template #content>
                  <div class="acct-adjust__tip">
                    <div v-if="row.extra_permissions.length">
                      <b>額外授予：</b>{{ row.extra_permissions.map(label).join('、') }}
                    </div>
                    <div v-if="row.revoked_permissions.length">
                      <b>移除：</b>{{ row.revoked_permissions.map(label).join('、') }}
                    </div>
                  </div>
                </template>
                <span
                  class="acct-adjust"
                  tabindex="0"
                  :aria-label="adjustAria(row)"
                ><el-tag
                  v-if="row.extra_permissions.length"
                  size="small"
                  type="success"
                  disable-transitions
                >+{{ row.extra_permissions.length }}</el-tag><el-tag
                  v-if="row.revoked_permissions.length"
                  size="small"
                  type="danger"
                  disable-transitions
                >−{{ row.revoked_permissions.length }}</el-tag></span>
              </el-tooltip>
              <span
                v-else
                class="acct-never"
              >—</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {StaffUser} -->
          <el-table-column
            label="狀態"
            width="140"
          >
            <template #default="{ row }: { row: StaffUser }">
              <span class="acct-tags">
                <el-tag
                  v-if="row.is_active"
                  size="small"
                  type="success"
                  disable-transitions
                >啟用</el-tag>
                <el-tag
                  v-else
                  size="small"
                  type="info"
                  effect="plain"
                  disable-transitions
                >停用</el-tag>
                <el-tag
                  v-if="row.must_change_password"
                  size="small"
                  type="warning"
                  disable-transitions
                >待改密碼</el-tag>
              </span>
            </template>
          </el-table-column>
          <!-- @vue-generic {StaffUser} -->
          <el-table-column
            label="最後登入"
            width="150"
          >
            <template #default="{ row }: { row: StaffUser }">
              <span v-if="row.last_login_at">{{ formatDateTime(row.last_login_at) }}</span>
              <span
                v-else
                class="acct-never"
              >從未登入</span>
            </template>
          </el-table-column>
          <!-- @vue-generic {StaffUser} -->
          <el-table-column
            v-if="canWrite"
            label="操作"
            width="130"
            fixed="right"
          >
            <template #default="{ row }: { row: StaffUser }">
              <el-tooltip
                :disabled="canManage(row)"
                content="無法管理權限比你大的帳號"
                placement="left"
              >
                <span class="acct-ops">
                  <el-button
                    link
                    type="primary"
                    :disabled="!canManage(row)"
                    @click="openEdit(row)"
                  >
                    編輯
                  </el-button>
                  <el-dropdown
                    v-if="row.id !== selfId"
                    trigger="click"
                    :disabled="!canManage(row) || busy"
                    @command="(cmd: string | number | object) => onCommand(cmd, row)"
                  >
                    <el-button
                      link
                      type="primary"
                      :disabled="!canManage(row)"
                    >
                      更多<el-icon class="el-icon--right">
                        <ArrowDown />
                      </el-icon>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <template v-if="row.is_active">
                          <el-dropdown-item command="reset">
                            <el-icon><Key /></el-icon>重設密碼
                          </el-dropdown-item>
                          <el-dropdown-item
                            command="deactivate"
                            divided
                            class="acct-danger-item"
                          >
                            <el-icon><CircleClose /></el-icon>停用
                          </el-dropdown-item>
                        </template>
                        <el-dropdown-item
                          v-else
                          command="activate"
                        >
                          <el-icon><RefreshRight /></el-icon>重新啟用
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </span>
              </el-tooltip>
            </template>
          </el-table-column>
          <template #empty>
            <EmptyState
              v-if="!loading"
              variant="inline"
              title="沒有符合條件的員工帳號"
              description="試著清除搜尋文字或調整角色、狀態篩選"
            />
            <span v-else />
          </template>
        </el-table>
        <div
          v-if="total > 0"
          class="accounts-page__pager"
        >
          <el-pagination
            :current-page="page"
            :page-size="pageSize"
            :total="total"
            layout="prev, pager, next"
            background
            @current-change="list.setPage"
          />
        </div>
      </template>
    </section>

    <template v-if="canWrite">
      <StaffUserFormDialog
        v-model="formOpen"
        :user="editing"
        :roles="roles"
        :catalog="catalog"
        @created="onCreated"
        @updated="replaceRow"
      />
      <TempPasswordDialog
        :model-value="tempOpen"
        :username="tempFor.username"
        :display-name="tempFor.displayName"
        :temp-password="tempFor.password"
        @update:model-value="onTempModel"
      />
    </template>
  </div>
</template>

<style scoped>
.accounts-page__panel {
  padding: 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.accounts-page__table {
  width: 100%;
}

.accounts-page__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

.acct-username {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.acct-mono {
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
}

.acct-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.acct-adjust {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  cursor: default;
}

.acct-adjust__tip {
  max-width: 280px;
  font-size: 12px;
  line-height: 1.7;
}

.acct-adjust__tip b {
  font-weight: 600;
}

.acct-never {
  color: var(--el-text-color-placeholder);
}

.accounts-page__table :deep(.acct-row-inactive td .cell) {
  color: var(--el-text-color-secondary);
}

.acct-ops {
  display: inline-flex;
  gap: 12px;
  align-items: center;
}

.acct-ops .el-button + .el-button {
  margin-left: 0;
}
</style>

<style>
/* 下拉選單 teleport 到 body，scoped 樣式碰不到 */
.el-dropdown-menu__item.acct-danger-item,
.el-dropdown-menu__item.acct-danger-item:not(.is-disabled):hover {
  color: var(--el-color-danger);
}
</style>
