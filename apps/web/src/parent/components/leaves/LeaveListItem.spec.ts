import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { LeaveAttachment, ParentLeave } from '../../api/leaves'
import LeaveListItem from './LeaveListItem.vue'

const TODAY = '2026-10-02'

function attachments(count: number): LeaveAttachment[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    mime_type: 'image/jpeg',
    size_bytes: 2048,
    created_at: '2026-10-01T02:00:00Z',
    url: `https://x/a${i}.jpg`,
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
    reason: null,
    status: 'active',
    created_by_type: 'parent',
    created_at: '2026-09-28T02:00:00Z',
    cancelled_at: null,
    can_cancel: false,
    attachments: [],
    ...overrides,
  }
}

function mountItem(l: ParentLeave) {
  return mount(LeaveListItem, { props: { leave: l, today: TODAY } })
}

// 取消按鈕是整列主按鈕之外的另一個 button（主按鈕內的「已取消」狀態文字不算）
function cancelButton(w: ReturnType<typeof mountItem>) {
  return w.findAll('button:not(.leave-item__main)').find((b) => b.text().includes('取消'))
}

describe('LeaveListItem', () => {
  it('LeaveListItem future leave cancels whole', async () => {
    const l = leave({ can_cancel: true })
    const w = mountItem(l)

    expect(w.text()).toContain('10/05（一）～10/07（三）')
    expect(w.text()).toContain('已排定')
    const button = cancelButton(w)
    expect(button?.text()).toBe('取消請假')

    await button?.trigger('click')

    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('cancel')?.[0]).toEqual([l])
    expect(w.emitted('open')).toBeUndefined()
  })

  it('LeaveListItem ongoing leave cancels remaining', () => {
    const w = mountItem(leave({ leave_type: 'personal', leave_type_label: '事假', start_date: '2026-09-30', end_date: '2026-10-03', can_cancel: true }))

    expect(w.text()).toContain('請假中')
    expect(w.text()).toContain('取消剩餘日子')
    expect(w.text()).not.toContain('取消請假')
    expect(w.text()).not.toContain('已排定')
  })

  it('LeaveListItem no cancel when not allowed', () => {
    const cancelled = mountItem(leave({ status: 'cancelled', cancelled_at: '2026-10-01T02:00:00Z', can_cancel: false }))
    expect(cancelled.text()).toContain('已取消')
    expect(cancelButton(cancelled)).toBeUndefined()

    const ended = mountItem(leave({ start_date: '2026-09-28', end_date: '2026-10-01', can_cancel: false }))
    expect(ended.text()).toContain('已結束')
    expect(cancelButton(ended)).toBeUndefined()
  })

  it('LeaveListItem hides the cancel button whenever can_cancel is false even for a future leave', () => {
    const w = mountItem(leave({ can_cancel: false }))

    expect(w.text()).toContain('已排定')
    expect(w.findAll('button')).toHaveLength(1)
  })

  it('LeaveListItem single day and open', async () => {
    const l = leave({ start_date: '2026-10-02', end_date: '2026-10-02' })
    const w = mountItem(l)

    expect(w.get('.leave-item__period').text()).toBe('10/02（五）')
    expect(w.text()).not.toContain('～')

    await w.get('.leave-item__main').trigger('click')

    expect(w.emitted('open')).toHaveLength(1)
    expect(w.emitted('open')?.[0]).toEqual([l])
    expect(w.emitted('cancel')).toBeUndefined()
  })

  it('LeaveListItem staff cancelled ended leave shows cancelled', () => {
    const w = mountItem(
      leave({
        status: 'cancelled',
        start_date: '2026-09-20',
        end_date: '2026-09-22',
        cancelled_at: '2026-10-01T02:00:00Z',
        created_by_type: 'staff',
        can_cancel: false,
      }),
    )

    expect(w.text()).toContain('已取消')
    expect(w.text()).not.toContain('已結束')
    expect(cancelButton(w)).toBeUndefined()
  })

  it('LeaveListItem cancelled status wins over a future or ongoing date', () => {
    const future = mountItem(leave({ status: 'cancelled', cancelled_at: '2026-10-01T02:00:00Z' }))
    const ongoing = mountItem(leave({ status: 'cancelled', start_date: '2026-09-30', end_date: '2026-10-03' }))

    for (const w of [future, ongoing]) {
      expect(w.get('.status-pill').text()).toBe('已取消')
      expect(w.classes()).toContain('is-cancelled')
    }
  })

  it('LeaveListItem classifies a leave on its boundary days', () => {
    const status = (start: string, end: string) => mountItem(leave({ start_date: start, end_date: end })).get('.status-pill').text()

    // 今天開始、今天結束都算請假中；昨天結束才是已結束；明天開始才是已排定
    expect(status('2026-10-02', '2026-10-02')).toBe('請假中')
    expect(status('2026-10-01', '2026-10-02')).toBe('請假中')
    expect(status('2026-10-02', '2026-10-04')).toBe('請假中')
    expect(status('2026-09-30', '2026-10-01')).toBe('已結束')
    expect(status('2026-10-03', '2026-10-03')).toBe('已排定')
  })

  it('LeaveListItem cancels the whole leave when it starts today', () => {
    const w = mountItem(leave({ start_date: '2026-10-02', end_date: '2026-10-04', can_cancel: true }))

    expect(w.text()).toContain('請假中')
    expect(cancelButton(w)?.text()).toBe('取消請假')
  })

  it('LeaveListItem pill tone follows the computed status', () => {
    const tone = (l: ParentLeave) => mountItem(l).get('.status-pill').classes()
    expect(tone(leave())).toContain('status-pill--info')
    expect(tone(leave({ start_date: '2026-09-30', end_date: '2026-10-03' }))).toContain('status-pill--warning')
    expect(tone(leave({ start_date: '2026-09-28', end_date: '2026-10-01' }))).toContain('status-pill--neutral')
    expect(tone(leave({ status: 'cancelled' }))).toContain('status-pill--neutral')
  })

  it('LeaveListItem keeps open and cancel as sibling controls inside the li', () => {
    const w = mountItem(leave({ can_cancel: true }))

    expect(w.element.tagName).toBe('LI')
    const main = w.get('.leave-item__main')
    expect(main.element.tagName).toBe('BUTTON')
    expect(main.attributes('type')).toBe('button')
    const cancel = cancelButton(w)
    expect(cancel).toBeDefined()
    expect(main.element.contains(cancel!.element)).toBe(false)
    expect(main.text()).not.toContain('取消')
    // 主按鈕的可及名稱由內容組成
    expect(main.text()).toContain('病假')
    expect(main.text()).toContain('10/05（一）～10/07（三）')
    expect(main.text()).toContain('已排定')
  })

  it('LeaveListItem shows the first line of the reason and the attachment count', () => {
    const w = mountItem(leave({ reason: '發燒看醫生\n第二行不顯示', attachments: attachments(2) }))

    expect(w.get('.leave-item__reason').text()).toBe('發燒看醫生')
    expect(w.text()).not.toContain('第二行不顯示')
    const attach = w.get('.leave-item__attach')
    expect(attach.text()).toContain('attach_file')
    expect(attach.text()).toContain('2')
    expect(attach.get('.visually-hidden').text()).toBe('個附件')
  })

  it('LeaveListItem has no meta line without reason and attachments', () => {
    const w = mountItem(leave({ reason: null, attachments: [] }))
    expect(w.find('.leave-item__meta').exists()).toBe(false)
    expect(w.find('.leave-item__attach').exists()).toBe(false)

    const blank = mountItem(leave({ reason: '  ', attachments: [] }))
    expect(blank.find('.leave-item__meta').exists()).toBe(false)

    // 只有附件沒有事由：仍顯示附件數
    const onlyFiles = mountItem(leave({ reason: null, attachments: attachments(1) }))
    expect(onlyFiles.get('.leave-item__attach').text()).toContain('1')
    expect(onlyFiles.get('.leave-item__reason').text()).toBe('')

    // 只有事由沒有附件
    const onlyReason = mountItem(leave({ reason: '回診', attachments: [] }))
    expect(onlyReason.get('.leave-item__reason').text()).toBe('回診')
    expect(onlyReason.find('.leave-item__attach').exists()).toBe(false)
  })

  it('LeaveListItem shows the leave type label with its icon', () => {
    const icon = (type: ParentLeave['leave_type'], label: string) => {
      const w = mountItem(leave({ leave_type: type, leave_type_label: label }))
      expect(w.get('.leave-item__type').text()).toBe(label)
      return w.get('.leave-item__icon').text()
    }

    expect(icon('sick', '病假')).toBe('sick')
    expect(icon('personal', '事假')).toBe('event_busy')
    expect(icon('other', '其他')).toBe('event_note')
  })
})
