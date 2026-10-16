<script setup lang="ts">
// FRONTEND-096：遠端搜尋學生下拉（代登記請假、員工代建接送共用；GET /admin/students，BACKEND-159）。
// 設計稿：docs/mockups/component-student-select.html。
// - el-select filterable remote clearable；輸入停 300ms 才查（EP 內建的 remote debounce 設 0，由這裡控制，
//   才能在等待期間就顯示「搜尋中…」、清掉文字時立即作廢）。
// - 每次輸入遞增序號，回應晚到（序號不是最新）一律丟棄，畫面只反映最後一次輸入。
// - 空白輸入不查詢；查無結果「找不到符合的學生」；失敗清空選項並顯示「無法載入學生」。
import { Loading, WarningFilled } from '@element-plus/icons-vue'
import { onBeforeUnmount, ref } from 'vue'
import { listStudents, type StudentListItem, type StudentListParams } from '@/api/students'
import type { StudentStatus } from '@/shared/types/api'
import { isCanceled } from '@/shared/utils/errorMessage'

export interface StudentSelectInitialOption {
  id: string
  name: string
  student_no: string
  class_name: string | null
}

interface Option {
  id: string
  name: string
  student_no: string
  class_name: string | null
  /** 搜尋結果才有完整資料；initialOption 只有顯示用欄位 */
  item: StudentListItem | null
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null
    classId?: string
    statuses?: StudentStatus[]
    placeholder?: string
    disabled?: boolean
    initialOption?: StudentSelectInitialOption
  }>(),
  {
    classId: undefined,
    statuses: () => ['active'],
    placeholder: '輸入學號或姓名搜尋',
    disabled: false,
    initialOption: undefined,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
  change: [student: StudentListItem | null]
}>()

const DEBOUNCE_MS = 300
const PAGE_SIZE = 20

function fromInitial(o: StudentSelectInitialOption): Option {
  return { id: o.id, name: o.name, student_no: o.student_no, class_name: o.class_name, item: null }
}

function fromItem(s: StudentListItem): Option {
  return { id: s.id, name: s.name, student_no: s.student_no, class_name: s.class?.name ?? null, item: s }
}

const options = ref<Option[]>(props.initialOption ? [fromInitial(props.initialOption)] : [])
const loading = ref(false)
const failed = ref(false)
const query = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let seq = 0

onBeforeUnmount(() => clearTimeout(timer))

function optionLabel(o: Option): string {
  return `${o.name}（${o.student_no}・${o.class_name ?? '未分班'}）`
}

async function search(q: string, mySeq: number): Promise<void> {
  const params: StudentListParams = { q, status: props.statuses[0] ?? 'active', page_size: PAGE_SIZE }
  if (props.classId) params.class_id = props.classId
  try {
    const result = await listStudents(params)
    if (mySeq !== seq) return
    options.value = result.items.map(fromItem)
    failed.value = false
  } catch (err) {
    if (mySeq !== seq || isCanceled(err)) return
    options.value = []
    failed.value = true
  } finally {
    if (mySeq === seq) loading.value = false
  }
}

function remoteMethod(raw: string): void {
  const q = raw.trim()
  query.value = q
  clearTimeout(timer)
  // 每次輸入都作廢進行中的請求
  const mySeq = ++seq
  failed.value = false
  if (!q) {
    loading.value = false
    return
  }
  loading.value = true
  timer = setTimeout(() => void search(q, mySeq), DEBOUNCE_MS)
}

function onUpdate(value: string | null | undefined): void {
  const id = value || null
  // 清除後拿掉 initialOption（沒有完整學生資料），避免重選時 change 帶不出學生
  if (!id) options.value = options.value.filter((o) => o.item !== null)
  emit('update:modelValue', id)
  const picked = id ? options.value.find((o) => o.id === id) : undefined
  emit('change', picked?.item ?? null)
}
</script>

<template>
  <el-select
    class="student-select"
    :model-value="modelValue"
    filterable
    remote
    clearable
    :debounce="0"
    :remote-method="remoteMethod"
    :loading="loading"
    :placeholder="placeholder"
    :disabled="disabled"
    @update:model-value="onUpdate"
  >
    <el-option
      v-for="o in options"
      :key="o.id"
      :value="o.id"
      :label="optionLabel(o)"
    >
      <span class="student-option">
        <span class="student-option__name">{{ o.name }}</span>
        <span class="student-option__meta">（{{ o.student_no }}・{{ o.class_name ?? '未分班' }}）</span>
      </span>
    </el-option>
    <!-- 提供 #empty 時 EP 不再顯示 loading-text，搜尋中自己畫。
         沒有輸入時不提供 #empty：EP 的 remote 模式在沒有輸入、沒有選項時就不展開下拉 -->
    <template
      v-if="loading || failed || query"
      #empty
    >
      <div
        v-if="loading"
        class="student-select__status"
        role="status"
      >
        <el-icon class="is-loading">
          <Loading />
        </el-icon>搜尋中…
      </div>
      <div
        v-else-if="failed"
        class="student-select__status is-error"
        role="alert"
      >
        <el-icon><WarningFilled /></el-icon>無法載入學生
      </div>
      <div
        v-else-if="query"
        class="student-select__status"
      >
        找不到符合的學生
      </div>
    </template>
  </el-select>
</template>

<style scoped>
.student-select {
  width: 100%;
}

.student-option {
  display: flex;
  gap: 2px;
  align-items: baseline;
  min-width: 0;
}

.student-option__name {
  color: var(--el-text-color-primary);
}

.student-option__meta {
  overflow: hidden;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.el-select-dropdown__item.is-selected .student-option__name {
  font-weight: 600;
  color: var(--el-color-primary);
}

.student-select__status {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  padding: 10px 12px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.student-select__status.is-error {
  color: var(--el-color-danger);
}
</style>
