// FRONTEND-309：參考資料頁四張管理表（科目 / 考試類型 / 合作國小 / 休息日）共用的列表與新增 / 編輯 / 刪除狀態。
// - 載入以序號丟棄過期回應；失敗時保留舊列、error 為 true，由畫面提供重試。
// - submit：先跑 validate（本地必填），通過才送 create / update；422 欄位錯誤顯示在對應欄位、
//   任何 409 的後端訊息顯示在 conflictField，dialog 都不關；其他錯誤以 ElMessage 顯示。
// - 寫入（新增 / 編輯 / 刪除）成功後呼叫 onChanged（例如讓 lookups 快取失效）並重新載入。
import { ElMessage } from 'element-plus'
import { reactive, ref, type Ref, type UnwrapRef } from 'vue'
import { useConfirmDelete } from '@/composables/useConfirmDelete'
import { useFormDirty } from '@/composables/useFormDirty'
import { isApiError } from '@/shared/types/api'
import { errorMessage, validationFieldErrors } from '@/shared/utils/errorMessage'

export interface ReferenceTableOptions<Row, Form extends object, Field extends string> {
  list: () => Promise<Row[]>
  create: (form: Form) => Promise<unknown>
  update: (row: Row, form: Form) => Promise<unknown>
  remove: (row: Row) => Promise<unknown>
  /** 表單上會顯示錯誤的欄位（422 details 只對應到這些欄位） */
  fields: readonly Field[]
  /** row 為 null 表示新增；rows 是目前列表（例如算下一個排序值） */
  toForm: (row: Row | null, rows: Row[]) => Form
  /** 本地驗證：回傳的欄位訊息寫入 fieldErrors，有任何非空訊息就不送出 */
  validate?: (form: Form, editing: Row | null) => Partial<Record<Field, string>>
  /** 409（名稱重複 / 日期已存在）時把後端訊息顯示在這個欄位 */
  conflictField: Field
  confirmMessage: (row: Row) => string
  /** 刪除成功訊息，預設「已刪除」 */
  deleteSuccessMessage?: (result: unknown, row: Row) => string
  onChanged?: () => void
  /** 預設 true：建立時立即載入 */
  immediate?: boolean
}

export function useReferenceTable<Row, Form extends object, Field extends string>(
  opts: ReferenceTableOptions<Row, Form, Field>,
) {
  const rows = ref<Row[]>([]) as Ref<Row[]>
  const loading = ref(false)
  const error = ref(false)
  let loadSeq = 0

  async function reload(): Promise<void> {
    const seq = ++loadSeq
    loading.value = true
    try {
      const list = await opts.list()
      if (seq !== loadSeq) return
      rows.value = list
      error.value = false
    } catch {
      if (seq === loadSeq) error.value = true
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  function afterWrite(): void {
    opts.onChanged?.()
    void reload()
  }

  // ---- 新增 / 編輯 dialog ----
  const open = ref(false)
  const editing = ref<Row | null>(null) as Ref<Row | null>
  const saving = ref(false)
  const form = reactive(opts.toForm(null, [])) as UnwrapRef<Form> & Form
  const fieldErrors = reactive(Object.fromEntries(opts.fields.map((key) => [key, '']))) as Record<Field, string>
  const { isDirty, markClean } = useFormDirty(form)

  function clearErrors(): void {
    for (const key of opts.fields) fieldErrors[key] = ''
  }

  function openDialog(row: Row | null): void {
    editing.value = row
    Object.assign(form, opts.toForm(row, rows.value))
    clearErrors()
    markClean()
    open.value = true
  }

  async function submit(): Promise<void> {
    const row = editing.value
    const local = opts.validate?.(form, row) ?? {}
    for (const [key, message] of Object.entries(local) as [Field, string | undefined][]) {
      fieldErrors[key] = message ?? ''
    }
    if (Object.values(local).some((message) => message)) return
    saving.value = true
    try {
      if (row) await opts.update(row, form)
      else await opts.create(form)
      ElMessage.success(row ? '已更新' : '已新增')
      open.value = false
      afterWrite()
    } catch (err) {
      if (isApiError(err) && err.status === 409) {
        fieldErrors[opts.conflictField] = err.message
        return
      }
      const serverErrors = validationFieldErrors(err)
      const mapped = opts.fields.filter((key) => serverErrors[key])
      for (const key of mapped) fieldErrors[key] = serverErrors[key]!
      if (!mapped.length) ElMessage.error(errorMessage(err, '儲存失敗，請稍後再試'))
    } finally {
      saving.value = false
    }
  }

  // ---- 刪除 ----
  const { confirmDelete } = useConfirmDelete<Row>({
    request: (row) => opts.remove(row),
    confirmMessage: opts.confirmMessage,
    successMessage: opts.deleteSuccessMessage,
    onSuccess: afterWrite,
  })

  if (opts.immediate ?? true) void reload()

  return {
    rows,
    loading,
    error,
    reload,
    open,
    editing,
    form,
    fieldErrors,
    saving,
    isDirty,
    openCreate: () => openDialog(null),
    openEdit: (row: Row) => openDialog(row),
    submit,
    remove: confirmDelete,
  }
}
