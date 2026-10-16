import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { DashboardToday } from '@/api/dashboard'
import { adminHttp } from '@/api/http'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { createApiMock, mountWithApp } from '@/test/helpers'
import DashboardView from './DashboardView.vue'
import dashboardViewSource from './DashboardView.vue?raw'

const URL = '/admin/dashboard/today'
const ALL_PERMS = [
  'dashboard:read',
  'attendance:read',
  'pickup:read',
  'homework:read',
  'leaves:read',
  'students:read',
]

type DashboardOverrides = Partial<Omit<DashboardToday, 'attendance' | 'pickup' | 'homework'>> & {
  attendance?: Partial<DashboardToday['attendance']>
  pickup?: Partial<DashboardToday['pickup']>
  homework?: Partial<DashboardToday['homework']>
}

/** 應到 80 = 已到 70（在班 60 + 已離班 10）+ 未到 4 + 缺席 6；作業以已到班的 70 位計算 */
function dashboard(overrides: DashboardOverrides = {}): DashboardToday {
  return {
    date: '2026-10-07',
    is_service_day: true,
    recent_leaves: [
      {
        id: 'l1',
        student_id: 's1',
        student_name: '王小明',
        class_name: '低年級A班',
        leave_type_label: '病假',
        start_date: '2026-10-08',
        end_date: '2026-10-08',
        created_by_type: 'parent',
        created_at: '2026-10-06T23:45:00Z',
      },
    ],
    ...overrides,
    attendance: {
      expected_total: 80,
      arrived: 70,
      present: 60,
      left: 10,
      not_arrived: 4,
      leave: 3,
      absent: 6,
      ...overrides.attendance,
    },
    pickup: { open: 3, needs_reply: 1, arrived: 0, completed: 12, ...overrides.pickup },
    homework: {
      total: 70,
      done: 40,
      in_progress: 20,
      not_started: 10,
      completion_rate: 57.1,
      ...overrides.homework,
    },
  }
}

const Stub = { render: () => null }
const ROUTES: RouteRecordRaw[] = [
  { path: '/', component: Stub, meta: { title: '今日儀表板' } },
  { path: '/attendance', component: Stub, meta: { title: '今日出勤' } },
  { path: '/pickup', component: Stub, meta: { title: '接送' } },
  { path: '/homework', component: Stub, meta: { title: '作業進度' } },
  { path: '/leaves', component: Stub, meta: { title: '請假' } },
  { path: '/students', component: Stub, meta: { title: '學生工作台' } },
]

let mock: MockAdapter
let hidden = false

