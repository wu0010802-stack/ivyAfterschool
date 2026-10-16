import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { AttendanceRow } from '@/api/attendance'
import { mountWithApp } from '@/test/helpers'
import cardSource from './AttendanceStudentCard.vue?raw'
import AttendanceStudentCard from './AttendanceStudentCard.vue'

function makeRow(overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    id: 'a1',
    student_id: 's1',
    student_no: 'S11301',
    student_name: '王小明',
    grade_level: 3,
    class_id: 'c1',
    class_name: '中年級班',
    service_date: '2026-10-02',
    status: 'expected',
    check_in_at: null,
    check_in_source: null,
    check_out_at: null,
    check_out_source: null,
    leave: null,
    note: null,
    updated_at: '2026-10-02T05:00:00Z',
    ...overrides,
  }
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountCard(row: AttendanceRow, props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(AttendanceStudentCard, {
    props: { row, canOperate: true, canAmend: false, ...props },
  })
  return wrapper as VueWrapper
}

function actionTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test=att-actions] button').map((b) => b.text())
}

function actionButton(wrapper: VueWrapper, text: string) {
  const btn = wrapper.findAll('[data-test=att-actions] button').find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  return btn
}

function moreButton(wrapper: VueWrapper) {
  return wrapper.find('button[aria-label="更多操作"]')
}

