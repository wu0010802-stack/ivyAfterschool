import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { ClassItem, ClassStaff } from '@/api/classes'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import ClassStaffDialog from './ClassStaffDialog.vue'

const OPTIONS_URL = '/admin/staff-users/options'
const PUT_URL = '/admin/classes/c1/staff'
const STAFF_OPTIONS = [
  { id: 'u3', display_name: '陳老師' },
  { id: 'u4', display_name: '林老師' },
]

function klass(staff: ClassStaff[] = []): ClassItem {
  return {
    id: 'c1',
    name: '低年級A班',
    grade_levels: [1, 2],
    academic_year: 115,
    sort_order: 1,
    archived_at: null,
    student_count: 18,
    staff,
  }
}

const CHEN_LEAD: ClassStaff = { staff_user_id: 'u3', display_name: '陳老師', role: 'lead' }

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountDialog(k: ClassItem): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(ClassStaffDialog, { props: { modelValue: true, klass: k } })
  await settle()
  return wrapper as VueWrapper
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function rows(): DOMWrapper<Element>[] {
  return dialog().findAll('.cs-row')
}

function row(index: number): DOMWrapper<Element> {
  const r = rows()[index]
  if (!r) throw new Error(`找不到第 ${index + 1} 列`)
  return r
}

function staffSelect(r: DOMWrapper<Element>): DOMWrapper<Element> {
  return r.find('.cs-row__staff .el-select')
}

function roleSelect(r: DOMWrapper<Element>): DOMWrapper<Element> {
  return r.find('.cs-row__role')
}

/** 打開下拉，回傳 teleport 到 body 的選項（以 input 的 aria-controls 對應） */
async function openOptions(select: DOMWrapper<Element>): Promise<HTMLElement[]> {
  await select.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = select.find('input').attributes('aria-controls')
  return Array.from(
    document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [],
  )
}

async function choose(select: DOMWrapper<Element>, label: string): Promise<void> {
  const option = (await openOptions(select)).find((o) => o.textContent?.trim() === label)
  if (!option) throw new Error(`找不到選項 ${label}`)
  option.click()
  await settle()
}

