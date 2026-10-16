import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { ParentAuthorization } from '../../api/pickupAuthorizations'
import AuthorizationListItem from './AuthorizationListItem.vue'
import source from './AuthorizationListItem.vue?raw'

function authorization(overrides: Partial<ParentAuthorization> = {}): ParentAuthorization {
  return {
    id: 'a1',
    student_id: 's1',
    service_date: '2026-10-03',
    pickup_person_id: null,
    proxy_name: '陳叔叔',
    proxy_phone: '0922000456',
    code_last4: '8213',
    status: 'active',
    effective_status: 'active',
    verified_at: null,
    verification_method: null,
    created_at: '2026-10-01T02:00:00Z',
    ...overrides,
  }
}

function mountItem(a: ParentAuthorization) {
  return mount(AuthorizationListItem, { props: { authorization: a } })
}

type Wrapper = ReturnType<typeof mountItem>

function button(w: Wrapper, label: string) {
  return w.findAll('button').find((b) => b.text().includes(label))
}

/** ?raw 原始碼 <style> 中，選擇器清單含指定選擇器的所有樣式區塊內容 */
function rulesOf(selector: string): string[] {
  const css = source.slice(source.indexOf('>', source.indexOf('<style')) + 1).replace(/\/\*[\s\S]*?\*\//g, '')
  return Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g))
    .filter((m) => (m[1] ?? '').split(',').some((s) => s.trim() === selector))
    .map((m) => m[2] ?? '')
}

