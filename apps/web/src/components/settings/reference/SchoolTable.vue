<script setup lang="ts">
// FRONTEND-061：參考資料頁「合作國小」分頁（列表、新增 / 編輯 dialog、刪除）。
// 設計稿：docs/mockups/page-settings-reference.html（RefTable 段）。
// - 依名稱排列；簡稱空白顯示「—」，停用的列文字變灰。缺 settings:write 時沒有新增按鈕與操作欄。
// - 簡稱空白送 null；422 欄位錯誤與 409 名稱重複顯示在欄位下方、dialog 不關；寫入成功後重新載入並讓 lookups 的國小快取失效。
// - 刪除被學生引用的國小時後端改為停用（deactivated），訊息依回傳值決定。
import { Plus } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { schoolsApi, type DeleteResult, type School } from '@/api/referenceData'
import EmptyState from '@/components/common/EmptyState.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import { useReferenceTable } from '@/composables/useReferenceTable'
import { PERMISSIONS } from '@/constants/permissions'
import { useLookupsStore } from '@/stores/lookups'
import { usePermission } from '@/utils/permission'

interface SchoolForm {
  name: string
  short_name: string
  is_active: boolean
}

const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.SETTINGS_WRITE))
const lookups = useLookupsStore()

function toBody(form: SchoolForm) {
  return { name: form.name.trim(), short_name: form.short_name.trim() || null, is_active: form.is_active }
}

const {
  rows: items,
  loading,
  error: loadFailed,
  reload: load,
  open: dialogOpen,
  editing,
  form,
  fieldErrors: errors,
  saving,
  isDirty,
  openCreate,
  openEdit,
  submit,
  remove: confirmDelete,
} = useReferenceTable<School, SchoolForm, 'name' | 'short_name'>({
  list: () => schoolsApi.list(),
  create: (f) => schoolsApi.create(toBody(f)),
  update: (row, f) => schoolsApi.update(row.id, toBody(f)),
  remove: (row) => schoolsApi.remove(row.id),
  fields: ['name', 'short_name'],
  toForm: (row) => ({
    name: row?.name ?? '',
    short_name: row?.short_name ?? '',
    is_active: row?.is_active ?? true,
  }),
  validate: (f) => ({ name: f.name.trim() ? '' : '請輸入名稱' }),
  conflictField: 'name',
  confirmMessage: (row) => `確定要刪除合作國小「${row.name}」嗎？`,
  deleteSuccessMessage: (result, row) =>
    (result as DeleteResult).deactivated ? `「${row.name}」已有資料引用，已改為停用` : '已刪除',
  onChanged: () => lookups.invalidate('schools'),
})

const sortedItems = computed(() => [...items.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')))

function rowClass({ row }: { row: School }): string {
  return row.is_active ? '' : 'ref-row-inactive'
}
</script>

<template>
  <div class="ref-table">
    <div class="ref-toolbar">
      <span class="ref-toolbar__hint">學生資料的就讀國小下拉；簡稱用於學生列表與家長端</span>
      <span class="ref-toolbar__spacer" />
      <el-button
        v-if="canWrite"
        type="primary"
        :icon="Plus"
        :disabled="loadFailed"
        @click="openCreate"
      >
        新增合作國小
      </el-button>
    </div>

    <EmptyState
      v-if="loadFailed"
      variant="error"
      title="無法載入合作國小"
      description="網路連線中斷，請確認網路後再試一次"
    >
      <template #action>
        <el-button @click="load">
          重試
        </el-button>
      </template>
    </EmptyState>
    <el-table
      v-else
      v-loading="loading"
      :data="sortedItems"
      :row-class-name="rowClass"
    >
      <el-table-column
        prop="name"
        label="名稱"
        min-width="200"
        show-overflow-tooltip
      />
      <!-- @vue-generic {School} -->
      <el-table-column
        label="簡稱"
        width="160"
      >
        <template #default="{ row }: { row: School }">
          <span v-if="row.short_name">{{ row.short_name }}</span>
          <span
            v-else
            class="ref-blank"
          >—</span>
        </template>
      </el-table-column>
      <!-- @vue-generic {School} -->
      <el-table-column
        label="狀態"
        width="100"
      >
        <template #default="{ row }: { row: School }">
          <el-tag
            v-if="row.is_active"
            size="small"
            type="success"
            disable-transitions
          >
            啟用
          </el-tag>
          <el-tag
            v-else
            size="small"
            type="info"
            effect="plain"
            disable-transitions
          >
            停用
          </el-tag>
        </template>
      </el-table-column>
      <!-- @vue-generic {School} -->
      <el-table-column
        v-if="canWrite"
        label="操作"
        width="120"
        fixed="right"
      >
        <template #default="{ row }: { row: School }">
          <span class="ref-ops">
            <el-button
              link
              type="primary"
              @click="openEdit(row)"
            >
              編輯
            </el-button>
            <el-button
              link
              type="danger"
              @click="confirmDelete(row)"
            >
              刪除
            </el-button>
          </span>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyState
          v-if="!loading"
          title="尚未建立合作國小"
        >
          <template
            v-if="canWrite"
            #action
          >
            <el-button
              type="primary"
              :icon="Plus"
              @click="openCreate"
            >
              新增合作國小
            </el-button>
          </template>
        </EmptyState>
      </template>
    </el-table>

    <FormDialog
      v-model="dialogOpen"
      :title="editing ? '編輯合作國小' : '新增合作國小'"
      size="sm"
      :loading="saving"
      :dirty="isDirty"
      @submit="submit"
    >
      <el-form
        label-position="top"
        :disabled="saving"
        @submit.prevent
      >
        <el-form-item
          label="名稱"
          required
          :error="errors.name"
        >
          <el-input
            v-model="form.name"
            maxlength="50"
            show-word-limit
            placeholder="例如 某某國民小學"
            @input="errors.name = ''"
          />
        </el-form-item>
        <el-form-item
          label="簡稱"
          :error="errors.short_name"
        >
          <el-input
            v-model="form.short_name"
            maxlength="20"
            show-word-limit
            placeholder="例如 某某國小"
            @input="errors.short_name = ''"
          />
          <div class="form-hint">
            學生列表與家長端顯示用；空白時顯示完整名稱
          </div>
        </el-form-item>
        <el-form-item label="啟用">
          <el-switch v-model="form.is_active" />
          <span class="ref-switch-hint">{{ form.is_active ? '會出現在下拉選單' : '不會出現在新增資料的下拉選單' }}</span>
        </el-form-item>
      </el-form>
    </FormDialog>
  </div>
</template>

<style scoped>
.ref-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  min-height: 32px;
  margin-bottom: 12px;
}

.ref-toolbar__hint {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.ref-toolbar__spacer {
  flex: 1;
}

.ref-table :deep(.ref-row-inactive td .cell) {
  color: var(--el-text-color-secondary);
}

.ref-blank {
  color: var(--el-text-color-secondary);
}

.ref-ops {
  display: inline-flex;
  gap: 12px;
}

.ref-ops :deep(.el-button + .el-button) {
  margin-left: 0;
}

.ref-switch-hint {
  margin-left: 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.form-hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
</style>
