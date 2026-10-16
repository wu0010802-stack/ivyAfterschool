import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import type { RosterStudent } from '@/api/pickupRequests'
import { useStudentPosStatus, type PosStudentStatusResult } from '@/composables/useStudentPosStatus'
import { mountWithApp } from '@/test/helpers'
import cardSource from './StudentCard.vue?raw'
import StudentCard from './StudentCard.vue'

function makeStudent(overrides: Partial<RosterStudent> = {}): RosterStudent {
  return {
    student_id: 's1',
    student_no: 'S11301',
    name: '王小明',
    grade_level: 1,
    attendance_status: 'present',
    check_in_at: '2026-10-02T06:20:00Z',
    check_out_at: null,
    leave_type: null,
    homework_status: 'in_progress',
    ready_eta: '17:30',
    open_request: null,
    active_authorization_count: 0,
    ...overrides,
  }
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountCard(
  student: RosterStudent,
  props: { staging?: boolean; canOperate?: boolean; status?: PosStudentStatusResult } = {},
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const { status = useStudentPosStatus(student), staging = false, canOperate = true } = props
  const { wrapper, router } = await mountWithApp(StudentCard, {
    props: { student, status, staging, canOperate },
  })
  return { wrapper: wrapper as VueWrapper, router }
}

function moreButton(wrapper: VueWrapper) {
  return wrapper.find('button[aria-label="王小明 的選項"]')
}

async function openMenu(wrapper: VueWrapper): Promise<HTMLElement[]> {
  await moreButton(wrapper).trigger('click')
  await settle()
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item'))
}

describe('StudentCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('StudentCard shows status homework and eta', async () => {
    const { wrapper } = await mountCard(makeStudent())

    expect(wrapper.text()).toContain('王小明')
    expect(wrapper.text()).toContain('S11301')
    expect(wrapper.text()).toContain('在班等待')
    expect(wrapper.text()).toContain('進行中')
    expect(wrapper.text()).toContain('17:30 可接送')
    expect(wrapper.classes()).toContain('st-waiting')
    expect(wrapper.classes()).toContain('tone-success')
    expect(wrapper.text()).not.toContain('代理')

    // 沒有 ready_eta 時不顯示「可接送」；沒有作業狀態時不顯示作業列
    const noEta = await mountCard(makeStudent({ ready_eta: null }))
    expect(noEta.wrapper.text()).not.toContain('可接送')
    const noHomework = await mountCard(makeStudent({ homework_status: null, ready_eta: null }))
    expect(noHomework.wrapper.text()).not.toContain('進行中')
  })

  it('StudentCard emits quick dispatch only for dispatchable states', async () => {
    const waiting = await mountCard(makeStudent())
    expect(waiting.wrapper.classes()).toContain('is-tappable')
    await waiting.wrapper.trigger('click')
    expect(waiting.wrapper.emitted('quick-dispatch')).toHaveLength(1)
    expect((waiting.wrapper.emitted('quick-dispatch') as [RosterStudent][])[0]?.[0].student_id).toBe('s1')

    const notArrived = await mountCard(makeStudent({ attendance_status: 'expected', check_in_at: null }))
    expect(notArrived.wrapper.text()).toContain('尚未到班')
    await notArrived.wrapper.trigger('click')
    expect(notArrived.wrapper.emitted('quick-dispatch')).toHaveLength(1)

    const pickedUp = await mountCard(makeStudent({ attendance_status: 'left', check_out_at: '2026-10-02T09:30:00Z' }))
    expect(pickedUp.wrapper.text()).toContain('已離班')
    expect(pickedUp.wrapper.classes()).not.toContain('is-tappable')
    expect(pickedUp.wrapper.attributes('aria-disabled')).toBe('true')
    await pickedUp.wrapper.trigger('click')
    expect(pickedUp.wrapper.emitted('quick-dispatch')).toBeUndefined()

    const staging = await mountCard(makeStudent(), { staging: true })
    expect(staging.wrapper.text()).toContain('建立中…')
    await staging.wrapper.trigger('click')
    expect(staging.wrapper.emitted('quick-dispatch')).toBeUndefined()

    const reader = await mountCard(makeStudent(), { canOperate: false })
    await reader.wrapper.trigger('click')
    expect(reader.wrapper.emitted('quick-dispatch')).toBeUndefined()
    expect(reader.wrapper.classes()).not.toContain('is-tappable')

    // 鍵盤 Enter / 空白鍵同樣可發起
    const keyboard = await mountCard(makeStudent())
    await keyboard.wrapper.trigger('keydown', { key: 'Enter' })
    await keyboard.wrapper.trigger('keydown', { key: ' ' })
    expect(keyboard.wrapper.emitted('quick-dispatch')).toHaveLength(2)
  })

  it('StudentCard focuses existing request', async () => {
    const requested = makeStudent({
      open_request: { id: 'r1', status: 'pending', expected_arrival_at: '17:30', needs_reply: true },
    })
    const { wrapper } = await mountCard(requested)
    expect(wrapper.text()).toContain('接送中')
    expect(wrapper.text()).toContain('待回覆')
    expect(wrapper.text()).not.toContain('等待確認')
    expect(wrapper.text()).toContain('預計 17:30 到')
    expect(wrapper.find('.scard__req').classes()).toContain('is-danger')
    await wrapper.trigger('click')
    expect(wrapper.emitted('focus-request')?.[0]).toEqual(['r1'])
    expect(wrapper.emitted('quick-dispatch')).toBeUndefined()

    const reader = await mountCard(requested, { canOperate: false })
    await reader.wrapper.trigger('click')
    expect(reader.wrapper.emitted('focus-request')?.[0]).toEqual(['r1'])

    const pending = await mountCard(
      makeStudent({ open_request: { id: 'r2', status: 'pending', expected_arrival_at: null, needs_reply: false } }),
    )
    expect(pending.wrapper.text()).toContain('等待確認')
    expect(pending.wrapper.text()).not.toContain('待回覆')
    expect(pending.wrapper.text()).not.toContain('預計')

    const acknowledged = await mountCard(
      makeStudent({ open_request: { id: 'r3', status: 'acknowledged', expected_arrival_at: '17:40', needs_reply: false } }),
    )
    expect(acknowledged.wrapper.text()).toContain('已確認')
    expect(acknowledged.wrapper.text()).toContain('預計 17:40 到')

    // 家長已到：tag 已寫「家長已到」，小字只在 needs_reply 時補「待回覆」
    const arrived = await mountCard(
      makeStudent({ open_request: { id: 'r4', status: 'arrived', expected_arrival_at: '17:30', needs_reply: false } }),
    )
    expect(arrived.wrapper.text()).toContain('家長已到')
    expect(arrived.wrapper.text()).not.toContain('待回覆')
    expect(arrived.wrapper.text()).not.toContain('預計')
    // tag 已寫家長已到：不需回覆時沒有任何請求小字（也不會變成「已確認」）
    expect(arrived.wrapper.find('.scard__req').exists()).toBe(false)
    expect(arrived.wrapper.text()).not.toContain('已確認')
    expect(arrived.wrapper.classes()).toContain('st-arrived')
    await arrived.wrapper.trigger('click')
    expect(arrived.wrapper.emitted('focus-request')?.[0]).toEqual(['r4'])

    const arrivedNeedsReply = await mountCard(
      makeStudent({ open_request: { id: 'r5', status: 'arrived', expected_arrival_at: null, needs_reply: true } }),
    )
    expect(arrivedNeedsReply.wrapper.text()).toContain('待回覆')
  })

  it('StudentCard menu offers create and authorization link', async () => {
    const { wrapper, router } = await mountCard(makeStudent({ active_authorization_count: 1 }))
    expect(wrapper.text()).toContain('代理 1')
    expect(wrapper.text()).not.toContain('🪪')

    const items = await openMenu(wrapper)
    expect(items.map((el) => el.textContent?.trim())).toEqual(['代建接送請求…', '查看代理授權'])

    items.find((el) => el.textContent?.includes('查看代理授權'))?.click()
    await settle()
    expect(router.currentRoute.value.path).toBe('/pickup/authorizations')
    expect(router.currentRoute.value.query.student_id).toBe('s1')
    expect(wrapper.emitted('quick-dispatch')).toBeUndefined()
  })

  it('StudentCard menu emits create request and shows left note', async () => {
    const { wrapper } = await mountCard(makeStudent())
    const items = await openMenu(wrapper)
    expect(items.map((el) => el.textContent?.trim())).toEqual(['代建接送請求…'])
    items[0]?.click()
    await settle()
    expect((wrapper.emitted('create-request') as [RosterStudent][])[0]?.[0].student_id).toBe('s1')
    expect(wrapper.emitted('quick-dispatch')).toBeUndefined()
    wrapper.unmount()
    document.body.innerHTML = ''

    const pickedUp = await mountCard(makeStudent({ attendance_status: 'left', check_out_at: '2026-10-02T09:30:00Z' }))
    const leftItems = await openMenu(pickedUp.wrapper)
    expect(leftItems.map((el) => el.textContent?.trim())).toEqual(['今天已離班'])
    expect(leftItems[0]?.classList.contains('is-disabled')).toBe(true)
    pickedUp.wrapper.unmount()
    document.body.innerHTML = ''

    // 請假且沒有代理授權：沒有任何選單項目 → 不顯示 ⋮
    const onLeave = await mountCard(makeStudent({ attendance_status: 'leave', leave_type: 'sick' }))
    expect(moreButton(onLeave.wrapper).exists()).toBe(false)

    // 倒數中：選單停用（不可再代建）
    const staging = await mountCard(makeStudent({ active_authorization_count: 1 }), { staging: true })
    expect(moreButton(staging.wrapper).exists()).toBe(true)
    expect(staging.wrapper.find('.el-dropdown').classes()).toContain('is-disabled')
  })

  it('StudentCard ignores keyboard on menu button', async () => {
    // ⋮ 的 Enter / 空白鍵只開選單：冒泡到卡片時不可同時發起代建或定位請求
    const waiting = await mountCard(makeStudent({ active_authorization_count: 1 }))
    await moreButton(waiting.wrapper).trigger('keydown', { key: 'Enter' })
    await moreButton(waiting.wrapper).trigger('keydown', { key: ' ' })
    await settle()
    expect(waiting.wrapper.emitted('quick-dispatch')).toBeUndefined()

    // 卡片本身的 Enter / 空白鍵照常發起
    await waiting.wrapper.trigger('keydown', { key: 'Enter' })
    await waiting.wrapper.trigger('keydown', { key: ' ' })
    expect(waiting.wrapper.emitted('quick-dispatch')).toHaveLength(2)
    waiting.wrapper.unmount()
    document.body.innerHTML = ''

    const requested = await mountCard(
      makeStudent({
        active_authorization_count: 1,
        open_request: { id: 'r1', status: 'pending', expected_arrival_at: null, needs_reply: false },
      }),
    )
    await moreButton(requested.wrapper).trigger('keydown', { key: 'Enter' })
    await moreButton(requested.wrapper).trigger('keydown', { key: ' ' })
    await settle()
    expect(requested.wrapper.emitted('focus-request')).toBeUndefined()
    await requested.wrapper.trigger('keydown', { key: 'Enter' })
    expect(requested.wrapper.emitted('focus-request')?.[0]).toEqual(['r1'])
  })

  it('StudentCard hides menu for readers', async () => {
    const { wrapper } = await mountCard(makeStudent({ active_authorization_count: 2 }), { canOperate: false })
    expect(moreButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('.el-dropdown').exists()).toBe(false)
    expect(wrapper.text()).toContain('代理 2')
  })

  it('StudentCard shows leave type label from code', async () => {
    const sick = await mountCard(makeStudent({ attendance_status: 'leave', leave_type: 'sick', check_in_at: null }))
    expect(sick.wrapper.text()).toContain('請假（病假）')
    expect(sick.wrapper.classes()).toContain('st-on_leave')

    const personal = await mountCard(makeStudent({ attendance_status: 'leave', leave_type: 'personal', check_in_at: null }))
    expect(personal.wrapper.text()).toContain('請假（事假）')

    const unknown = await mountCard(makeStudent({ attendance_status: 'leave', leave_type: null, check_in_at: null }))
    expect(unknown.wrapper.text()).toContain('請假')
    expect(unknown.wrapper.text()).not.toContain('請假（')

    const absent = await mountCard(makeStudent({ attendance_status: 'absent', check_in_at: null }))
    expect(absent.wrapper.text()).toContain('缺席')
  })

  it('StudentCard keeps touch target sizes', async () => {
    // happy-dom 不計算版面：以原始碼斷言 ⋮ 44×44 的規則
    expect(cardSource).toMatch(/\.scard__more\s*{[^}]*width:\s*44px/)
    expect(cardSource).toMatch(/\.scard__more\s*{[^}]*height:\s*44px/)
    const { wrapper } = await mountCard(makeStudent())
    expect(wrapper.attributes('role')).toBe('button')
    expect(wrapper.attributes('aria-label')).toBe('王小明，在班等待')
  })
})
