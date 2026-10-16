import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParentLimits } from '../../api/config'
import type { LeaveAttachment, ParentLeave } from '../../api/leaves'
import LeaveDetailSheet from './LeaveDetailSheet.vue'
import source from './LeaveDetailSheet.vue?raw'

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

let mounted: VueWrapper[] = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  document.body.innerHTML = ''
  document.body.style.overflow = ''
})

function attachments(count: number): LeaveAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    mime_type: 'image/jpeg',
    size_bytes: 2 * KB,
    created_at: '2026-10-01T02:00:00Z',
    url: `https://files.example.test/a${i}.jpg`,
  }))
}

function leave(overrides: Partial<ParentLeave> = {}): ParentLeave {
  return {
    id: 'l1',
    student_id: 's1',
    leave_type: 'sick',
    leave_type_label: '病假',
    start_date: '2026-10-05',
    end_date: '2026-10-07',
    reason: '發燒看醫生',
    status: 'active',
    created_by_type: 'parent',
    created_at: '2026-09-28T02:00:00Z',
    cancelled_at: null,
    can_cancel: false,
    attachments: [],
    ...overrides,
  }
}

type Props = {
  modelValue?: boolean
  leave: ParentLeave | null
  studentName?: string
  today?: string
  limits?: ParentLimits
  uploading?: boolean
}

function mountSheet(props: Props): VueWrapper {
  const wrapper = mount(LeaveDetailSheet, {
    attachTo: document.body,
    props: { modelValue: true, studentName: '王小明', today: TODAY, limits: LIMITS, ...props },
  })
  mounted.push(wrapper)
  return wrapper
}

function dialogEl(): HTMLElement {
  const el = document.body.querySelector<HTMLElement>('[role="dialog"]')
  if (!el) throw new Error('找不到 dialog')
  return el
}

function dialog(): DOMWrapper<HTMLElement> {
  return new DOMWrapper(dialogEl())
}

function dialogText(): string {
  return dialog().text()
}

function footerButton(): DOMWrapper<Element> | null {
  const el = dialogEl().querySelector('.sheet__footer button')
  return el ? new DOMWrapper(el) : null
}

