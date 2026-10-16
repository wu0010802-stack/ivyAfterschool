import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { Leave } from '@/api/leaves'
import { createApiMock, mountWithApp } from '@/test/helpers'
import LeaveCancelDialog from './LeaveCancelDialog.vue'

const CANCEL_URL = '/admin/leaves/l1/cancel'
const TODAY = '2026-10-02'

function leave(start_date: string, end_date: string, overrides: Partial<Leave> = {}): Leave {
  return {
    id: 'l1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', class_name: '中年級班' },
    leave_type: 'sick',
    leave_type_label: '病假',
    start_date,
    end_date,
    reason: '發燒',
    status: 'active',
    created_by_type: 'parent',
    created_by_name: '王大明',
    created_at: '2026-09-28T12:00:00Z',
    cancelled_at: null,
    cancelled_by_type: null,
    cancelled_by_name: null,
    attachments: [],
    ...overrides,
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountDialog(l: Leave, props: Record<string, unknown> = { today: TODAY }): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(LeaveCancelDialog, { props: { modelValue: true, leave: l, ...props } })
  await settle()
  return wrapper as VueWrapper
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

function radios(): DOMWrapper<Element>[] {
  return dialog().findAll('.el-radio')
}

function radio(label: string): DOMWrapper<Element> {
  const r = radios().find((x) => x.find('.lc-option__title').text() === label)
  if (!r) throw new Error(`找不到選項 ${label}`)
  return r
}

function footerButton(text: string): DOMWrapper<Element> {
  const btn = dialog()
    .findAll('.el-dialog__footer button')
    .find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕 ${text}`)
  return btn
}

async function submit(text = '取消請假'): Promise<void> {
  await footerButton(text).trigger('click')
  await settle()
}

function postBodies(): unknown[] {
  return mock.history.post.map((req) => JSON.parse(req.data as string))
}

describe('LeaveCancelDialog', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('LeaveCancelDialog future leave cancels whole leave', async () => {
    const l = leave('2026-10-05', '2026-10-06')
    const cancelled = { ...l, status: 'cancelled', cancelled_at: '2026-10-02T02:00:00Z' }
    mock.onPost(CANCEL_URL).reply(200, cancelled)
    const wrapper = await mountDialog(l)

    expect(dialog().find('.el-dialog__title').text()).toBe('取消請假')
    expect(dialog().text()).toContain('將取消整筆請假')
    expect(radios()).toHaveLength(0)
    await submit('取消請假')

    expect(postBodies()).toEqual([{ scope: 'remaining' }])
    expect(wrapper.emitted('cancelled')).toEqual([[cancelled]])
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
    expect(document.body.textContent).toContain('已取消請假')
  })

  it('LeaveCancelDialog started leave defaults to remaining', async () => {
    const l = leave('2026-09-30', '2026-10-04')
    mock.onPost(CANCEL_URL).reply(200, { ...l, end_date: '2026-10-01' })
    await mountDialog(l)

    expect(radios()).toHaveLength(2)
    const remaining = radio('取消今天起的請假（2026-10-02~2026-10-04）')
    expect(remaining.classes()).toContain('is-checked')
    expect(remaining.find('.lc-option__desc').text()).toBe(
      '今天起的出勤會恢復為預計到班；2026-09-30~2026-10-01 保留為請假',
    )
    expect(radio('整筆取消（2026-09-30~2026-10-04）').classes()).not.toContain('is-checked')
    await submit('取消請假')

    expect(postBodies()).toEqual([{ scope: 'remaining' }])
  })

  it('LeaveCancelDialog started leave can cancel all', async () => {
    const l = leave('2026-09-30', '2026-10-04')
    mock.onPost(CANCEL_URL).reply(200, { ...l, status: 'cancelled' })
    const wrapper = await mountDialog(l)

    const all = radio('整筆取消（2026-09-30~2026-10-04）')
    expect(all.find('.lc-option__desc').text()).toBe('已過去的日子也會改回，已登記到班或離班的紀錄不受影響')
    await all.find('input').setValue(true)
    await settle()
    expect(all.classes()).toContain('is-checked')
    await submit('整筆取消')

    expect(postBodies()).toEqual([{ scope: 'all' }])
    expect(wrapper.emitted('cancelled')).toHaveLength(1)
  })

  it('LeaveCancelDialog surfaces ended error', async () => {
    mock.onPost(CANCEL_URL).reply(409, {
      error: { code: 'leave_already_ended', message: '請假已結束，無法取消剩餘日子', details: null },
    })
    const wrapper = await mountDialog(leave('2026-09-30', '2026-10-04'))

    await submit('取消請假')

    expect(dialog().find('.el-alert--error').text()).toContain('請假已結束，無法取消剩餘日子')
    expect(document.body.textContent).toContain('請假已結束，無法取消剩餘日子')
    expect(wrapper.emitted('failed')).toEqual([['leave_already_ended']])
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    expect(wrapper.emitted('cancelled')).toBeUndefined()
    expect(document.body.querySelector('.el-dialog')).not.toBeNull()
  })

  it('LeaveCancelDialog surfaces ended error: not active', async () => {
    mock.onPost(CANCEL_URL).reply(409, {
      error: { code: 'leave_not_active', message: '這筆請假已取消', details: null },
    })
    const wrapper = await mountDialog(leave('2026-10-05', '2026-10-06'))

    await submit('取消請假')

    expect(dialog().find('.el-alert--error').text()).toContain('這筆請假已取消')
    expect(wrapper.emitted('failed')).toEqual([['leave_not_active']])
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('LeaveCancelDialog surfaces ended error: other errors do not emit failed', async () => {
    mock.onPost(CANCEL_URL).networkError()
    const wrapper = await mountDialog(leave('2026-10-05', '2026-10-06'))

    await submit('取消請假')

    expect(dialog().find('.el-alert--error').text()).toContain('網路連線異常，請稍後再試')
    expect(wrapper.emitted('failed')).toBeUndefined()
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('LeaveCancelDialog ended leave only allows cancel all', async () => {
    mock.onPost(CANCEL_URL).reply(200, { ...leave('2026-09-28', '2026-09-30'), status: 'cancelled' })
    await mountDialog(leave('2026-09-28', '2026-09-30'))

    expect(dialog().find('.el-dialog__title').text()).toBe('整筆取消請假')
    expect(dialog().text()).toContain(
      '已結束的請假只能整筆取消（事後更正）；期間內登記為請假的出勤會自動還原，已登記到班或離班的紀錄不受影響',
    )
    expect(radios()).toHaveLength(0)
    await submit('整筆取消')

    expect(postBodies()).toEqual([{ scope: 'all' }])
  })

  it('LeaveCancelDialog leave starting today has no options', async () => {
    mock.onPost(CANCEL_URL).reply(200, { ...leave('2026-10-02', '2026-10-04'), status: 'cancelled' })
    await mountDialog(leave('2026-10-02', '2026-10-04'))

    expect(dialog().text()).toContain('將取消整筆請假')
    expect(radios()).toHaveLength(0)
    await submit('取消請假')

    expect(postBodies()).toEqual([{ scope: 'remaining' }])
  })

  it('LeaveCancelDialog shows single day ranges', async () => {
    await mountDialog(leave('2026-10-01', '2026-10-03'))

    const text = dialog().text()
    expect(text).toContain('2026-10-01 保留為請假')
    expect(text).not.toContain('2026-10-01~2026-10-01')
  })

  it('LeaveCancelDialog shows single day ranges: summary period of one day', async () => {
    await mountDialog(leave('2026-10-05', '2026-10-05'))

    expect(dialog().find('.lc-summary__period').text()).toBe('2026-10-05')
  })

  it('LeaveCancelDialog shows summary with student, class and leave type', async () => {
    await mountDialog(leave('2026-10-05', '2026-10-06'))

    const summary = dialog().find('.lc-summary')
    expect(summary.text()).toContain('王小明（S11301・中年級班）')
    expect(summary.find('.el-tag').text()).toBe('病假')
    expect(summary.find('.el-tag').classes()).toContain('el-tag--warning')
    expect(summary.find('.lc-summary__period').text()).toBe('2026-10-05~2026-10-06')
    expect(dialog().find('.lc-notify').text()).toBe('取消後會通知班級負責老師')
    expect(footerButton('返回').exists()).toBe(true)
  })

  it('LeaveCancelDialog shows summary with student, class and leave type: unassigned class', async () => {
    const l = leave('2026-10-05', '2026-10-06', {
      student: { id: 's6', student_no: 'S11312', name: '王語晴', class_name: null },
      leave_type: 'personal',
      leave_type_label: '事假',
    })
    await mountDialog(l)

    expect(dialog().find('.lc-summary').text()).toContain('王語晴（S11312・未分班）')
  })

  it('LeaveCancelDialog defaults today to Taipei date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // UTC 2026-10-01 16:30 = 台北 2026-10-02 00:30
    vi.setSystemTime(new Date('2026-10-01T16:30:00Z'))
    await mountDialog(leave('2026-10-01', '2026-10-03'), {})

    expect(radio('取消今天起的請假（2026-10-02~2026-10-03）').classes()).toContain('is-checked')
  })

  it('LeaveCancelDialog forwards closed', async () => {
    const wrapper = await mountDialog(leave('2026-10-05', '2026-10-06'))

    wrapper.findComponent({ name: 'ElDialog' }).vm.$emit('closed')
    await settle()

    expect(wrapper.emitted('closed')).toHaveLength(1)
  })
})