function setHidden(value: boolean): void {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

/** 推進 fake timers（setInterval / setTimeout / Date）後清 promise */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

async function mountView(permissions: string[] = ALL_PERMS) {
  const mounted = await mountWithApp(DashboardView, {
    routes: ROUTES,
    initialRoute: '/',
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'director01',
          display_name: '張主任',
          role: { id: 'r-director', code: 'director', name: '主任' },
          permissions,
          must_change_password: false,
        },
      },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  return mounted
}

function getCount(): number {
  return mock.history.get.filter((c) => c.url === URL).length
}

function card(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const found = wrapper.findAll('.stat-card').find((c) => c.find('.stat-card__label').text() === label)
  if (!found) throw new Error(`找不到卡片「${label}」`)
  return found
}

function cardValue(wrapper: VueWrapper, label: string): string {
  return card(wrapper, label).find('.stat-card__value').text()
}

function refreshButton(wrapper: VueWrapper): DOMWrapper<Element> {
  const btn = wrapper.findAll('button').find((b) => b.text() === '重新整理')
  if (!btn) throw new Error('找不到「重新整理」')
  return btn
}

describe('DashboardView', () => {
  beforeEach(() => {
    hidden = false
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date('2026-10-07T03:00:00Z'))
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    delete (document as { hidden?: boolean }).hidden
    document.body.innerHTML = ''
  })

  it('DashboardView renders attendance pickup and homework', async () => {
    mock.onGet(URL).reply(200, dashboard())
    const { wrapper } = await mountView()

    expect(wrapper.find('h1').text()).toBe('今日儀表板')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe('10/07（三）')
    expect(cardValue(wrapper, '應到')).toBe('80')
    expect(card(wrapper, '應到').text()).toContain('不含請假')
    expect(cardValue(wrapper, '已到')).toBe('70')
    expect(card(wrapper, '已到').text()).toContain('在班 60・已離班 10')
    expect(cardValue(wrapper, '未到')).toBe('4')
    expect(cardValue(wrapper, '請假')).toBe('3')
    expect(cardValue(wrapper, '缺席')).toBe('6')
    expect(cardValue(wrapper, '進行中')).toBe('3')
    expect(cardValue(wrapper, '待回覆')).toBe('1')
    expect(cardValue(wrapper, '家長已到')).toBe('0')
    expect(cardValue(wrapper, '今日已完成')).toBe('12')

    const hw = card(wrapper, '作業完成率')
    expect(hw.find('.stat-card__value').text()).toBe('57%')
    expect(hw.find('.el-progress').attributes('aria-label')).toBe('作業完成率 57%')
    expect(hw.find('[data-test=hw-legend]').text().replace(/\s+/g, '')).toBe('已完成40進行中20尚未開始10')
    expect(hw.findAll('.hw-dot').map((d) => d.classes().find((c) => c.startsWith('tone-')))).toEqual([
      'tone-success',
      'tone-warning',
      'tone-info',
    ])
    expect(hw.text()).toContain('以今天到班的 70 位學生計算')

    const sections = wrapper.findAll('.dash-section__title').map((t) => t.text().replace(/\s+/g, ''))
    expect(sections).toEqual(['出勤', '接送', '作業進度', '近期請假今天起7天內'])
    expect(wrapper.find('.dash-section__hint').text()).toBe('今天起 7 天內')
    expect(wrapper.find('.rl').text()).toContain('王小明')
  })

  it('DashboardView links depend on permissions', async () => {
    mock.onGet(URL).reply(200, dashboard())
    const { wrapper, router } = await mountView(['dashboard:read', 'pickup:read'])

    await card(wrapper, '待回覆').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/pickup')

    await router.push('/')
    await card(wrapper, '應到').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/')
    expect(card(wrapper, '應到').attributes('role')).toBeUndefined()
    expect(card(wrapper, '應到').attributes('tabindex')).toBeUndefined()

    const hw = card(wrapper, '作業完成率')
    expect(hw.attributes('role')).toBeUndefined()
    expect(hw.attributes('tabindex')).toBeUndefined()
    expect(hw.classes()).not.toContain('is-interactive')
    expect(hw.find('.stat-card__chevron').exists()).toBe(false)
    await hw.trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('DashboardView homework card links with homework read', async () => {
    mock.onGet(URL).reply(200, dashboard())
    const { wrapper, router } = await mountView()

    const hw = card(wrapper, '作業完成率')
    expect(hw.attributes('role')).toBe('link')
    expect(hw.attributes('tabindex')).toBe('0')
    expect(hw.classes()).toContain('is-interactive')
    expect(hw.find('.stat-card__chevron').exists()).toBe(true)
    await hw.trigger('keydown', { key: 'Enter' })
    await settle()
    expect(router.currentRoute.value.path).toBe('/homework')

    await router.push('/')
    await card(wrapper, '缺席').trigger('click')
    await settle()
    expect(router.currentRoute.value.path).toBe('/attendance')
  })

  it('DashboardView auto refresh pauses when hidden', async () => {
    mock.onGet(URL).reply(200, dashboard())
    await mountView()
    expect(getCount()).toBe(1)

    await advance(59_000)
    expect(getCount()).toBe(1)
    await advance(1_000)
    expect(getCount()).toBe(2)

    setHidden(true)
    await advance(120_000)
    expect(getCount()).toBe(2)

    setHidden(false)
    await settle()
    expect(getCount()).toBe(3)

    // 回到可見後重新計時：59 秒內不再抓，滿 60 秒才抓
    await advance(59_000)
    expect(getCount()).toBe(3)
    await advance(1_000)
    expect(getCount()).toBe(4)
  })

  it('DashboardView stops refreshing after unmount', async () => {
    mock.onGet(URL).reply(200, dashboard())
    const { wrapper } = await mountView()

    wrapper.unmount()
    await advance(180_000)
    setHidden(true)
    setHidden(false)
    await settle()

    expect(getCount()).toBe(1)
  })

  it('DashboardView non service day banner', async () => {
    mock.onGet(URL).reply(200, dashboard({ is_service_day: false }))
    const { wrapper } = await mountView()

    const alert = wrapper.find('.el-alert')
    expect(alert.text()).toContain('今天不是營業日')
    expect(alert.text()).toContain('出勤、接送與作業統計只在營業日顯示；近期請假照常列出。')
    expect(wrapper.text()).toContain('近期請假')
    expect(wrapper.text()).not.toContain('待回覆')
    expect(wrapper.text()).not.toContain('作業完成率')
    expect(wrapper.text()).not.toContain('應到')
    expect(wrapper.find('.rl').text()).toContain('王小明')
  })

  it('DashboardView keeps data on refresh failure', async () => {
    mock
      .onGet(URL)
      .replyOnce(200, dashboard())
      .onGet(URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
    const { wrapper } = await mountView()

    await advance(60_000)

    expect(getCount()).toBe(2)
    expect(cardValue(wrapper, '應到')).toBe('80')
    expect(document.body.textContent).toContain('伺服器暫時無法回應')
    expect(wrapper.text()).not.toContain('無法載入今日儀表板')
    // 更新時間沒有重設，繼續累加
    expect(wrapper.find('[data-test=updated-at]').text()).toBe('1 分鐘前更新')
  })

  it('DashboardView shows retry on first load failure', async () => {
    mock
      .onGet(URL)
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
      .onGet(URL)
      .replyOnce(200, dashboard())
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入今日儀表板')
    expect(wrapper.find('.stat-card').exists()).toBe(false)
    expect(wrapper.find('[data-test=page-subtitle]').exists()).toBe(false)
    expect(wrapper.find('[data-test=updated-at]').exists()).toBe(false)

    const retry = wrapper.findAll('button').find((b) => b.text() === '重試')
    if (!retry) throw new Error('找不到「重試」')
    await retry.trigger('click')
    await settle()

    expect(getCount()).toBe(2)
    expect(wrapper.text()).not.toContain('無法載入今日儀表板')
    expect(cardValue(wrapper, '應到')).toBe('80')
  })

  it('DashboardView shows skeletons while first loading', async () => {
    let release: (() => void) | undefined
    mock.onGet(URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, dashboard()])
        }),
    )
    const { wrapper } = await mountView()

    expect(wrapper.findAll('[data-test=stat-skeleton]')).toHaveLength(9)
    expect(card(wrapper, '作業完成率').find('.el-skeleton').exists()).toBe(true)
    expect(wrapper.find('.rl__skeleton').exists()).toBe(true)
    expect(wrapper.find('[data-test=page-subtitle]').exists()).toBe(false)
    expect(wrapper.find('[data-test=updated-at]').exists()).toBe(false)
    expect(refreshButton(wrapper).attributes('disabled')).toBeDefined()

    release?.()
    await settle()
    expect(wrapper.find('[data-test=stat-skeleton]').exists()).toBe(false)
    expect(wrapper.find('[data-test=updated-at]').text()).toBe('剛剛更新')
    expect(refreshButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('DashboardView manual refresh shows loading', async () => {
    let release: (() => void) | undefined
    mock
      .onGet(URL)
      .replyOnce(200, dashboard())
      .onGet(URL)
      .replyOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve([200, dashboard({ attendance: { expected_total: 81 } })])
          }),
      )
    const { wrapper } = await mountView()
    await advance(30_000)
    expect(wrapper.find('[data-test=updated-at]').text()).toBe('30 秒前更新')

    await refreshButton(wrapper).trigger('click')
    await settle()
    expect(getCount()).toBe(2)
    expect(refreshButton(wrapper).classes()).toContain('is-loading')
    // 請求中再按不重複送出
    await refreshButton(wrapper).trigger('click')
    await settle()
    expect(getCount()).toBe(2)

    release?.()
    await settle()
    expect(refreshButton(wrapper).classes()).not.toContain('is-loading')
    expect(cardValue(wrapper, '應到')).toBe('81')
    expect(wrapper.find('[data-test=updated-at]').text()).toBe('剛剛更新')
  })

  it('DashboardView colors counts only when positive', async () => {
    mock
      .onGet(URL)
      .replyOnce(200, dashboard({ attendance: { not_arrived: 0, absent: 0 }, pickup: { needs_reply: 0, arrived: 0 } }))
      .onGet(URL)
      .replyOnce(200, dashboard({ attendance: { not_arrived: 4, absent: 1 }, pickup: { needs_reply: 2, arrived: 1 } }))
    const { wrapper } = await mountView()

    for (const label of ['未到', '缺席', '待回覆', '家長已到']) {
      expect(card(wrapper, label).classes(), label).toContain('tone-info')
    }

    await refreshButton(wrapper).trigger('click')
    await settle()

    expect(card(wrapper, '未到').classes()).toContain('tone-warning')
    expect(card(wrapper, '缺席').classes()).toContain('tone-danger')
    expect(card(wrapper, '待回覆').classes()).toContain('tone-danger')
    expect(card(wrapper, '家長已到').classes()).toContain('tone-danger')
    expect(card(wrapper, '應到').classes()).toContain('tone-info')
  })

  it('DashboardView homework placeholder without arrivals', async () => {
    mock
      .onGet(URL)
      .reply(200, dashboard({ homework: { total: 0, done: 0, in_progress: 0, not_started: 0, completion_rate: 0 } }))
    const { wrapper } = await mountView()

    const hw = card(wrapper, '作業完成率')
    expect(hw.find('.stat-card__value').text()).toBe('—')
    expect(hw.text()).toContain('今天還沒有學生到班')
    expect(wrapper.text()).not.toContain('0%')
    expect(hw.find('.el-progress').exists()).toBe(false)
  })

  it('DashboardView marks full homework completion as success', async () => {
    mock
      .onGet(URL)
      .reply(200, dashboard({ homework: { total: 70, done: 70, in_progress: 0, not_started: 0, completion_rate: 100 } }))
    const { wrapper } = await mountView()

    const hw = card(wrapper, '作業完成率')
    expect(hw.find('.stat-card__value').text()).toBe('100%')
    expect(hw.find('.el-progress').classes()).toContain('is-success')
  })

  it('DashboardView updated time text', async () => {
    mock.onGet(URL).reply(200, dashboard())
    const { wrapper } = await mountView()
    const text = () => wrapper.find('[data-test=updated-at]').text()

    expect(text()).toBe('剛剛更新')
    await advance(4_000)
    expect(text()).toBe('剛剛更新')
    await advance(1_000)
    expect(text()).toBe('5 秒前更新')
    await advance(25_000)
    expect(text()).toBe('30 秒前更新')

    setHidden(true)
    await advance(60_000)
    expect(text()).toBe('1 分鐘前更新')
    expect(getCount()).toBe(1)
  })

  it('DashboardView keeps layout from mockup', () => {
    // happy-dom 不計算版面：以原始碼斷言稿的排列（5 / 4 欄、接送與作業 2 : 1、視窗 < 1200px 改上下）
    const style = dashboardViewSource.slice(dashboardViewSource.indexOf('<style'))
    expect(style).toMatch(/\.dash-grid--5\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/)
    expect(style).toMatch(/\.dash-grid--4\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/)
    expect(style).toMatch(/\.dash-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s+minmax\(0,\s*1fr\)/)
    expect(style).toMatch(
      /@media\s*\(max-width:\s*1199\.98px\)\s*\{\s*\.dash-row\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    )
    expect(style).toMatch(/\.dash-section__title\s*\{[^}]*font-size:\s*14px[^}]*font-weight:\s*600/)
  })

  it('DashboardView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.DashboardView()) as { default?: unknown }

    expect(loaded.default).toBe(DashboardView)
  })
})
