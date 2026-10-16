import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import {
  URGENCY_CRITICAL_MIN,
  URGENCY_WARNING_MIN,
  etaRelativeText,
  formatWaited,
  monogramOf,
  urgencyLevel,
  useNowClock,
  waitedMinutes,
} from './useDismissalUrgency'

const at = (iso: string): number => Date.parse(iso)

describe('useDismissalUrgency', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('useDismissalUrgency waited minutes only for arrived', () => {
    vi.setSystemTime(at('2026-10-02T09:10:00Z'))
    const now = Date.now()

    expect(waitedMinutes({ status: 'arrived', arrived_at: '2026-10-02T09:01:30Z' }, now)).toBe(8)
    expect(waitedMinutes({ status: 'pending', arrived_at: null }, now)).toBeNull()
    expect(waitedMinutes({ status: 'acknowledged', arrived_at: '2026-10-02T09:01:30Z' }, now)).toBeNull()
    expect(waitedMinutes({ status: 'completed', arrived_at: '2026-10-02T09:01:30Z' }, now)).toBeNull()
    expect(waitedMinutes({ status: 'arrived', arrived_at: null }, now)).toBeNull()
    expect(waitedMinutes({ status: 'arrived', arrived_at: 'not-a-date' }, now)).toBeNull()
    // 剛到（不滿一分）與時鐘略早於 arrived_at 都是 0
    expect(waitedMinutes({ status: 'arrived', arrived_at: '2026-10-02T09:09:40Z' }, now)).toBe(0)
    expect(waitedMinutes({ status: 'arrived', arrived_at: '2026-10-02T09:10:30Z' }, now)).toBe(0)
  })

  it('useDismissalUrgency urgency thresholds', () => {
    expect(URGENCY_WARNING_MIN).toBe(3)
    expect(URGENCY_CRITICAL_MIN).toBe(8)
    expect(urgencyLevel(0)).toBe('normal')
    expect(urgencyLevel(2)).toBe('normal')
    expect(urgencyLevel(3)).toBe('warning')
    expect(urgencyLevel(7)).toBe('warning')
    expect(urgencyLevel(8)).toBe('critical')
    expect(urgencyLevel(120)).toBe('critical')
    expect(urgencyLevel(null)).toBe('normal')
  })

  it('useDismissalUrgency formats waited and eta text', () => {
    expect(formatWaited(null)).toBe('')
    expect(formatWaited(0)).toBe('剛到')
    expect(formatWaited(5)).toBe('已等 5 分')
    expect(formatWaited(59)).toBe('已等 59 分')
    expect(formatWaited(60)).toBe('已等 1 小時 0 分')
    expect(formatWaited(65)).toBe('已等 1 小時 5 分')

    const now = at('2026-10-02T09:00:00Z') // 台北 17:00
    expect(etaRelativeText('17:20', now)).toBe('約 20 分後')
    expect(etaRelativeText('16:50', now)).toBe('已過 10 分')
    expect(etaRelativeText('17:00', now)).toBe('現在')
    expect(etaRelativeText(null, now)).toBe('')
  })

  it('useDismissalUrgency eta text treats within one minute as now and uses seconds', () => {
    // 台北 17:00:40：17:01 還差 20 秒、16:59 已過 1 分 40 秒（四捨五入 2 分）
    const now = at('2026-10-02T09:00:40Z')

    expect(etaRelativeText('17:01', now)).toBe('現在')
    expect(etaRelativeText('17:00', now)).toBe('現在')
    expect(etaRelativeText('17:02', now)).toBe('約 1 分後')
    expect(etaRelativeText('16:59', now)).toBe('已過 2 分')
  })

  it('useDismissalUrgency eta text uses taipei time not local time', () => {
    // UTC 16:30 已是台北隔天 00:30，ETA 00:40 是同一天的 10 分後
    const now = at('2026-10-02T16:30:00Z')

    expect(etaRelativeText('00:40', now)).toBe('約 10 分後')
  })

  it('useDismissalUrgency eta text ignores malformed time', () => {
    expect(etaRelativeText('25:99', at('2026-10-02T09:00:00Z'))).toBe('')
    expect(etaRelativeText('abc', at('2026-10-02T09:00:00Z'))).toBe('')
  })

  it('useDismissalUrgency monogram and clock', () => {
    expect(monogramOf('王小明')).toBe('明')
    expect(monogramOf('')).toBe('?')
    expect(monogramOf('   ')).toBe('?')
    expect(monogramOf(null)).toBe('?')
    expect(monogramOf(undefined)).toBe('?')
    expect(monogramOf(' 林小美 ')).toBe('美')

    vi.setSystemTime(at('2026-10-02T09:00:00Z'))
    const start = Date.now()
    const scope = effectScope()
    const clock = scope.run(() => useNowClock(30000))!
    expect(clock.now.value).toBe(start)

    vi.advanceTimersByTime(30_000)
    expect(clock.now.value).toBe(start + 30_000)

    scope.stop()
    vi.advanceTimersByTime(60_000)
    expect(clock.now.value).toBe(start + 30_000)
  })

  it('useDismissalUrgency clock default interval is thirty seconds', () => {
    vi.setSystemTime(at('2026-10-02T09:00:00Z'))
    const start = Date.now()
    const scope = effectScope()
    const clock = scope.run(() => useNowClock())!

    vi.advanceTimersByTime(29_999)
    expect(clock.now.value).toBe(start)
    vi.advanceTimersByTime(1)
    expect(clock.now.value).toBe(start + 30_000)

    scope.stop()
  })
})
