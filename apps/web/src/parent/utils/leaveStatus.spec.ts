import { describe, expect, it } from 'vitest'
import { leaveStatusPill } from './leaveStatus'

const TODAY = '2026-10-14'

describe('leaveStatusPill', () => {
  it('leaveStatusPill follows date order', () => {
    expect(leaveStatusPill({ status: 'active', start_date: '2026-10-10', end_date: '2026-10-13' }, TODAY)).toEqual({
      label: '已結束',
      tone: 'neutral',
    })
    expect(leaveStatusPill({ status: 'active', start_date: '2026-10-15', end_date: '2026-10-16' }, TODAY)).toEqual({
      label: '已排定',
      tone: 'info',
    })
    expect(leaveStatusPill({ status: 'active', start_date: '2026-10-14', end_date: '2026-10-14' }, TODAY)).toEqual({
      label: '請假中',
      tone: 'warning',
    })
  })

  it('leaveStatusPill cancelled wins', () => {
    expect(leaveStatusPill({ status: 'cancelled', start_date: '2026-10-14', end_date: '2026-10-14' }, TODAY)).toEqual({
      label: '已取消',
      tone: 'neutral',
    })
  })
})
