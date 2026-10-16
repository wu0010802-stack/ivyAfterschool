<script setup lang="ts">
// FRONTEND-099：指派班級負責老師（PUT /admin/classes/{id}/staff 整批取代，BACKEND-140 / 146）。
// 設計稿：docs/mockups/page-classes.html（ClassStaffDialog 段）。
// class_staff 只用於「只看我的班」篩選與通知收件人，不影響權限（domain_spec M3）。
// - 員工選項開啟時以 listStaffOptions() 取得（只含啟用員工）；已指派但不在選項內的人視為已停用，送出前要移除或更換。
// - 已被其他列選走的員工在下拉中 disabled；最多 20 列；空清單送 {items: []} = 清除全部。
// - 422 invalid_staff：頂端 alert + 把 details.invalid 的 id 所在列標紅框。
import { Delete, Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, reactive, ref, watch } from 'vue'
import { setClassStaff, type ClassItem, type ClassStaffInput } from '@/api/classes'
import { listStaffOptions, type StaffOption } from '@/api/staffUsers'
import FormDialog from '@/components/common/FormDialog.vue'
import { CLASS_STAFF_ROLE_LABELS } from '@/shared/constants/statusLabels'
import { CLASS_STAFF_ROLES, isApiError, type ClassStaffRole } from '@/shared/types/api'
import { errorCode, errorMessage } from '@/shared/utils/errorMessage'

const MAX_ROWS = 20
const INVALID_STAFF_ALERT = '部分員工已停用或不存在，請重新選擇'

interface StaffRow {
  key: number
  /** '' = 尚未選擇 */
  staff_user_id: string
  role: ClassStaffRole
  /** 初始指派時的名字；員工已停用（不在選項內）時用來顯示 */
  display_name: string
}

type OptionsState = 'loading' | 'ok' | 'error'

const props = defineProps<{
  modelValue: boolean
  klass: ClassItem
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  saved: [klass: ClassItem]
}>()

const options = ref<StaffOption[]>([])
const optionsState = ref<OptionsState>('loading')
const rows = ref<StaffRow[]>([])
const rowErrors = reactive<Record<number, string>>({})
const alertMsg = ref('')
const loading = ref(false)
const baseline = ref('')

let seq = 0
// 重試時舊請求晚回來不可覆蓋新結果
let loadToken = 0

const optionIds = computed(() => new Set(options.value.map((o) => o.id)))
const items = computed<ClassStaffInput[]>(() =>
  rows.value.map(({ staff_user_id, role }) => ({ staff_user_id, role })),
)
const dirty = computed(() => JSON.stringify(items.value) !== baseline.value)
const canAdd = computed(() => optionsState.value === 'ok' && rows.value.length < MAX_ROWS && !loading.value)

function toRows(): StaffRow[] {
  return props.klass.staff.map((s) => ({
    key: seq++,
    staff_user_id: s.staff_user_id,
    role: s.role,
    display_name: s.display_name,
  }))
}

function clearRowErrors(): void {
  for (const key of Object.keys(rowErrors)) delete rowErrors[Number(key)]
}

async function loadOptions(): Promise<void> {
  const token = ++loadToken
  optionsState.value = 'loading'
  try {
    const result = await listStaffOptions()
    if (token !== loadToken) return
    options.value = result
    optionsState.value = 'ok'
  } catch {
    if (token !== loadToken) return
    optionsState.value = 'error'
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    rows.value = toRows()
    baseline.value = JSON.stringify(items.value)
    alertMsg.value = ''
    clearRowErrors()
    void loadOptions()
  },
  { immediate: true },
)

function isDeactivated(row: StaffRow): boolean {
  return optionsState.value === 'ok' && row.staff_user_id !== '' && !optionIds.value.has(row.staff_user_id)
}

/** 目前選的員工不在選項內時補一個 disabled 選項，下拉才顯示名字而不是 id */
function fallbackLabel(row: StaffRow): string {
  if (row.staff_user_id === '' || optionIds.value.has(row.staff_user_id)) return ''
  const name = row.display_name || row.staff_user_id
  return optionsState.value === 'ok' ? `${name}（已停用）` : name
}

function takenByOther(id: string, row: StaffRow): boolean {
  return rows.value.some((r) => r.key !== row.key && r.staff_user_id === id)
}

function rowName(row: StaffRow): string {
  return options.value.find((o) => o.id === row.staff_user_id)?.display_name || row.display_name || '這一列'
}

function addRow(): void {
  if (!canAdd.value) return
  const role: ClassStaffRole = rows.value.some((r) => r.role === 'lead') ? 'assistant' : 'lead'
  rows.value = [...rows.value, { key: seq++, staff_user_id: '', role, display_name: '' }]
}

function removeRow(row: StaffRow): void {
  rows.value = rows.value.filter((r) => r.key !== row.key)
  delete rowErrors[row.key]
}

function onPick(row: StaffRow): void {
  delete rowErrors[row.key]
  alertMsg.value = ''
}

function invalidIds(err: unknown): Set<string> {
  if (!isApiError(err) || err.details === null || typeof err.details !== 'object') return new Set()
  const invalid = (err.details as { invalid?: unknown }).invalid
  return new Set(Array.isArray(invalid) ? invalid.filter((v): v is string => typeof v === 'string') : [])
}

