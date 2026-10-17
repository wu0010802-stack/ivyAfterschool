import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { ApiError } from '@/shared/types/api'
import { useReferenceTable } from './useReferenceTable'

interface Row {
  id: string
  name: string
  sort_order: number
}

interface Form {
  name: string
  sort_order: number
}

const ROWS: Row[] = [
  { id: 's1', name: '國語', sort_order: 1 },
  { id: 's2', name: '數學', sort_order: 2 },
]

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function clickMessageBoxButton(text: string): Promise<void> {
  await settle()
  // 已關閉的訊息框可能仍留在 DOM，取最後（最新）一個
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.el-message-box button'))
    .filter((b) => b.textContent?.trim() === text)
    .at(-1)
  if (!button) throw new Error(`確認框找不到按鈕「${text}」`)
  button.click()
  await settle()
}

function setup(overrides: { create?: () => Promise<unknown>; update?: () => Promise<unknown> } = {}) {
  const list = vi.fn(() => Promise.resolve(ROWS.map((r) => ({ ...r }))))
  const create = vi.fn<(form: Form) => Promise<unknown>>(overrides.create ?? (() => Promise.resolve({})))
  const update = vi.fn<(row: Row, form: Form) => Promise<unknown>>(
    overrides.update ?? (() => Promise.resolve({})),
  )
  const remove = vi.fn(() => Promise.resolve({ deleted: true, deactivated: false }))
  const onChanged = vi.fn()
  const table = useReferenceTable<Row, Form, 'name' | 'sort_order'>({
    list,
    create: (form) => create(form),
    update: (row, form) => update(row, form),
    remove,
    fields: ['name', 'sort_order'],
    toForm: (row, rows) => ({
      name: row?.name ?? '',
      sort_order: row?.sort_order ?? Math.max(0, ...rows.map((r) => r.sort_order)) + 1,
    }),
    validate: (form) => ({ name: form.name.trim() ? '' : '請輸入名稱' }),
    conflictField: 'name',
    confirmMessage: (row) => `確定要刪除科目「${row.name}」嗎？`,
    onChanged,
  })
  return { table, list, create, update, remove, onChanged }
}

describe('useReferenceTable', () => {
  it('useReferenceTable loads rows and builds create form from rows', async () => {
    const { table, list } = setup()
    await settle()

    expect(list).toHaveBeenCalledTimes(1)
    expect(table.rows.value.map((r) => r.id)).toEqual(['s1', 's2'])
    expect(table.loading.value).toBe(false)
    expect(table.error.value).toBe(false)

    table.openCreate()
    expect(table.open.value).toBe(true)
    expect(table.editing.value).toBeNull()
    expect({ ...table.form }).toEqual({ name: '', sort_order: 3 })
  })

  it('useReferenceTable maps validation errors to fields', async () => {
    const { table, create, onChanged } = setup({
      create: () =>
        Promise.reject(
          new ApiError(422, 'validation_error', '輸入資料格式錯誤', [
            { loc: ['body', 'name'], msg: '名稱不可空白', type: 'value_error' },
          ]),
        ),
    })
    await settle()
    table.openCreate()
    table.form.name = '自然'

    const pending = table.submit()
    expect(table.saving.value).toBe(true)
    await pending

    expect(create).toHaveBeenCalledWith({ name: '自然', sort_order: 3 })
    expect(table.fieldErrors.name).toBe('名稱不可空白')
    expect(table.fieldErrors.sort_order).toBe('')
    expect(table.open.value).toBe(true)
    expect(table.saving.value).toBe(false)
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('useReferenceTable maps conflict code to field', async () => {
    const { table, update } = setup({
      update: () => Promise.reject(new ApiError(409, 'subject_name_taken', '名稱已存在')),
    })
    await settle()
    table.openEdit(ROWS[0]!)
    expect({ ...table.form }).toEqual({ name: '國語', sort_order: 1 })
    table.form.name = '數學'

    await table.submit()

    expect(update).toHaveBeenCalledWith(ROWS[0], { name: '數學', sort_order: 1 })
    expect(table.fieldErrors.name).toBe('名稱已存在')
    expect(table.open.value).toBe(true)
    expect(table.saving.value).toBe(false)
  })

  it('useReferenceTable blocks submit when local validation fails', async () => {
    const { table, create } = setup()
    await settle()
    table.openCreate()
    table.form.name = '   '

    await table.submit()

    expect(create).not.toHaveBeenCalled()
    expect(table.fieldErrors.name).toBe('請輸入名稱')
  })

  it('useReferenceTable closes dialog and reloads after successful save', async () => {
    const { table, list, onChanged } = setup()
    await settle()
    table.openCreate()
    table.form.name = '自然'

    await table.submit()
    await settle()

    expect(table.open.value).toBe(false)
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('useReferenceTable reloads and emits changed after remove', async () => {
    const { table, list, remove, onChanged } = setup()
    await settle()
    expect(list).toHaveBeenCalledTimes(1)

    const pending = table.remove(ROWS[1]!)
    await clickMessageBoxButton('刪除')
    expect(await pending).toBe(true)
    await settle()

    expect(remove).toHaveBeenCalledWith(ROWS[1])
    expect(list).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })
})
