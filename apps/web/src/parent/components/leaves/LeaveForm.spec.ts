import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParentLimits } from '../../api/config'
import LeaveForm from './LeaveForm.vue'

const TODAY = '2026-10-02'
const KB = 1024
const MB = 1024 * 1024
const LIMITS: ParentLimits = {
  leave_past_days: 30,
  leave_future_days: 60,
  leave_max_attachments: 3,
  leave_max_attachment_mb: 10,
  authorization_max_days_ahead: 14,
  persons_max: 10,
}
const RANGE_MESSAGE = '請假日期需在今天前 30 天到後 60 天內'

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function mountForm(props: { limits?: ParentLimits; submitting?: boolean } = {}): VueWrapper {
  // form 要掛在 document 上，happy-dom 才會在點送出鈕時送出表單
  wrapper = mount(LeaveForm, { props: { today: TODAY, limits: LIMITS, ...props }, attachTo: document.body })
  return wrapper
}

// get() 找不到會直接 throw，test-utils 的回傳型別不含 exists()
function field(w: VueWrapper, label: string): Omit<DOMWrapper<HTMLInputElement>, 'exists'> {
  const lab = w.findAll('label').find((l) => l.text() === label)
  if (!lab) throw new Error(`找不到欄位 ${label}`)
  return w.get<HTMLInputElement>(`#${lab.attributes('for')}`)
}

function radio(w: VueWrapper, label: string) {
  const found = w.findAll('[role="radio"]').find((r) => r.text().includes(label))
  if (!found) throw new Error(`找不到假別 ${label}`)
  return found
}

function button(w: VueWrapper, label: string) {
  const found = w.findAll('button').find((b) => b.text().includes(label))
  if (!found) throw new Error(`找不到按鈕 ${label}`)
  return found
}