function validate(): boolean {
  clearRowErrors()
  for (const r of rows.value) {
    if (r.staff_user_id === '') rowErrors[r.key] = '請選擇員工'
    else if (isDeactivated(r)) rowErrors[r.key] = '此員工已停用，請移除或更換'
  }
  return Object.keys(rowErrors).length === 0
}

async function submit(): Promise<void> {
  if (loading.value || optionsState.value === 'loading' || !validate()) return
  alertMsg.value = ''
  loading.value = true
  try {
    const saved = await setClassStaff(props.klass.id, items.value)
    ElMessage.success('已更新負責老師')
    emit('saved', saved)
    emit('update:modelValue', false)
  } catch (err) {
    if (errorCode(err) === 'invalid_staff') {
      alertMsg.value = INVALID_STAFF_ALERT
      const invalid = invalidIds(err)
      for (const r of rows.value) {
        if (invalid.has(r.staff_user_id)) rowErrors[r.key] = '此員工已停用或不存在'
      }
      return
    }
    ElMessage.error(errorMessage(err, '儲存失敗，請稍後再試'))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="`指派老師：${klass.name}`"
    :loading="loading"
    :dirty="dirty"
    :autofocus="false"
    :submit-disabled="optionsState === 'loading'"
    @update:model-value="(v) => emit('update:modelValue', v)"
    @submit="submit"
  >
    <p class="cs-hint">
      負責老師用於後台「只看我的班」篩選與班級相關通知，不影響可操作的權限。可指派多位老師，最多 {{ MAX_ROWS }} 位。
    </p>
    <el-alert
      v-if="optionsState === 'error'"
      class="cs-alert"
      type="error"
      :closable="false"
      show-icon
      title="無法載入員工清單"
    >
      <el-button
        class="cs-retry"
        size="small"
        @click="loadOptions"
      >
        重試
      </el-button>
    </el-alert>
    <el-alert
      v-if="alertMsg"
      class="cs-alert"
      type="error"
      show-icon
      :title="alertMsg"
      @close="alertMsg = ''"
    />

    <div
      v-if="rows.length"
      class="cs-head"
    >
      <span>員工</span>
      <span>角色</span>
      <span />
    </div>
    <div
      v-for="row in rows"
      :key="row.key"
      class="cs-row"
      :class="{ 'is-error': !!rowErrors[row.key] }"
    >
      <div class="cs-row__staff">
        <el-select
          v-model="row.staff_user_id"
          filterable
          placeholder="選擇員工"
          aria-label="員工"
          :loading="optionsState === 'loading'"
          :disabled="loading"
          @change="onPick(row)"
        >
          <el-option
            v-if="fallbackLabel(row)"
            :label="fallbackLabel(row)"
            :value="row.staff_user_id"
            disabled
          />
          <el-option
            v-for="o in options"
            :key="o.id"
            :label="o.display_name"
            :value="o.id"
            :disabled="takenByOther(o.id, row)"
          />
        </el-select>
        <el-tag
          v-if="isDeactivated(row)"
          size="small"
          type="danger"
          effect="plain"
          disable-transitions
        >
          已停用
        </el-tag>
      </div>
      <el-select
        v-model="row.role"
        class="cs-row__role"
        aria-label="角色"
        :disabled="loading"
      >
        <el-option
          v-for="r in CLASS_STAFF_ROLES"
          :key="r"
          :label="CLASS_STAFF_ROLE_LABELS[r]"
          :value="r"
        />
      </el-select>
      <el-button
        class="cs-row__remove"
        text
        circle
        :icon="Delete"
        :disabled="loading"
        :aria-label="`移除 ${rowName(row)}`"
        @click="removeRow(row)"
      />
      <div
        v-if="rowErrors[row.key]"
        class="cs-row__error"
      >
        {{ rowErrors[row.key] }}
      </div>
    </div>
    <div
      v-if="!rows.length"
      class="cs-empty"
    >
      尚未指派老師；直接儲存會清除這個班的所有負責老師
    </div>
    <div class="cs-foot">
      <el-button
        :icon="Plus"
        :disabled="!canAdd"
        @click="addRow"
      >
        新增老師
      </el-button>
      <span class="cs-foot__count">{{ rows.length }} / {{ MAX_ROWS }}</span>
    </div>
  </FormDialog>
</template>

<style scoped>
.cs-hint {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.cs-alert {
  margin-bottom: 12px;
}

.cs-retry {
  margin-top: 4px;
}

.cs-head,
.cs-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 132px 32px;
  gap: 8px;
  align-items: center;
}

.cs-head {
  padding: 0 0 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.cs-row {
  padding: 6px 0;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.cs-row__staff {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.cs-row__staff .el-select {
  flex: 1;
  min-width: 0;
}

.cs-row.is-error .cs-row__staff :deep(.el-select__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.cs-row__error {
  grid-column: 1 / -1;
  margin-top: -2px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.cs-empty {
  padding: 16px 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.cs-foot {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 8px;
  margin-top: 8px;
  border-top: 1px solid var(--el-border-color-extra-light);
}

.cs-foot__count {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