function makeFile(name: string, type: string, size = KB): File {
  const file = new File([''], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

async function pickFile(file: File): Promise<void> {
  const el = dialogEl().querySelector<HTMLInputElement>('input[type="file"]')
  if (!el) throw new Error('找不到新增附件 input')
  Object.defineProperty(el, 'files', { value: [file], configurable: true })
  await new DOMWrapper(el).trigger('change')
}

function fileInput(): HTMLInputElement | null {
  return dialogEl().querySelector<HTMLInputElement>('input[type="file"]')
}

function rows(): [string, string][] {
  return Array.from(dialogEl().querySelectorAll('.lds-kv__row')).map((row) => [
    row.querySelector('dt')?.textContent?.trim() ?? '',
    row.querySelector('dd')?.textContent?.trim() ?? '',
  ])
}

/** ?raw 原始碼 <style> 中某選擇器（行首，可縮排）的樣式區塊內容 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm').exec(source)
  expect(match, `找不到 ${selector} 區塊`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('LeaveDetailSheet', () => {
  it('LeaveDetailSheet shows details', () => {
    mountSheet({
      leave: leave({
        leave_type: 'personal',
        leave_type_label: '事假',
        reason: null,
        created_by_type: 'staff',
      }),
    })

    const text = dialogText()
    expect(text).toContain('王小明')
    expect(text).toContain('事假')
    expect(text).toContain('共 3 天')
    expect(text).toContain('未填寫')
    expect(text).toContain('安親班代為登記')
    expect(dialog().get('h2').text()).toBe('請假詳情')
  })

  it('LeaveDetailSheet lists the detail rows with period and creation time in Taipei time', () => {
    mountSheet({ leave: leave({ created_at: '2026-09-28T17:30:00Z' }) })

    expect(dialog().get('.lds-summary__period').text()).toBe('10/05（一）～10/07（三） · 共 3 天')
    expect(rows()).toEqual([
      ['小孩', '王小明'],
      ['事由', '發燒看醫生'],
      ['申請者', '家長申請'],
      // 17:30Z 是台北隔天 01:30
      ['申請時間', '2026/09/29 01:30'],
    ])
    expect(dialogEl().querySelector('.lds-kv__v.is-empty')).toBeNull()
  })

  it('LeaveDetailSheet counts calendar days inclusive and handles a single day', () => {
    mountSheet({ leave: leave({ start_date: '2026-10-12', end_date: '2026-10-12' }) })
    expect(dialog().get('.lds-summary__period').text()).toBe('10/12（一） · 共 1 天')
    mounted[0]!.unmount()
    mounted = []
    document.body.innerHTML = ''

    // 跨月：9/29 ~ 10/02 共 4 天
    mountSheet({ leave: leave({ start_date: '2026-09-29', end_date: '2026-10-02' }) })
    expect(dialog().get('.lds-summary__period').text()).toBe('09/29（二）～10/02（五） · 共 4 天')
  })

  it('LeaveDetailSheet shows the cancelled time only when the leave was cancelled and fades the summary', () => {
    mountSheet({
      leave: leave({
        status: 'cancelled',
        cancelled_at: '2026-10-01T02:00:00Z',
        created_by_type: 'staff',
        start_date: '2026-09-20',
        end_date: '2026-09-22',
      }),
    })

    expect(rows().map(([k]) => k)).toEqual(['小孩', '事由', '申請者', '申請時間', '取消時間'])
    expect(rows()[4]).toEqual(['取消時間', '2026/10/01 10:00'])
    expect(dialog().get('.lds-summary .status-pill').text()).toBe('已取消')
    expect(dialog().get('.lds').classes()).toContain('is-cancelled')
  })

  it('LeaveDetailSheet pill follows the same status rules as the list row', () => {
    const pill = (overrides: Partial<ParentLeave>) => {
      mountSheet({ leave: leave(overrides) })
      const el = dialog().get('.lds-summary .status-pill')
      const result = [el.text(), ...el.classes().filter((c) => c.startsWith('status-pill--'))]
      mounted.pop()?.unmount()
      document.body.innerHTML = ''
      return result
    }

    expect(pill({})).toEqual(['已排定', 'status-pill--info'])
    expect(pill({ start_date: '2026-09-30', end_date: '2026-10-03' })).toEqual(['請假中', 'status-pill--warning'])
    expect(pill({ start_date: '2026-10-02', end_date: '2026-10-02' })).toEqual(['請假中', 'status-pill--warning'])
    expect(pill({ start_date: '2026-09-28', end_date: '2026-10-01' })).toEqual(['已結束', 'status-pill--neutral'])
    // cancelled 優先於日期判斷
    expect(pill({ status: 'cancelled', start_date: '2026-09-20', end_date: '2026-09-22' })).toEqual([
      '已取消',
      'status-pill--neutral',
    ])
  })

  it('LeaveDetailSheet shows the leave type icon', () => {
    const icon = (type: ParentLeave['leave_type'], label: string) => {
      mountSheet({ leave: leave({ leave_type: type, leave_type_label: label }) })
      const result = dialog().get('.lds-summary .leave-item__icon').text()
      mounted.pop()?.unmount()
      document.body.innerHTML = ''
      return result
    }

    expect(icon('sick', '病假')).toBe('sick')
    expect(icon('personal', '事假')).toBe('event_busy')
    expect(icon('other', '其他')).toBe('event_note')
  })

  it('LeaveDetailSheet keeps line breaks in the reason', () => {
    mountSheet({ leave: leave({ reason: '發燒看醫生\n醫生說要多休息兩天' }) })

    expect(rows()[1]).toEqual(['事由', '發燒看醫生\n醫生說要多休息兩天'])
    expect(rule('.lds-kv__v')).toMatch(/white-space:\s*pre-line/)
  })

  it('LeaveDetailSheet whole cancel for a leave that has not started', async () => {
    const l = leave({ can_cancel: true })
    const w = mountSheet({ leave: l })

    expect(footerButton()?.text()).toBe('取消請假')
    expect(dialogText()).not.toContain('取消剩餘日子')
    expect(dialogEl().querySelector('.lds-cancel__note')).toBeNull()

    await footerButton()?.trigger('click')

    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('cancel')?.[0]).toEqual([l])
  })

  it('LeaveDetailSheet cancels the whole leave when it starts today', () => {
    mountSheet({ leave: leave({ start_date: '2026-10-02', end_date: '2026-10-04', can_cancel: true }) })

    expect(footerButton()?.text()).toBe('取消請假')
    expect(dialogEl().querySelector('.lds-cancel__note')).toBeNull()
  })

  it('LeaveDetailSheet remaining cancel explanation', async () => {
    const l = leave({ start_date: '2026-09-30', end_date: '2026-10-03', can_cancel: true })
    const w = mountSheet({ leave: l })

    expect(dialogText()).toContain('取消剩餘日子')
    expect(dialogText()).toContain('將取消今天（10/02）起的請假，之前的日子仍保留為請假')
    expect(dialogEl().querySelector('.lds-cancel__note .m3-icon')?.textContent).toBe('info')

    await footerButton()?.trigger('click')

    expect(w.emitted('cancel')).toHaveLength(1)
    expect((w.emitted('cancel')?.[0]?.[0] as ParentLeave).id).toBe(l.id)
  })

  it('LeaveDetailSheet explanation uses the given today', () => {
    mountSheet({ today: '2026-11-09', leave: leave({ start_date: '2026-11-05', end_date: '2026-11-12', can_cancel: true }) })

    expect(dialogText()).toContain('將取消今天（11/09）起的請假')
  })

  it('LeaveDetailSheet has no footer when the leave cannot be cancelled', () => {
    mountSheet({ leave: leave({ can_cancel: false }) })

    expect(dialogEl().querySelector('.sheet__footer')).toBeNull()
    expect(dialogText()).not.toContain('取消請假')
    expect(dialogText()).not.toContain('取消剩餘日子')
  })

  it('LeaveDetailSheet attachments editable rule', async () => {
    const two = leave({ attachments: attachments(2) })
    const w = mountSheet({ leave: two })

    expect(fileInput()).not.toBeNull()
    expect(dialogText()).toContain('還可新增 1 個')
    await pickFile(makeFile('藥袋.png', 'image/png', 500 * KB))
    expect(w.emitted('upload')).toHaveLength(1)
    expect((w.emitted('upload')?.[0]?.[0] as File).name).toBe('藥袋.png')
    mounted.pop()?.unmount()
    document.body.innerHTML = ''

    // 數量上限交給 limits：同一筆在上限 2 時已滿
    mountSheet({ leave: two, limits: { ...LIMITS, leave_max_attachments: 2 } })
    expect(fileInput()).toBeNull()
    expect(dialogText()).toContain('已達 2 個附件上限')
    mounted.pop()?.unmount()
    document.body.innerHTML = ''

    // 已結束但仍 active：可補附件、沒有取消按鈕
    mountSheet({ leave: leave({ end_date: '2026-09-22', start_date: '2026-09-22', can_cancel: false, attachments: [] }) })
    expect(fileInput()).not.toBeNull()
    expect(footerButton()).toBeNull()
    mounted.pop()?.unmount()
    document.body.innerHTML = ''

    // 已取消：唯讀
    mountSheet({ leave: leave({ status: 'cancelled', cancelled_at: '2026-10-01T02:00:00Z', attachments: attachments(1) }) })
    expect(fileInput()).toBeNull()
    expect(dialogText()).not.toContain('已達')
    expect(footerButton()).toBeNull()
  })

  it('LeaveDetailSheet cancelled leave without attachments says there are none', () => {
    mountSheet({ leave: leave({ status: 'cancelled', cancelled_at: '2026-10-01T02:00:00Z', attachments: [] }) })

    expect(dialogText()).toContain('沒有附件')
    expect(fileInput()).toBeNull()
  })

  it('LeaveDetailSheet passes limits and uploading through to the attachment list', async () => {
    const w = mountSheet({
      leave: leave({ attachments: attachments(1) }),
      limits: { ...LIMITS, leave_max_attachments: 5, leave_max_attachment_mb: 2 },
    })

    expect(dialogText()).toContain('還可新增 4 個，單檔 2 MB 以內')
    await pickFile(makeFile('big.jpg', 'image/jpeg', 3 * MB))
    expect(dialog().get('[role="alert"]').text()).toContain('big.jpg 超過 2 MB')
    expect(w.emitted('upload')).toBeUndefined()

    await w.setProps({ uploading: true })
    const add = dialogEl().querySelector('.att-tile--add')
    expect(add?.getAttribute('aria-busy')).toBe('true')
    expect(fileInput()?.disabled).toBe(true)
  })

  it('LeaveDetailSheet shows an attachment whose url expired as unavailable', () => {
    mountSheet({
      leave: leave({ attachments: [{ ...attachments(1)[0]!, url: null }] }),
    })

    expect(dialogEl().querySelector('a[href]')).toBeNull()
    expect(dialogText()).toContain('暫時無法開啟')
  })

  it('LeaveDetailSheet emits update:modelValue false from the close button', async () => {
    const w = mountSheet({ leave: leave() })

    await new DOMWrapper(dialogEl().querySelector('button[aria-label="關閉"]')!).trigger('click')

    expect(w.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('LeaveDetailSheet renders nothing while closed and nothing but the title without a leave', async () => {
    const w = mountSheet({ modelValue: false, leave: leave({ can_cancel: true }) })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    await w.setProps({ modelValue: true, leave: null })

    expect(dialog().get('h2').text()).toBe('請假詳情')
    expect(dialogEl().querySelector('.lds')).toBeNull()
    expect(dialogEl().querySelector('.sheet__footer')).toBeNull()
  })
})
