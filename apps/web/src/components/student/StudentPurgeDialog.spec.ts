import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { StudentDetail } from '@/api/students'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentPurgeDialog from './StudentPurgeDialog.vue'

const PURGE_URL = '/admin/students/s1/purge'

const STUDENT: StudentDetail = {
  id: 's1',
  student_no: 'S1001',
  name: '王小明',
  gender: 'male',
  grade_level: 6,
  school: null,
  school_class: '六年一班',
  class: null,
  status: 'withdrawn',
  archived_at: '2026-09-30T08:00:00Z',
  birthday: null,
  enrolled_on: '2025-08-26',
  withdrawn_on: '2026-09-30',
  note: null,
  photo_url: null,
  has_id_number: true,
  has_health_note: false,
  sensitive: null,
  guardians: [],
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountDialog(): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(StudentPurgeDialog, { props: { modelValue: true, student: STUDENT } })
  await settle()
  return wrapper as VueWrapper
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function button(text: string): DOMWrapper<HTMLButtonElement> {
  const btn = dialog()
    .findAll<HTMLButtonElement>('.el-dialog__footer button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕 ${text}`)
  return btn
}

function confirmInput(): DOMWrapper<HTMLInputElement> {
  return dialog().find<HTMLInputElement>('.el-dialog__body input')
}

async function typeConfirm(value: string): Promise<void> {
  await confirmInput().setValue(value)
  await settle()
}

async function purge(): Promise<void> {
  await button('永久刪除').trigger('click')
  await settle()
}

describe('StudentPurgeDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('StudentPurgeDialog requires exact student number', async () => {
    await mountDialog()

    expect(dialog().find('.el-dialog__title').text()).toBe('永久刪除學生資料')
    expect(dialog().text()).toContain('請輸入學號 S1001 以確認')
    const btn = button('永久刪除')
    expect(btn.classes()).toContain('el-button--danger')
    expect(btn.element.disabled).toBe(true)

    await typeConfirm('S100')
    expect(button('永久刪除').element.disabled).toBe(true)
    await typeConfirm('s1001')
    expect(button('永久刪除').element.disabled).toBe(true)
    await typeConfirm(' S1001 ')
    expect(button('永久刪除').element.disabled).toBe(false)
  })

  it('StudentPurgeDialog purges and emits', async () => {
    const result = { student_id: 's1', purged_at: '2026-10-02T08:00:00Z', anonymized_student_no: 'PURGED-7F3A' }
    mock.onPost(PURGE_URL).reply(200, result)
    const wrapper = await mountDialog()

    await typeConfirm(' S1001 ')
    await purge()

    expect(mock.history.post.map((r) => JSON.parse(r.data as string))).toEqual([{ confirm_student_no: 'S1001' }])
    expect(document.body.textContent).toContain('已永久刪除並匿名化（新編號 PURGED-7F3A）')
    const purged = wrapper.emitted('purged')?.[0]?.[0] as { anonymized_student_no: string }
    expect(purged.anonymized_student_no).toBe('PURGED-7F3A')
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('StudentPurgeDialog shows backend error', async () => {
    mock.onPost(PURGE_URL).reply(409, {
      error: { code: 'student_not_purgeable', message: '只能刪除已封存且退班的學生', details: null },
    })
    const wrapper = await mountDialog()

    await typeConfirm('S1001')
    await purge()

    // 錯誤 alert 在 dialog 內（測試環境的 Transition stub 會把 class 掛在外層，所以以 class 範圍內找 error alert）
    const alert = dialog().find('.purge-alert')
    expect(alert.find('.el-alert--error').text()).toBe('只能刪除已封存且退班的學生')
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('purged')).toBeUndefined()
    // 輸入保留，可以再試
    expect(confirmInput().element.value).toBe('S1001')
  })

  it('StudentPurgeDialog explains irreversible effects', async () => {
    await mountDialog()

    const text = dialog().text()
    expect(text).toContain(
      '永久刪除後將匿名化姓名，並清除身分證字號、健康備註、照片、監護人聯絡資料與家長綁定；出勤、成績等統計紀錄保留但不再能辨識此學生。此操作無法復原，並會記錄於稽核紀錄。',
    )
    expect(text).toContain('此操作無法復原')
    expect(text).toContain('出勤、成績等統計紀錄保留但不再能辨識此學生')
  })

  it('StudentPurgeDialog handles confirmation mismatch', async () => {
    mock.onPost(PURGE_URL).reply(422, {
      error: { code: 'purge_confirmation_mismatch', message: '確認學號不符', details: null },
    })
    const wrapper = await mountDialog()

    await typeConfirm('S1001')
    await purge()

    expect(dialog().find('.purge-mismatch').text()).toBe('確認學號不符，請重新整理後再試')
    expect(confirmInput().element.value).toBe('')
    expect(button('永久刪除').element.disabled).toBe(true)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('StudentPurgeDialog handles confirmation mismatch: cannot close while submitting', async () => {
    let release: () => void = () => {}
    mock.onPost(PURGE_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve([200, { student_id: 's1', purged_at: '2026-10-02T08:00:00Z', anonymized_student_no: 'PURGED-1' }])
        }),
    )
    const wrapper = await mountDialog()

    expect(dialog().find('.el-dialog__headerbtn').exists()).toBe(true)
    await typeConfirm('S1001')
    await purge()

    expect(button('取消').element.disabled).toBe(true)
    expect(dialog().find('.el-dialog__headerbtn').exists()).toBe(false)
    expect(confirmInput().element.disabled).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
    await settle()
    // 其他關閉路徑（例如 dialog 自己的 handleClose）也會經過 before-close，送出中一律忽略
    ;(wrapper.findComponent({ name: 'ElDialog' }).vm as unknown as { handleClose: () => void }).handleClose()
    await settle()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()

    release()
    await settle()
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  })

  it('StudentPurgeDialog requires exact student number: enter does not submit mismatched value', async () => {
    mock.onPost(PURGE_URL).reply(200, { student_id: 's1', purged_at: '2026-10-02T08:00:00Z', anonymized_student_no: 'P' })
    const wrapper = await mountDialog()

    await typeConfirm('S100')
    await confirmInput().trigger('keyup', { key: 'Enter' })
    await settle()

    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('purged')).toBeUndefined()
  })

  it('StudentPurgeDialog requires exact student number: overlay click does not close', async () => {
    const wrapper = await mountDialog()

    const overlay =
      document.body.querySelector<HTMLElement>('.el-overlay-dialog') ?? document.body.querySelector<HTMLElement>('.el-overlay')
    overlay!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    overlay!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    overlay!.click()
    await settle()

    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('StudentPurgeDialog requires exact student number: reopening clears input', async () => {
    const wrapper = await mountDialog()

    await typeConfirm('S1001')
    expect(button('永久刪除').element.disabled).toBe(false)
    await wrapper.setProps({ modelValue: false })
    await settle()
    await wrapper.setProps({ modelValue: true })
    await settle()

    expect(confirmInput().element.value).toBe('')
    expect(button('永久刪除').element.disabled).toBe(true)
  })

  it('StudentPurgeDialog handles confirmation mismatch: cancel closes', async () => {
    const wrapper = await mountDialog()

    await button('取消').trigger('click')

    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(mock.history.post).toHaveLength(0)
  })
})
