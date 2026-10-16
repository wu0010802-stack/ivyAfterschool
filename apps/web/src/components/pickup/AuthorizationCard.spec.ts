import type { VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { StaffAuthorization } from '@/api/pickupAuthorizations'
import { mountWithApp } from '@/test/helpers'
import cardSource from './AuthorizationCard.vue?raw'
import AuthorizationCard from './AuthorizationCard.vue'

function makeAuthorization(overrides: Partial<StaffAuthorization> = {}): StaffAuthorization {
  return {
    id: 'pa1',
    student: { id: 's1', student_no: 'S11301', name: '王小明', grade_level: 3, class_id: 'c3', class_name: '低年級A班' },
    student_id: 's1',
    service_date: '2026-10-02',
    pickup_person_id: null,
    proxy_name: '陳阿姨',
    proxy_phone: '0912-000-456',
    code_last4: '4821',
    status: 'active',
    effective_status: 'active',
    verified_at: null,
    verification_method: null,
    created_at: '2026-10-02T00:00:00Z',
    photo_url: null,
    code_attempts: 2,
    locked: false,
    verified_by_name: null,
    ...overrides,
  }
}

async function mountCard(authorization: StaffAuthorization, canVerify = true): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(AuthorizationCard, { props: { authorization, canVerify } })
  return wrapper as VueWrapper
}

function verifyButton(wrapper: VueWrapper) {
  return wrapper.findAll('button').find((b) => b.text() === '核驗')
}

describe('AuthorizationCard', () => {
  it('AuthorizationCard renders proxy info and attempts', async () => {
    const wrapper = await mountCard(makeAuthorization())

    const text = wrapper.text()
    expect(text).toContain('陳阿姨')
    expect(text).toContain('0912-000-456')
    expect(text).toContain('末四碼 4821')
    expect(text).toContain('有效')
    expect(text).toContain('已錯誤 2 次')
    expect(text).not.toContain('已鎖定')
    expect(text).toContain('王小明')
    expect(text).toContain('低年級A班')
    expect(wrapper.find('.el-tag--success').text()).toBe('有效')
    expect(wrapper.find('.el-tag--warning').text()).toBe('已錯誤 2 次')
    expect(wrapper.classes()).not.toContain('is-inactive')
    expect(wrapper.classes()).not.toContain('is-locked')

    // 沒有錯誤時不顯示錯誤次數
    const clean = await mountCard(makeAuthorization({ code_attempts: 0 }))
    expect(clean.text()).not.toContain('已錯誤')
  })

  it('AuthorizationCard shows locked and completed summary', async () => {
    const locked = await mountCard(makeAuthorization({ locked: true, code_attempts: 5 }))
    expect(locked.text()).toContain('已鎖定')
    expect(locked.text()).not.toContain('已錯誤')
    expect(locked.find('.el-tag--danger').text()).toBe('已鎖定')
    expect(locked.classes()).toContain('is-locked')
    expect(locked.classes()).not.toContain('is-inactive')

    const completed = await mountCard(
      makeAuthorization({
        status: 'completed',
        effective_status: 'completed',
        verification_method: 'visual_match',
        verified_by_name: '陳老師',
        verified_at: '2026-10-02T09:30:00Z',
        code_attempts: 3,
      }),
    )
    expect(completed.text()).toContain('已接送')
    expect(completed.text()).toContain('目視核對・陳老師・17:30')
    // 非 active 不顯示錯誤次數 / 鎖定
    expect(completed.text()).not.toContain('已錯誤')
    expect(completed.classes()).toContain('is-inactive')
    expect(completed.classes()).not.toContain('is-locked')

    // 已鎖定但已取消：淡灰、不標鎖定框線
    const cancelled = await mountCard(
      makeAuthorization({ status: 'cancelled', effective_status: 'cancelled', locked: true, code_attempts: 5 }),
    )
    expect(cancelled.text()).toContain('已取消')
    expect(cancelled.text()).not.toContain('已鎖定')
    expect(cancelled.classes()).toContain('is-inactive')
    expect(cancelled.classes()).not.toContain('is-locked')

    const expired = await mountCard(makeAuthorization({ effective_status: 'expired' }))
    expect(expired.text()).toContain('已過期')
    expect(expired.text()).not.toContain('已錯誤')
  })

  it('AuthorizationCard verify button conditions', async () => {
    const active = await mountCard(makeAuthorization())
    expect(verifyButton(active)?.exists()).toBe(true)
    await verifyButton(active)?.trigger('click')
    expect((active.emitted('verify') as [StaffAuthorization][])[0]?.[0].id).toBe('pa1')

    // 已鎖定仍可核驗（dialog 內走強制完成）
    const locked = await mountCard(makeAuthorization({ locked: true, code_attempts: 5 }))
    expect(verifyButton(locked)?.exists()).toBe(true)

    const completed = await mountCard(
      makeAuthorization({ status: 'completed', effective_status: 'completed', verification_method: 'code', verified_at: '2026-10-02T09:30:00Z' }),
    )
    expect(verifyButton(completed)).toBeUndefined()

    const reader = await mountCard(makeAuthorization(), false)
    expect(verifyButton(reader)).toBeUndefined()
    expect(reader.findAll('button')).toHaveLength(0)
  })

  it('AuthorizationCard photo fallback', async () => {
    const noPhoto = await mountCard(makeAuthorization({ photo_url: null }))
    expect(noPhoto.find('[data-test=monogram]').text()).toBe('姨')
    expect(noPhoto.find('img').exists()).toBe(false)

    const withPhoto = await mountCard(makeAuthorization({ photo_url: 'https://storage/p.jpg' }))
    expect(withPhoto.find('img').attributes('src')).toBe('https://storage/p.jpg')
    expect(withPhoto.find('img').attributes('alt')).toBe('陳阿姨 的照片')
    expect(withPhoto.find('[data-test=monogram]').exists()).toBe(false)

    // 圖片載入失敗 → 退回 monogram
    await withPhoto.find('img').trigger('error')
    expect(withPhoto.find('img').exists()).toBe(false)
    expect(withPhoto.find('[data-test=monogram]').text()).toBe('姨')
  })

  it('AuthorizationCard keeps verify button touch height', async () => {
    // happy-dom 不計算版面：以原始碼斷言「核驗」鈕 ≥ 44px 的規則
    expect(cardSource).toMatch(/\.acard2__verify[^{]*{[^}]*min-height:\s*44px/)
    const wrapper = await mountCard(makeAuthorization())
    expect(wrapper.element.tagName).toBe('ARTICLE')
  })
})