function makeFile(name: string, type: string, size = KB): File {
  const file = new File([''], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

async function pickFile(w: VueWrapper, file: File): Promise<void> {
  const input = w.get<HTMLInputElement>('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
}

type SubmitPayload = {
  leave_type: string
  start_date: string
  end_date: string
  reason: string
  files: File[]
}

function submitted(w: VueWrapper): SubmitPayload[] {
  return (w.emitted('submit') ?? []).map((args) => args[0] as SubmitPayload)
}

function fileNames(w: VueWrapper): string[] {
  return w.findAll('.lf-file__name').map((n) => n.text())
}

describe('LeaveForm', () => {
  it('LeaveForm emits payload with files', async () => {
    const w = mountForm()
    const pdf = makeFile('機票訂位確認.pdf', 'application/pdf', 240 * KB)
    await radio(w, '事假').trigger('click')
    await field(w, '開始日期').setValue('2026-10-05')
    await field(w, '結束日期').setValue('2026-10-06')
    await field(w, '事由（選填）').setValue('家庭旅遊')
    await pickFile(w, pdf)
    await button(w, '送出請假').trigger('click')

    expect(submitted(w)).toHaveLength(1)
    const payload = submitted(w)[0]!
    expect(payload.leave_type).toBe('personal')
    expect(payload.start_date).toBe('2026-10-05')
    expect(payload.end_date).toBe('2026-10-06')
    expect(payload.reason).toBe('家庭旅遊')
    expect(payload.files).toHaveLength(1)
    expect(payload.files[0]).toBe(pdf)
  })

  it('LeaveForm defaults to sick leave today with empty reason and no files', async () => {
    const w = mountForm()

    expect(radio(w, '病假').attributes('aria-checked')).toBe('true')
    expect(radio(w, '事假').attributes('aria-checked')).toBe('false')
    expect(radio(w, '其他').attributes('aria-checked')).toBe('false')
    expect(field(w, '開始日期').element.value).toBe(TODAY)
    expect(field(w, '結束日期').element.value).toBe(TODAY)

    await button(w, '送出請假').trigger('click')

    expect(submitted(w)).toEqual([
      { leave_type: 'sick', start_date: TODAY, end_date: TODAY, reason: '', files: [] },
    ])
  })

  it('LeaveForm offers the three leave types in order', () => {
    const w = mountForm()

    expect(w.findAll('[role="radio"] .m3-segment__label').map((r) => r.text())).toEqual(['病假', '事假', '其他'])
    expect(w.get('[role="radiogroup"]').attributes('aria-label')).toBe('假別')
  })

  it('LeaveForm date limits come from limits prop and block out of range dates on submit', async () => {
    const w = mountForm()

    expect(field(w, '開始日期').attributes('min')).toBe('2026-09-02')
    expect(field(w, '開始日期').attributes('max')).toBe('2026-12-01')
    expect(field(w, '結束日期').attributes('min')).toBe('2026-09-02')
    expect(field(w, '結束日期').attributes('max')).toBe('2026-12-01')
    expect(w.text()).toContain('可選 09/02～12/01')
    // 日期驗證只在送出時做
    await field(w, '開始日期').setValue('2026-12-05')
    expect(w.text()).not.toContain(RANGE_MESSAGE)

    await button(w, '送出請假').trigger('click')

    expect(w.text()).toContain(RANGE_MESSAGE)
    expect(field(w, '開始日期').attributes('aria-invalid')).toBe('true')
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('LeaveForm accepts the boundary dates of the allowed range', async () => {
    const w = mountForm()
    await field(w, '開始日期').setValue('2026-09-02')
    await field(w, '結束日期').setValue('2026-12-01')
    await button(w, '送出請假').trigger('click')

    expect(submitted(w)).toHaveLength(1)
    expect(submitted(w)[0]).toMatchObject({ start_date: '2026-09-02', end_date: '2026-12-01' })
  })

  it('LeaveForm flags only the end date when just the end is out of range', async () => {
    const w = mountForm()
    await field(w, '結束日期').setValue('2026-12-02')
    await button(w, '送出請假').trigger('click')

    expect(w.text()).toContain(RANGE_MESSAGE)
    expect(field(w, '開始日期').attributes('aria-invalid')).toBe('false')
    expect(field(w, '結束日期').attributes('aria-invalid')).toBe('true')
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('LeaveForm end follows start when start moves past end', async () => {
    const w = mountForm()
    await field(w, '結束日期').setValue('2026-10-03')
    expect(field(w, '結束日期').element.value).toBe('2026-10-03')

    await field(w, '開始日期').setValue('2026-10-08')
    await flushPromises()

    expect(field(w, '結束日期').element.value).toBe('2026-10-08')

    // 開始日往前改不動結束日
    await field(w, '開始日期').setValue('2026-10-05')
    await flushPromises()
    expect(field(w, '結束日期').element.value).toBe('2026-10-08')
  })

  it('LeaveForm rejects an end date earlier than the start date and clears the error on change', async () => {
    const w = mountForm()
    await field(w, '開始日期').setValue('2026-10-08')
    await field(w, '結束日期').setValue('2026-10-06')
    await button(w, '送出請假').trigger('click')

    expect(w.text()).toContain('結束日期不可早於開始日期')
    expect(field(w, '結束日期').attributes('aria-invalid')).toBe('true')
    expect(field(w, '開始日期').attributes('aria-invalid')).toBe('false')
    expect(w.emitted('submit')).toBeUndefined()

    // 任一日期再變更即清除錯誤
    await field(w, '結束日期').setValue('2026-10-09')
    expect(w.text()).not.toContain('結束日期不可早於開始日期')
    expect(field(w, '結束日期').attributes('aria-invalid')).toBe('false')

    await button(w, '送出請假').trigger('click')
    expect(submitted(w)).toHaveLength(1)
    expect(submitted(w)[0]).toMatchObject({ start_date: '2026-10-08', end_date: '2026-10-09' })
  })

  it('LeaveForm treats an emptied date as out of range', async () => {
    const w = mountForm()
    await field(w, '開始日期').setValue('')
    await button(w, '送出請假').trigger('click')

    expect(w.text()).toContain(RANGE_MESSAGE)
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('LeaveForm reason is trimmed, capped at 200 and counted', async () => {
    const w = mountForm()
    const reason = w.get('textarea')
    expect(reason.attributes('maxlength')).toBe('200')
    expect(w.get('.m3-tf__counter').text()).toBe('0/200')
    await reason.trigger('focus')
    expect(reason.attributes('placeholder')).toBe('例如：發燒看醫生')

    await field(w, '事由（選填）').setValue('  發燒看醫生  ')
    expect(w.get('.m3-tf__counter').text()).toBe('9/200')
    await button(w, '送出請假').trigger('click')
    expect(submitted(w)[0]!.reason).toBe('發燒看醫生')

    await field(w, '事由（選填）').setValue('   ')
    await button(w, '送出請假').trigger('click')
    expect(submitted(w)[1]!.reason).toBe('')
  })

  it('LeaveForm attachment validation rejects oversized and unsupported files', async () => {
    const w = mountForm()
    await pickFile(w, makeFile('診斷證明.pdf', 'application/pdf', 200 * KB))

    await pickFile(w, makeFile('photo.jpg', 'image/jpeg', 11 * MB))
    expect(w.get('[role="alert"]').text()).toContain('photo.jpg 超過 10 MB')
    expect(fileNames(w)).toEqual(['診斷證明.pdf'])

    await pickFile(w, makeFile('說明.txt', 'text/plain', KB))
    expect(w.get('[role="alert"]').text()).toContain('說明.txt 格式不支援')
    expect(w.get('[role="alert"]').text()).not.toContain('photo.jpg')
    expect(fileNames(w)).toEqual(['診斷證明.pdf'])

    // 被拒絕的檔案不會隨表單送出
    await button(w, '送出請假').trigger('click')
    expect(submitted(w)[0]!.files.map((f) => f.name)).toEqual(['診斷證明.pdf'])
  })

  it('LeaveForm accepts a file exactly at the size limit and clears the previous error', async () => {
    const w = mountForm()
    await pickFile(w, makeFile('photo.jpg', 'image/jpeg', 10 * MB + 1))
    expect(w.find('[role="alert"]').exists()).toBe(true)

    await pickFile(w, makeFile('exact.jpg', 'image/jpeg', 10 * MB))

    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(fileNames(w)).toEqual(['exact.jpg'])
  })

  it('LeaveForm accepts every supported attachment type', async () => {
    const w = mountForm({ limits: { ...LIMITS, leave_max_attachments: 5 } })
    for (const [name, type] of [
      ['a.jpg', 'image/jpeg'],
      ['b.png', 'image/png'],
      ['c.webp', 'image/webp'],
      ['d.heic', 'image/heic'],
      ['e.pdf', 'application/pdf'],
    ] as const) {
      await pickFile(w, makeFile(name, type))
    }

    expect(fileNames(w)).toEqual(['a.jpg', 'b.png', 'c.webp', 'd.heic', 'e.pdf'])
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('LeaveForm hides the add control once the attachment limit is reached', async () => {
    const w = mountForm()
    expect(w.find('input[type="file"]').exists()).toBe(true)
    expect(w.text()).toContain('最多 3 個，單檔 10 MB 以內（JPG、PNG、WEBP、HEIC、PDF）')
    expect(w.text()).toContain('0/3')

    await pickFile(w, makeFile('a.jpg', 'image/jpeg'))
    await pickFile(w, makeFile('b.png', 'image/png'))
    expect(w.text()).toContain('2/3')
    expect(w.find('input[type="file"]').exists()).toBe(true)
    await pickFile(w, makeFile('c.pdf', 'application/pdf'))

    expect(w.find('input[type="file"]').exists()).toBe(false)
    expect(w.text()).toContain('已達 3 個附件上限')
    expect(w.text()).not.toContain('單檔 10 MB 以內')
    expect(w.text()).toContain('3/3')
  })

  it('LeaveForm lists file name and size with a remove button and restores the add control', async () => {
    const w = mountForm()
    await pickFile(w, makeFile('IMG_2031.jpg', 'image/jpeg', 2 * MB + 400 * KB))
    await pickFile(w, makeFile('診斷證明.pdf', 'application/pdf', 240 * KB))
    await pickFile(w, makeFile('藥袋.heic', 'image/heic', 90))

    expect(w.findAll('.lf-file__size').map((s) => s.text())).toEqual(['2.4 MB', '240 KB', '1 KB'])
    expect(w.findAll('.lf-file .m3-icon').map((i) => i.text())).toEqual([
      'image',
      'close',
      'picture_as_pdf',
      'close',
      'image',
      'close',
    ])
    expect(w.find('input[type="file"]').exists()).toBe(false)

    await w.get('button[aria-label="移除 診斷證明.pdf"]').trigger('click')

    expect(fileNames(w)).toEqual(['IMG_2031.jpg', '藥袋.heic'])
    expect(w.find('input[type="file"]').exists()).toBe(true)
    await button(w, '送出請假').trigger('click')
    expect(submitted(w)[0]!.files.map((f) => f.name)).toEqual(['IMG_2031.jpg', '藥袋.heic'])
  })

  it('LeaveForm removing a file clears the attachment error', async () => {
    const w = mountForm()
    await pickFile(w, makeFile('a.jpg', 'image/jpeg'))
    await pickFile(w, makeFile('說明.txt', 'text/plain'))
    expect(w.find('[role="alert"]').exists()).toBe(true)

    await w.get('button[aria-label="移除 a.jpg"]').trigger('click')

    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(fileNames(w)).toEqual([])
  })

  it('LeaveForm file input accepts the supported types and resets so the same file can be chosen again', async () => {
    const w = mountForm()
    const input = w.get<HTMLInputElement>('input[type="file"]')
    expect(input.attributes('accept')).toBe('image/jpeg,image/png,image/webp,image/heic,application/pdf')
    expect(input.attributes('aria-label')).toBe('新增附件')

    const written: string[] = []
    Object.defineProperty(input.element, 'value', { get: () => '', set: (v: string) => written.push(v), configurable: true })
    await pickFile(w, makeFile('a.jpg', 'image/jpeg'))

    expect(written).toEqual([''])
  })

  it('LeaveForm follows configured limits', async () => {
    const w = mountForm({
      limits: { ...LIMITS, leave_past_days: 7, leave_future_days: 90, leave_max_attachments: 1, leave_max_attachment_mb: 5 },
    })

    expect(field(w, '開始日期').attributes('min')).toBe('2026-09-25')
    expect(field(w, '開始日期').attributes('max')).toBe('2026-12-31')
    expect(w.text()).toContain('最多 1 個，單檔 5 MB 以內')

    await pickFile(w, makeFile('IMG_2040.jpg', 'image/jpeg', 6 * MB))
    expect(w.get('[role="alert"]').text()).toContain('IMG_2040.jpg 超過 5 MB')
    expect(fileNames(w)).toEqual([])

    await pickFile(w, makeFile('ok.jpg', 'image/jpeg', 4 * MB))
    expect(w.find('input[type="file"]').exists()).toBe(false)
    expect(w.text()).toContain('已達 1 個附件上限')

    await field(w, '開始日期').setValue('2026-09-20')
    await button(w, '送出請假').trigger('click')
    expect(w.text()).toContain('請假日期需在今天前 7 天到後 90 天內')
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('LeaveForm cancel button emits cancel', async () => {
    const w = mountForm()
    await button(w, '取消').trigger('click')

    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('submit')).toBeUndefined()
  })

  it('LeaveForm submitting locks the form and blocks a second submit', async () => {
    const w = mountForm({ submitting: true })

    expect(w.get('.lf-lock').attributes('disabled')).toBeDefined()
    expect(button(w, '送出請假').attributes('aria-busy')).toBe('true')
    expect(button(w, '取消').attributes('disabled')).toBeDefined()
    expect(w.find('.m3-spinner').exists()).toBe(true)

    await button(w, '送出請假').trigger('click')
    await w.get('form').trigger('submit')

    expect(w.emitted('submit')).toBeUndefined()

    await w.setProps({ submitting: false })
    expect(w.get('.lf-lock').attributes('disabled')).toBeUndefined()
    expect(button(w, '送出請假').attributes('aria-busy')).toBeUndefined()
    expect(button(w, '取消').attributes('disabled')).toBeUndefined()
  })
})