describe('AttendanceStudentCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('AttendanceStudentCard shows actions per status', async () => {
    const expected = await mountCard(makeRow({ status: 'expected' }))
    expect(actionTexts(expected)).toEqual(['到班', '缺席'])

    const absent = await mountCard(makeRow({ status: 'absent' }))
    expect(actionTexts(absent)).toEqual(['到班'])

    const present = await mountCard(
      makeRow({ status: 'present', check_in_at: '2026-10-02T06:05:00Z', check_in_source: 'manual' }),
    )
    expect(actionTexts(present)).toEqual(['離班'])

    const left = await mountCard(
      makeRow({
        status: 'left',
        check_in_at: '2026-10-02T06:05:00Z',
        check_in_source: 'manual',
        check_out_at: '2026-10-02T09:30:00Z',
        check_out_source: 'manual',
      }),
    )
    expect(left.findAll('button')).toHaveLength(0)

    const leave = await mountCard(
      makeRow({
        status: 'leave',
        leave: { id: 'l1', leave_type: 'sick', leave_type_label: '病假', start_date: '2026-10-02', end_date: '2026-10-02' },
      }),
    )
    expect(leave.findAll('button')).toHaveLength(0)

    // 沒有 operate（或非今天）時一律不顯示操作按鈕
    const readonly = await mountCard(makeRow({ status: 'expected' }), { canOperate: false })
    expect(readonly.findAll('button')).toHaveLength(0)
  })

  it('AttendanceStudentCard emits operations with row', async () => {
    const wrapper = await mountCard(makeRow({ status: 'expected' }))

    await actionButton(wrapper, '到班').trigger('click')
    const checkIn = wrapper.emitted('check-in') as [AttendanceRow][] | undefined
    expect(checkIn?.[0]?.[0].student_id).toBe('s1')

    await actionButton(wrapper, '缺席').trigger('click')
    expect(wrapper.emitted('mark-absent')).toHaveLength(1)
    expect((wrapper.emitted('mark-absent') as [AttendanceRow][])[0]?.[0].student_id).toBe('s1')

    const present = await mountCard(makeRow({ status: 'present', check_in_at: '2026-10-02T06:05:00Z', check_in_source: 'manual' }))
    await actionButton(present, '離班').trigger('click')
    expect((present.emitted('check-out') as [AttendanceRow][])[0]?.[0].student_id).toBe('s1')
    expect(present.emitted('check-in')).toBeUndefined()
  })

  it('AttendanceStudentCard shows times and sources', async () => {
    const present = await mountCard(
      makeRow({ status: 'present', check_in_at: '2026-10-02T06:05:00Z', check_in_source: 'nfc' }),
    )
    expect(present.text()).toContain('到班 14:05')
    expect(present.text()).toContain('刷卡')

    const left = await mountCard(
      makeRow({
        status: 'left',
        check_in_at: '2026-10-02T06:05:00Z',
        check_in_source: 'manual',
        check_out_at: '2026-10-02T09:30:00Z',
        check_out_source: 'pickup',
      }),
    )
    expect(left.text()).toContain('到班 14:05')
    expect(left.text()).toContain('離班 17:30')
    expect(left.text()).toContain('接送完成')
    // 手動來源不加小標
    expect(left.text()).not.toContain('手動')
    expect(left.text()).toContain('S11301・3 年級・中年級班')
  })

  it('AttendanceStudentCard shows leave info', async () => {
    const wrapper = await mountCard(
      makeRow({
        status: 'leave',
        leave: { id: 'l1', leave_type: 'sick', leave_type_label: '病假', start_date: '2026-10-02', end_date: '2026-10-03' },
      }),
    )

    expect(wrapper.text()).toContain('病假 2026-10-02~2026-10-03')
    expect(wrapper.find('.el-tag').text()).toBe('請假')
  })

  it('AttendanceStudentCard amend menu requires permission and real row', async () => {
    const present = { status: 'present' as const, check_in_at: '2026-10-02T06:05:00Z', check_in_source: 'manual' as const }

    const allowed = await mountCard(makeRow({ id: 'a1', ...present }), { canAmend: true })
    expect(moreButton(allowed).exists()).toBe(true)
    await moreButton(allowed).trigger('click')
    await settle()
    const item = Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')).find(
      (el) => el.textContent?.trim() === '改判',
    )
    expect(item?.textContent?.trim()).toBe('改判')
    item?.click()
    await settle()
    expect((allowed.emitted('amend') as [AttendanceRow][] | undefined)?.[0]?.[0].id).toBe('a1')
    allowed.unmount()
    document.body.innerHTML = ''

    const virtual = await mountCard(makeRow({ id: null, ...present }), { canAmend: true })
    expect(moreButton(virtual).exists()).toBe(false)
    expect(document.body.textContent).not.toContain('改判')

    const leave = await mountCard(
      makeRow({
        id: 'a2',
        status: 'leave',
        leave: { id: 'l1', leave_type: 'sick', leave_type_label: '病假', start_date: '2026-10-02', end_date: '2026-10-02' },
      }),
      { canAmend: true },
    )
    expect(moreButton(leave).exists()).toBe(false)

    const noPermission = await mountCard(makeRow({ id: 'a1', ...present }), { canAmend: false })
    expect(moreButton(noPermission).exists()).toBe(false)
    expect(document.body.textContent).not.toContain('改判')
  })

  it('AttendanceStudentCard busy disables buttons and selectable rules', async () => {
    const busy = await mountCard(makeRow({ status: 'expected' }), { busy: true })
    expect(actionButton(busy, '到班').attributes('disabled')).toBeDefined()
    expect(actionButton(busy, '缺席').attributes('disabled')).toBeDefined()
    await actionButton(busy, '到班').trigger('click')
    expect(busy.emitted('check-in')).toBeUndefined()

    const idle = await mountCard(makeRow({ status: 'expected' }))
    expect(actionButton(idle, '到班').attributes('disabled')).toBeUndefined()

    const present = await mountCard(
      makeRow({ student_id: 's2', status: 'present', check_in_at: '2026-10-02T06:05:00Z', check_in_source: 'manual' }),
      { selectable: true },
    )
    await present.trigger('click')
    expect(present.emitted('toggle-select')).toBeUndefined()
    expect(present.find('.acard__mask').exists()).toBe(true)

    const expected = await mountCard(makeRow({ status: 'expected' }), { selectable: true })
    // 選取模式隱藏卡片按鈕
    expect(expected.findAll('button')).toHaveLength(0)
    await expected.trigger('click')
    expect(expected.emitted('toggle-select')).toHaveLength(1)
    expect((expected.emitted('toggle-select') as [AttendanceRow][])[0]?.[0].student_id).toBe('s1')
    expect(expected.attributes('role')).toBe('checkbox')
    expect(expected.attributes('aria-checked')).toBe('false')

    await expected.setProps({ selected: true })
    expect(expected.attributes('aria-checked')).toBe('true')
    expect(expected.classes()).toContain('is-selected')
  })

  it('AttendanceStudentCard shows note tooltip trigger', async () => {
    const note = '下午看牙醫，16:00 才到'
    const wrapper = await mountCard(makeRow({ status: 'absent', note }))

    const trigger = wrapper.find('[data-test=att-note]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('備註')
    expect(trigger.text()).not.toContain('💬')
    expect(wrapper.text()).not.toContain(note)

    await trigger.trigger('mouseenter')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await settle()
    expect(document.body.textContent).toContain(note)

    const noNote = await mountCard(makeRow({ status: 'absent', note: null }))
    expect(noNote.find('[data-test=att-note]').exists()).toBe(false)
  })

  it('AttendanceStudentCard keeps touch targets at least 44px', () => {
    // happy-dom 不計算版面：以原始碼斷言卡片按鈕與 ⋮ 的觸控尺寸規則（平板 ≥ 44px）
    expect(cardSource).toMatch(/\.acard__actions[^{]*\.el-button[^{]*\{[^}]*min-height:\s*44px/)
    expect(cardSource).toMatch(/\.acard__more\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/)
  })
})
