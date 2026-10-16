import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { ImportPreview } from '@/api/students'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentImportDialog from './StudentImportDialog.vue'

const IMPORT_URL = '/admin/students/import'
const TEMPLATE_URL = '/admin/students/import-template'
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ALL_PERMISSIONS = ['students:read', 'students:write', 'students:sensitive']

const PREVIEW_WITH_ERROR: ImportPreview = {
  rows: [
    { row_number: 2, display: { '學號*': 'S2001', '姓名*': '陳小安' }, errors: [] },
    { row_number: 3, display: { '學號*': 'S1001' }, errors: ['學號已存在：S1001'] },
  ],
  total: 2,
  valid: 1,
  invalid: 1,
}

const PREVIEW_ALL_VALID: ImportPreview = {
  rows: [
    { row_number: 2, display: { '學號*': 'S2001', '姓名*': '陳小安', '年級*': '2', 安親班班級: '低年級 B 班' }, errors: [] },
    { row_number: 3, display: { '學號*': 'S2002', '姓名*': '許文彥', '年級*': '4' }, errors: [] },
  ],
  total: 2,
  valid: 2,
  invalid: 0,
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountDialog(permissions: string[] = ALL_PERMISSIONS): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(StudentImportDialog, {
    props: { modelValue: true },
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'clerk01',
          display_name: '林行政',
          role: { id: 'r-clerk', code: 'clerk', name: '行政' },
          permissions,
          must_change_password: false,
        },
      },
    },
  })
  await settle()
  return wrapper as VueWrapper
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function footerButton(text: string): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到 footer 按鈕「${text}」`)
  return btn
}

function bodyButton(text: string): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__body button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  return btn
}

function xlsx(name = 'students.xlsx'): File {
  return new File(['PK\u0003\u0004 xlsx'], name, { type: XLSX_MIME })
}

async function chooseFile(file: File): Promise<void> {
  const input = dialog().find<HTMLInputElement>('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await settle()
}

async function confirmMessageBox(text: string): Promise<void> {
  await settle()
  const boxes = Array.from(document.body.querySelectorAll('.el-message-box'))
  const btn = Array.from(boxes.at(-1)?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`message box 找不到「${text}」`)
  btn.click()
  await settle()
}

function sentForm(index: number): FormData {
  const data = mock.history.post[index]?.data as FormData
  expect(data).toBeInstanceOf(FormData)
  return data
}

async function previewWith(preview: ImportPreview): Promise<void> {
  mock.onPost(IMPORT_URL).replyOnce(200, preview)
  await chooseFile(xlsx())
  await footerButton('預覽').trigger('click')
  await settle()
}

describe('StudentImportDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T02:00:00Z'))
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('StudentImportDialog previews uploaded file', async () => {
    await mountDialog()
    expect(dialog().find('.el-dialog__title').text()).toBe('匯入學生（Excel）')
    expect(footerButton('預覽').attributes('disabled')).toBeDefined()

    await previewWith(PREVIEW_WITH_ERROR)

    const form = sentForm(0)
    expect((form.get('file') as File).name).toBe('students.xlsx')
    expect(form.get('academic_year')).toBe('115')
    expect(form.get('dry_run')).toBe('true')
    expect(dialog().text()).toContain('共 2 列，正確 1 列，錯誤 1 列')
    expect(dialog().text()).toContain('學號已存在：S1001')
    const rows = dialog().findAll('.el-table__body tr.el-table__row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.findAll('td').map((td) => td.text()).slice(0, 3)).toEqual(['2', 'S2001', '陳小安'])
  })

  it('StudentImportDialog blocks import when any row invalid', async () => {
    await mountDialog()
    await previewWith(PREVIEW_WITH_ERROR)

    expect(footerButton('匯入').attributes('disabled')).toBeDefined()
    expect(dialog().text()).toContain('請修正 Excel 中的錯誤後重新上傳（匯入為全部成功或全部不寫入）')

    // 只顯示錯誤列
    await dialog().find('.el-switch').trigger('click')
    await settle()
    expect(dialog().findAll('.el-table__body tr.el-table__row')).toHaveLength(1)

    // 重新上傳回到步驟 1
    await bodyButton('重新上傳').trigger('click')
    await settle()
    expect(footerButton('預覽').attributes('disabled')).toBeDefined()
    expect(dialog().find('input[type=file]').exists()).toBe(true)
  })

  it('StudentImportDialog executes when all rows valid', async () => {
    const wrapper = await mountDialog()
    await previewWith(PREVIEW_ALL_VALID)
    expect(footerButton('匯入').attributes('disabled')).toBeUndefined()

    mock.onPost(IMPORT_URL).replyOnce(200, { created: 2, student_ids: ['a', 'b'] })
    await footerButton('匯入').trigger('click')
    await settle()
    expect(document.body.querySelector('.el-message-box')?.textContent).toContain('將建立 2 位學生，確定匯入嗎？')
    await confirmMessageBox('匯入')

    const form = sentForm(1)
    expect(form.get('dry_run')).toBe('false')
    expect(form.get('academic_year')).toBe('115')
    expect(dialog().text()).toContain('已建立 2 位學生')
    const imported = wrapper.emitted('imported') as [{ created: number }][] | undefined
    expect(imported?.[0]?.[0].created).toBe(2)
    expect(footerButton('完成').exists()).toBe(true)
  })

  it('StudentImportDialog returns to file step on import conflict', async () => {
    const wrapper = await mountDialog()
    await previewWith(PREVIEW_ALL_VALID)

    mock.onPost(IMPORT_URL).replyOnce(409, {
      error: { code: 'import_has_errors', message: '匯入資料有錯誤，請修正後重新預覽', details: { total: 2, valid: 1, invalid: 1, rows: [] } },
    })
    await footerButton('匯入').trigger('click')
    await confirmMessageBox('匯入')

    expect(dialog().text()).toContain('匯入資料有錯誤，請修正後重新預覽')
    expect(footerButton('預覽').exists()).toBe(true)
    expect(dialog().find('input[type=file]').exists()).toBe(true)
    expect(wrapper.emitted('imported')).toBeUndefined()
  })

  it('StudentImportDialog shows header problems from details', async () => {
    await mountDialog()
    mock.onPost(IMPORT_URL).replyOnce(422, {
      error: {
        code: 'import_invalid_header',
        message: '標題列不正確',
        details: { missing: ['學號*', '姓名*'], unexpected: ['電話'] },
      },
    })
    await chooseFile(xlsx())
    await footerButton('預覽').trigger('click')
    await settle()

    expect(dialog().text()).toContain('缺少欄位：學號*、姓名*')
    expect(dialog().text()).toContain('無法辨識的欄位：電話')
    expect(dialog().text()).toContain('請確認標題列使用範本欄名')

    mock.onPost(IMPORT_URL).replyOnce(422, {
      error: { code: 'import_invalid_header', message: '標題列不正確', details: { missing: [], unexpected: ['地址'] } },
    })
    await footerButton('預覽').trigger('click')
    await settle()
    expect(dialog().text()).toContain('無法辨識的欄位：地址')
    expect(dialog().text()).not.toContain('缺少欄位')

    mock.onPost(IMPORT_URL).replyOnce(422, {
      error: { code: 'import_too_many_rows', message: '匯入列數超過上限 500，請分批匯入', details: { max_rows: 500 } },
    })
    await footerButton('預覽').trigger('click')
    await settle()
    expect(dialog().text()).toContain('匯入列數超過上限 500，請分批匯入')
    expect(dialog().text()).not.toContain('無法辨識的欄位')
  })

  it('StudentImportDialog rejects non xlsx file client side', async () => {
    await mountDialog()

    await chooseFile(new File(['學號,姓名'], 'students.csv', { type: 'text/csv' }))

    expect(dialog().text()).toContain('只接受')
    expect(footerButton('預覽').attributes('disabled')).toBeDefined()
    await footerButton('預覽').trigger('click')
    await settle()
    expect(mock.history.post).toHaveLength(0)
  })

  it('StudentImportDialog downloads template', async () => {
    const downloads: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:template')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    mock
      .onGet(TEMPLATE_URL)
      .replyOnce(200, new Blob(['xlsx']), {
        'content-disposition': "attachment; filename*=UTF-8''%E5%AD%B8%E7%94%9F%E7%AF%84%E6%9C%AC-2026.xlsx",
      })
      .onGet(TEMPLATE_URL)
      .replyOnce(200, new Blob(['xlsx']))
    await mountDialog()

    await bodyButton('下載範本').trigger('click')
    await settle()
    await bodyButton('下載範本').trigger('click')
    await settle()

    expect(mock.history.get.map((c) => [c.url, c.responseType])).toEqual([
      [TEMPLATE_URL, 'blob'],
      [TEMPLATE_URL, 'blob'],
    ])
    expect(downloads).toEqual(['學生範本-2026.xlsx', '學生匯入範本.xlsx'])
  })

  it('StudentImportDialog warns about sensitive columns without permission', async () => {
    await mountDialog(['students:read', 'students:write'])
    expect(dialog().text()).toContain('你沒有敏感資料權限，含這兩欄資料的列會被標為錯誤')
    expect(dialog().text()).toContain('只支援以範本建立的檔案')
    document.body.innerHTML = ''

    await mountDialog()
    expect(dialog().text()).not.toContain('你沒有敏感資料權限')
  })

  it('StudentImportDialog resets state when reopened', async () => {
    const wrapper = await mountDialog()
    await previewWith(PREVIEW_WITH_ERROR)
    expect(dialog().text()).toContain('共 2 列')

    await wrapper.setProps({ modelValue: false })
    await settle()
    await wrapper.setProps({ modelValue: true })
    await settle()

    expect(dialog().text()).not.toContain('共 2 列')
    expect(footerButton('預覽').attributes('disabled')).toBeDefined()
  })
})
