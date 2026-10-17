<script setup lang="ts">
// FRONTEND-059：參考資料頁「科目」分頁（列表、新增 / 編輯 dialog、刪除）。
// 設計稿：docs/mockups/page-settings-reference.html（RefTable 段）。
// - 依排序、再依名稱排列；停用的列文字變灰。缺 settings:write 時沒有新增按鈕與操作欄。
// - 422 欄位錯誤與 409 名稱重複顯示在欄位下方、dialog 不關；寫入成功後重新載入並讓 lookups 的科目快取失效。
// - 刪除被引用的科目時後端改為停用（deactivated），訊息依回傳值決定。
import { Plus } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { subjectsApi, type DeleteResult, type Subject } from '@/api/referenceData'
import EmptyState from '@/components/common/EmptyState.vue'
import FormDialog from '@/components/common/FormDialog.vue'
import { useReferenceTable } from '@/composables/useReferenceTable'
import { PERMISSIONS } from '@/constants/permissions'
import { useLookupsStore } from '@/stores/lookups'
import { usePermission } from '@/utils/permission'

interface SubjectForm {
  name: string
  sort_order: number
  is_active: boolean
}

const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.SETTINGS_WRITE))
const lookups = useLookupsStore()

function toBody(form: SubjectForm): SubjectForm {
  return { name: form.name.trim(), sort_order: form.sort_order, is_active: form.is_active }
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
} = useReferenceTable<Subject, SubjectForm, 'name' | 'sort_order'>({
  list: () => subjectsApi.list(),
  create: (f) => subjectsApi.create(toBody(f)),
  update: (row, f) => subjectsApi.update(row.id, toBody(f)),
  remove: (row) => subjectsApi.remove(row.id),
  fields: ['name', 'sort_order'],
  toForm: (row, rows) => ({
    name: row?.name ?? '',
    sort_order: row?.sort_order ?? Math.max(0, ...rows.map((r) => r.sort_order)) + 1,
    is_active: row?.is_active ?? true,
  }),
  validate: (f) => ({ name: f.name.trim() ? '' : '請輸入名稱' }),
  conflictField: 'name',
  confirmMessage: (row) => `確定要刪除科目「${row.name}」嗎？`,
  deleteSuccessMessage: (result, row) =>
    (result as DeleteResult).deactivated ? `「${row.name}」已有資料引用，已改為停用` : '已刪除',
  onChanged: () => lookups.invalidate('subjects'),
})

const sortedItems = computed(() =>
  [...items.value].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'zh-Hant')),
)

function rowClass({ row }: { row: Subject }): string {
  return row.is_active ? '' : 'ref-row-inactive'
}

function onSortOrder(value: number | null | undefined): void {
  form.sort_order = value ?? 0
}
</script>

<template>
  <div class="ref-table">
    <div class="ref-toolbar">
      <span class="ref-toolbar__hint">成績與作業的科目下拉依排序顯示；停用的科目不會出現在新增資料的下拉選單</span>
      <span class="ref-toolbar__spacer" />
      <el-button
        v-if="canWrite"
        type="primary"
        :icon="Plus"
        :disabled="loadFailed"
        @click="openCreate"
      >
        新增科目
      </el-button>
    </div>

    <EmptyState
      v-if="loadFailed"
      variant="error"
      title="無法載入科目"
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
      <el-table-column
        prop="sort_order"
        label="排序"
        width="90"
        align="right"
      />
      <!-- @vue-generic {Subject} -->
      <el-table-column
        label="狀態"
        width="100"
      >
        <template #default="{ row }: { row: Subject }">
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
      <!-- @vue-generic {Subject} -->
      <el-table-column
        v-if="canWrite"
        label="操作"
        width="120"
        fixed="right"
      >
        <template #default="{ row }: { row: Subject }">
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
          title="尚未建立科目"
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
              新增科目
            </el-button>
          </template>
        </EmptyState>
      </template>
    </el-table>

    <FormDialog
      v-model="dialogOpen"
      :title="editing ? '編輯科目' : '新增科目'"
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
            maxlength="20"
            show-word-limit
            @input="errors.name = ''"
          />
        </el-form-item>
        <el-form-item
          label="排序"
          :error="errors.sort_order"
        >
          <el-input-number
            class="ref-sort"
            :model-value="form.sort_order"
            :min="0"
            :step="1"
            step-strictly
            controls-position="right"
            @update:model-value="onSortOrder"
          />
          <div class="form-hint">
            數字小的排前面
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

.ref-ops {
  display: inline-flex;
  gap: 12px;
}

.ref-ops :deep(.el-button + .el-button) {
  margin-left: 0;
}

.ref-sort {
  width: 140px;
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