describe('AuthorizationListItem', () => {
  it('AuthorizationListItem active shows actions', async () => {
    const a = authorization()
    const wrapper = mountItem(a)

    expect(wrapper.text()).toContain('陳叔叔')
    expect(wrapper.text()).toContain('10/03（六）')
    expect(wrapper.text()).toContain('0922000456')
    expect(wrapper.get('.auth__meta').text()).toBe('10/03（六） · 0922000456')
    expect(wrapper.text()).toContain('接送碼末四碼 8213')
    expect(wrapper.get('.auth__code').text()).toBe('8213')
    expect(wrapper.get('.status-pill').text()).toBe('有效')
    expect(wrapper.text()).not.toContain('已完成交接')

    await button(wrapper, '重新產生接送碼')!.trigger('click')
    expect(wrapper.emitted('regenerate')).toHaveLength(1)
    expect(wrapper.emitted('regenerate')![0]![0]).toEqual(a)
    expect(wrapper.emitted('cancel')).toBeUndefined()

    await button(wrapper, '取消授權')!.trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    expect(wrapper.emitted('cancel')![0]![0]).toEqual(a)
    expect(wrapper.emitted('regenerate')).toHaveLength(1)
  })

  it('AuthorizationListItem expired hides actions', () => {
    const wrapper = mountItem(authorization({ status: 'active', effective_status: 'expired', service_date: '2026-10-01' }))

    expect(wrapper.get('.status-pill').text()).toBe('已過期')
    expect(wrapper.text()).toContain('已過期')
    expect(button(wrapper, '取消授權')).toBeUndefined()
    expect(button(wrapper, '重新產生接送碼')).toBeUndefined()
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.find('.auth__actions').exists()).toBe(false)
    // 末四碼仍顯示（家長對帳用）
    expect(wrapper.text()).toContain('接送碼末四碼 8213')
    expect(wrapper.classes()).not.toContain('is-active')
  })

  it('AuthorizationListItem completed shows verified time', () => {
    const wrapper = mountItem(
      authorization({
        status: 'completed',
        effective_status: 'completed',
        verified_at: '2026-10-03T09:35:00Z',
        verification_method: 'code',
      }),
    )

    expect(wrapper.text()).toContain('17:35 已完成交接')
    expect(wrapper.get('.auth__verified').text()).toBe('17:35 已完成交接')
    expect(wrapper.get('.status-pill').text()).toBe('已接送')
    expect(wrapper.findAll('button')).toHaveLength(0)
    // 不顯示核驗方式
    expect(wrapper.text()).not.toContain('code')
    expect(wrapper.text()).not.toContain('強制')
  })

  it('AuthorizationListItem cancelled shows status only', () => {
    const wrapper = mountItem(authorization({ status: 'cancelled', effective_status: 'cancelled' }))

    expect(wrapper.get('.status-pill').text()).toBe('已取消')
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.text()).not.toContain('已完成交接')
    expect(wrapper.classes()).not.toContain('is-active')
  })

  it('AuthorizationListItem pill tone follows FRONTEND-005', () => {
    const cases: [ParentAuthorization['effective_status'], string][] = [
      ['active', 'success'],
      ['completed', 'info'],
      ['cancelled', 'info'],
      ['expired', 'info'],
    ]
    for (const [effective, tone] of cases) {
      const wrapper = mountItem(authorization({ effective_status: effective }))
      expect(wrapper.get('.status-pill').classes(), effective).toContain(`status-pill--${tone}`)
    }
  })

  it('AuthorizationListItem is a list row with decorative icons', () => {
    const wrapper = mountItem(authorization({ effective_status: 'completed', status: 'completed', verified_at: '2026-10-03T09:35:00Z' }))

    expect(wrapper.element.tagName).toBe('LI')
    expect(wrapper.classes()).toContain('auth')
    const icons = wrapper.findAll('.auth__line .m3-icon')
    expect(icons.map((i) => i.text())).toEqual(['pin', 'how_to_reg'])
    expect(icons.every((i) => i.attributes('aria-hidden') === 'true')).toBe(true)
    expect(wrapper.get('.auth__name').text()).toBe('陳叔叔')
    expect(wrapper.get('.auth__name').classes()).toContain('m3-title-medium')
  })

  it('AuthorizationListItem action buttons are text buttons with icons', () => {
    const wrapper = mountItem(authorization())

    const regenerate = button(wrapper, '重新產生接送碼')!
    const cancel = button(wrapper, '取消授權')!
    expect(regenerate.classes()).toContain('m3-button--text')
    expect(cancel.classes()).toContain('m3-button--text')
    expect(regenerate.get('.m3-icon').text()).toBe('autorenew')
    expect(cancel.get('.m3-icon').text()).toBe('block')
    expect(cancel.classes()).toContain('auth__cancel')
    expect(wrapper.classes()).toContain('is-active')
    // 操作列靠右
    expect(rulesOf('.auth__actions').join(' ')).toMatch(/justify-content:\s*flex-end/)
  })

  it('AuthorizationListItem keeps the pill visible next to a long name', () => {
    const wrapper = mountItem(authorization({ proxy_name: '歐陽陳美玲阿姨（外婆的妹妹，平日週一到週五下午接送）' }))

    expect(wrapper.get('.auth__name').text()).toBe('歐陽陳美玲阿姨（外婆的妹妹，平日週一到週五下午接送）')
    expect(wrapper.get('.status-pill').text()).toBe('有效')
    const name = rulesOf('.auth__name').join(' ')
    expect(name).toMatch(/text-overflow:\s*ellipsis/)
    expect(name).toMatch(/white-space:\s*nowrap/)
    expect(name).toMatch(/min-width:\s*0/)
    expect(rulesOf('.auth__pill').join(' ')).toMatch(/flex:\s*none/)
  })

  it('AuthorizationListItem style follows the design decisions', () => {
    // 列 padding 16px、列間 1px outline-variant 分隔線由列自己畫；非 active 的姓名改 on-surface-variant；末四碼 500 字重
    expect(rulesOf('.auth').join(' ')).toMatch(/padding:\s*16px 16px 12px/)
    expect(rulesOf('.auth + .auth').join(' ')).toContain('border-top: 1px solid var(--m3-outline-variant)')
    expect(rulesOf('.auth:not(.is-active) .auth__name').join(' ')).toContain('color: var(--m3-on-surface-variant)')
    const code = rulesOf('.auth__code').join(' ')
    expect(code).toMatch(/font-weight:\s*500/)
    expect(code).toMatch(/font-variant-numeric:\s*tabular-nums/)
    expect(rulesOf('.auth__cancel').join(' ')).toContain('color: var(--m3-error)')
    const style = source.slice(source.indexOf('<style'))
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