function footerButton(text: string): DOMWrapper<HTMLButtonElement> {
  const btn = dialog()
    .findAll<HTMLButtonElement>('button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕 ${text}`)
  return btn
}

function addButton(): DOMWrapper<HTMLButtonElement> {
  return footerButton('新增老師')
}

async function addRow(): Promise<void> {
  await addButton().trigger('click')
  await settle()
}

async function removeRow(r: DOMWrapper<Element>): Promise<void> {
  await r.find('.cs-row__remove').trigger('click')
  await settle()
}

async function submit(): Promise<void> {
  await footerButton('儲存').trigger('click')
  await settle()
}

function putBodies(): unknown[] {
  return mock.history.put.map((req) => JSON.parse(req.data as string))
}

describe('ClassStaffDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('ClassStaffDialog saves full staff list', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    const saved = klass([
      { staff_user_id: 'u3', display_name: '陳老師', role: 'assistant' },
      { staff_user_id: 'u4', display_name: '林老師', role: 'lead' },
    ])
    mock.onPut(PUT_URL).reply(200, saved)
    const wrapper = await mountDialog(klass([CHEN_LEAD]))

    expect(dialog().find('.el-dialog__title').text()).toBe('指派老師：低年級A班')
    await addRow()
    await choose(staffSelect(row(1)), '林老師')
    // 新列預設「協助老師」（已有負責老師），兩列都改成非預設值，驗證角色下拉有寫回
    expect(roleSelect(row(1)).text()).toContain('協助老師')
    await choose(roleSelect(row(1)), '負責老師')
    await choose(roleSelect(row(0)), '協助老師')
    await submit()

    expect(putBodies()).toEqual([
      {
        items: [
          { staff_user_id: 'u3', role: 'assistant' },
          { staff_user_id: 'u4', role: 'lead' },
        ],
      },
    ])
    expect(wrapper.emitted('saved')).toEqual([[saved]])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(document.body.textContent).toContain('已更新負責老師')
  })

  it('ClassStaffDialog prevents duplicate staff', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    await mountDialog(klass([CHEN_LEAD]))

    await addRow()
    const options = await openOptions(staffSelect(row(1)))
    const chen = options.find((o) => o.textContent?.trim() === '陳老師')
    const lin = options.find((o) => o.textContent?.trim() === '林老師')

    expect(chen?.classList.contains('is-disabled')).toBe(true)
    expect(lin?.classList.contains('is-disabled')).toBe(false)
  })

  it('ClassStaffDialog loads options and handles load failure', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    await mountDialog(klass())

    expect(mock.history.get.filter((r) => r.url === OPTIONS_URL)).toHaveLength(1)
    await addRow()
    const texts = (await openOptions(staffSelect(row(0)))).map((o) => o.textContent?.trim())
    expect(texts).toEqual(['陳老師', '林老師'])
  })

  it('ClassStaffDialog loads options and handles load failure: retry after 500', async () => {
    mock.onGet(OPTIONS_URL).replyOnce(500, { error: { code: 'internal_error', message: '伺服器錯誤', details: null } })
    mock.onGet(OPTIONS_URL).replyOnce(200, STAFF_OPTIONS)
    await mountDialog(klass([CHEN_LEAD]))

    expect(dialog().text()).toContain('無法載入員工清單')
    expect(addButton().element.disabled).toBe(true)

    await footerButton('重試').trigger('click')
    await settle()

    expect(mock.history.get.filter((r) => r.url === OPTIONS_URL)).toHaveLength(2)
    expect(dialog().text()).not.toContain('無法載入員工清單')
    expect(addButton().element.disabled).toBe(false)
  })

  it('ClassStaffDialog highlights invalid staff', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    mock.onPut(PUT_URL).reply(422, {
      error: { code: 'invalid_staff', message: '部分員工不存在或已停用', details: { invalid: ['u4'] } },
    })
    const wrapper = await mountDialog(
      klass([CHEN_LEAD, { staff_user_id: 'u4', display_name: '林老師', role: 'assistant' }]),
    )

    await submit()

    expect(dialog().text()).toContain('部分員工已停用或不存在，請重新選擇')
    expect(row(0).classes()).not.toContain('is-error')
    expect(row(1).classes()).toContain('is-error')
    expect(row(1).text()).toContain('此員工已停用或不存在')
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('ClassStaffDialog highlights invalid staff: other errors show backend message', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    mock.onPut(PUT_URL).reply(409, {
      error: { code: 'class_archived', message: '班級已封存，無法修改', details: null },
    })
    const wrapper = await mountDialog(klass([CHEN_LEAD]))

    await submit()

    expect(document.body.textContent).toContain('班級已封存，無法修改')
    expect(dialog().text()).not.toContain('部分員工已停用或不存在，請重新選擇')
    expect(row(0).classes()).not.toContain('is-error')
    expect(wrapper.emitted('saved')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('ClassStaffDialog clears all staff', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    mock.onPut(PUT_URL).reply(200, klass())
    const wrapper = await mountDialog(
      klass([CHEN_LEAD, { staff_user_id: 'u4', display_name: '林老師', role: 'assistant' }]),
    )

    await removeRow(row(1))
    await removeRow(row(0))

    expect(rows()).toHaveLength(0)
    expect(dialog().text()).toContain('尚未指派老師；直接儲存會清除這個班的所有負責老師')
    await submit()

    expect(putBodies()).toEqual([{ items: [] }])
    expect(wrapper.emitted('saved')).toEqual([[klass()]])
  })

  it('ClassStaffDialog marks deactivated assigned staff', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    await mountDialog(klass([CHEN_LEAD, { staff_user_id: 'u9', display_name: '王老師', role: 'assistant' }]))

    expect(row(1).text()).toContain('王老師')
    expect(row(1).find('.el-tag').text()).toBe('已停用')
    expect(row(0).text()).not.toContain('已停用')
  })

  it('ClassStaffDialog marks deactivated assigned staff: blocks submit until replaced', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    mock.onPut(PUT_URL).reply(200, klass([CHEN_LEAD]))
    await mountDialog(klass([CHEN_LEAD, { staff_user_id: 'u9', display_name: '王老師', role: 'assistant' }]))

    await submit()

    expect(mock.history.put).toHaveLength(0)
    expect(row(1).classes()).toContain('is-error')
    expect(row(1).text()).toContain('此員工已停用，請移除或更換')

    await choose(staffSelect(row(1)), '林老師')
    expect(row(1).classes()).not.toContain('is-error')
    await submit()

    expect(putBodies()).toEqual([
      {
        items: [
          { staff_user_id: 'u3', role: 'lead' },
          { staff_user_id: 'u4', role: 'assistant' },
        ],
      },
    ])
  })

  it('ClassStaffDialog requires staff on every row and defaults new row role', async () => {
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    await mountDialog(klass())

    await addRow()
    expect(roleSelect(row(0)).text()).toContain('負責老師')
    await addRow()
    expect(roleSelect(row(1)).text()).toContain('協助老師')
    expect(dialog().find('.cs-foot__count').text()).toBe('2 / 20')

    await choose(staffSelect(row(0)), '陳老師')
    await submit()

    expect(mock.history.put).toHaveLength(0)
    expect(row(0).classes()).not.toContain('is-error')
    expect(row(1).classes()).toContain('is-error')
    expect(row(1).text()).toContain('請選擇員工')
  })

  it('ClassStaffDialog limits rows to twenty', async () => {
    // happy-dom 渲染 40 個 el-select 要十幾秒（與元件無關），上限只看列數，這裡把下拉換成 stub
    mock.onGet(OPTIONS_URL).reply(200, STAFF_OPTIONS)
    const staff = Array.from({ length: 19 }, (_, i) => ({
      staff_user_id: `m${i}`,
      display_name: `老師${i}`,
      role: i === 0 ? ('lead' as const) : ('assistant' as const),
    }))
    mount(ClassStaffDialog, {
      props: { modelValue: true, klass: klass(staff) },
      global: { stubs: { ElSelect: true, ElOption: true } },
    })
    await settle()

    expect(dialog().find('.cs-foot__count').text()).toBe('19 / 20')
    expect(addButton().element.disabled).toBe(false)
    await addRow()

    expect(rows()).toHaveLength(20)
    expect(dialog().find('.cs-foot__count').text()).toBe('20 / 20')
    expect(addButton().element.disabled).toBe(true)
  })

  it('ClassStaffDialog disables save while options are loading', async () => {
    let release: () => void = () => {}
    mock.onGet(OPTIONS_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, STAFF_OPTIONS])
        }),
    )
    await mountDialog(klass([CHEN_LEAD]))

    expect(footerButton('儲存').element.disabled).toBe(true)
    expect(addButton().element.disabled).toBe(true)
    // 載入中仍顯示已指派員工的名字，不是 id
    expect(row(0).text()).toContain('陳老師')
    expect(row(0).text()).not.toContain('u3')

    release()
    await settle()

    expect(footerButton('儲存').element.disabled).toBe(false)
    expect(addButton().element.disabled).toBe(false)
  })
})
