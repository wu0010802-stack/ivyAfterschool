import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { JsonSchema, Setting } from '@/api/settings'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { createApiMock, mountWithApp } from '@/test/helpers'
import SystemSettingsView from './SystemSettingsView.vue'

const LIST_URL = '/admin/settings'
const TIME = '^([01]\\d|2[0-3]):[0-5]\\d$'

function setting(key: string, group: string, label: string, schema: JsonSchema, value: Record<string, unknown>): Setting {
  return {
    key,
    group,
    label,
    is_secret: false,
    value,
    json_schema: { title: label, type: 'object', additionalProperties: false, ...schema },
    updated_at: null,
    updated_by_name: null,
  }
}

function intField(title: string, minimum = 0, maximum = 365): JsonSchema {
  return { type: 'integer', minimum, maximum, title }
}

// 依 BACKEND-106 registry 的回傳順序（分組交錯），驗證前端依分組固定順序排列
function settingsFixture(): Setting[] {
  return [
    setting(
      'org.profile',
      'org',
      '安親班資料',
      { properties: { name: { type: 'string', maxLength: 50, title: '安親班名稱' } } },
      { name: '某某安親班' },
    ),
    setting(
      'pickup.window',
      'pickup',
      '接送時段',
      {
        required: ['request_start', 'request_end', 'latest_expected_arrival', 'auto_expire_minutes'],
        properties: {
          request_start: { type: 'string', pattern: TIME, title: '可發起接送開始時間' },
          request_end: { type: 'string', pattern: TIME, title: '可發起接送結束時間' },
          latest_expected_arrival: { type: 'string', pattern: TIME, title: '最晚預計抵達時間' },
          auto_expire_minutes: intField('接送請求自動過期分鐘數', 10, 600),
        },
      },
      { request_start: '12:00', request_end: '19:00', latest_expected_arrival: '19:00', auto_expire_minutes: 120 },
    ),
    setting(
      'homework.defaults',
      'homework',
      '作業進度預設',
      { properties: { auto_reply_without_eta: { type: 'boolean', title: '未設定預計時間時自動回覆' } } },
      { auto_reply_without_eta: true },
    ),
    {
      key: 'notification.toggles',
      group: 'notification',
      label: '通知開關',
      is_secret: false,
      value: { 'pickup.requested': true, 'exam.published': false },
      json_schema: {
        title: '通知開關',
        type: 'object',
        additionalProperties: { type: 'boolean' },
        'x-labels': { 'pickup.requested': '家長發起接送', 'exam.published': '成績公布' },
      } as JsonSchema,
      updated_at: null,
      updated_by_name: null,
    },
    setting(
      'line.liff',
      'line',
      'LINE 登入（LIFF）',
      { properties: { liff_id: { type: 'string', pattern: '^$|^\\d+-[A-Za-z0-9]+$', title: 'LIFF 應用程式 ID' } } },
      { liff_id: '' },
    ),
    setting(
      'leave.window',
      'leave',
      '請假申請範圍',
      { properties: { past_days: intField('家長可申請的過去天數') } },
      { past_days: 30 },
    ),
    setting(
      'pickup.authorization',
      'pickup',
      '代理接送授權',
      { properties: { max_days_ahead: intField('代理授權最多可提前天數', 0, 60) } },
      { max_days_ahead: 14 },
    ),
    setting(
      'pickup.persons',
      'pickup',
      '常用接送人',
      { properties: { max_per_student: intField('每位學生常用接送人上限', 1, 50) } },
      { max_per_student: 10 },
    ),
    setting(
      'homework.window',
      'homework',
      '作業日期範圍',
      { properties: { past_days: intField('作業可新增的過去天數') } },
      { past_days: 30 },
    ),
  ]
}

const Stub = { render: () => null }
/** 以 RouterView 承載頁面，onBeforeRouteLeave / onBeforeRouteUpdate 才會生效 */
const Host = defineComponent({ render: () => h(RouterView) })
const ROUTES: RouteRecordRaw[] = [
  { path: '/settings/system', component: SystemSettingsView, meta: { title: '系統設定' } },
  { path: '/students', component: Stub, meta: { title: '學生工作台' } },
]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountView(initialRoute = '/settings/system', permissions = ['settings:read', 'settings:write']) {
  const mounted = await mountWithApp(Host, {
    routes: ROUTES,
    initialRoute,
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

function tabTitles(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-tabs__item').map((t) => t.text())
}

function activeTabTitle(wrapper: VueWrapper): string {
  return wrapper.find('.el-tabs__item.is-active').text()
}

/** el-tab-pane 以 v-show 切換，非作用中的分頁仍在 DOM，只看可見的那一頁 */
function activePane(wrapper: VueWrapper): DOMWrapper<HTMLElement> {
  const panes = wrapper.findAll<HTMLElement>('.el-tab-pane').filter((p) => p.element.style.display !== 'none')
  if (panes.length !== 1) throw new Error(`可見分頁數為 ${panes.length}`)
  return panes[0]!
}

async function clickTab(wrapper: VueWrapper, title: string): Promise<void> {
  const tab = wrapper.findAll('.el-tabs__item').find((t) => t.text() === title)
  if (!tab) throw new Error(`找不到分頁「${title}」`)
  await tab.trigger('click')
  await settle()
}

function card(wrapper: VueWrapper, key: string): DOMWrapper<HTMLElement> {
  const el = wrapper.find<HTMLElement>(`.setting-card[data-key="${key}"]`)
  if (!el.exists()) throw new Error(`找不到設定卡 ${key}`)
  return el
}

async function setExpireMinutes(wrapper: VueWrapper, value: string): Promise<void> {
  const input = card(wrapper, 'pickup.window').find('[data-test="field-auto_expire_minutes"] input')
  await input.setValue(value)
  await input.trigger('change')
  await settle()
}

function expireMinutesValue(wrapper: VueWrapper): string {
  return card(wrapper, 'pickup.window').find<HTMLInputElement>('[data-test="field-auto_expire_minutes"] input').element
    .value
}

/** ElMessageBox 下一個 tick 才渲染；已關閉的仍可能留在 DOM，取最後一個 */
async function messageBoxButton(text: string): Promise<HTMLButtonElement> {
  await settle()
  const box = Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
  const btn = Array.from(box?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`message box 找不到「${text}」`)
  return btn
}

async function answerMessageBox(text: string): Promise<void> {
  ;(await messageBoxButton(text)).click()
  await settle()
  await settle()
}

describe('SystemSettingsView', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('SystemSettingsView groups settings into tabs dynamically', async () => {
    mock.onGet(LIST_URL).reply(200, { items: settingsFixture() })
    const { wrapper, router } = await mountView()

    expect(tabTitles(wrapper)).toEqual(['安親班資料', '接送', '作業進度', '請假', '通知', 'LINE 串接'])
    expect(activeTabTitle(wrapper)).toBe('安親班資料')

    await clickTab(wrapper, '接送')
    // 每頁內依 API 回傳順序
    expect(activePane(wrapper).findAll('.setting-card').map((c) => c.attributes('data-key'))).toEqual([
      'pickup.window',
      'pickup.authorization',
      'pickup.persons',
    ])
    expect(router.currentRoute.value.query.tab).toBe('pickup')

    await clickTab(wrapper, 'LINE 串接')
    expect(router.currentRoute.value.query.tab).toBe('line')
    expect(activePane(wrapper).findAll('.setting-card').map((c) => c.attributes('data-key'))).toEqual(['line.liff'])
  })

  it('SystemSettingsView restores tab from query', async () => {
    mock.onGet(LIST_URL).reply(200, { items: settingsFixture() })
    const { wrapper, router } = await mountView('/settings/system?tab=homework')

    expect(activeTabTitle(wrapper)).toBe('作業進度')
    expect(activePane(wrapper).text()).toContain('作業日期範圍')

    // 不存在的分組退回第一個分組
    await router.push('/settings/system?tab=nope')
    await settle()
    expect(activeTabTitle(wrapper)).toBe('安親班資料')
  })

  it('SystemSettingsView renders field labels from schema titles', async () => {
    mock.onGet(LIST_URL).reply(200, { items: settingsFixture() })
    const { wrapper } = await mountView()

    await clickTab(wrapper, '接送')
    expect(activePane(wrapper).text()).toContain('可發起接送開始時間')

    await clickTab(wrapper, '通知')
    const labels = activePane(wrapper)
      .findAll('[data-test=toggle-label]')
      .map((l) => l.text())
    expect(labels).toEqual(['家長發起接送', '成績公布'])
  })

  it('SystemSettingsView warns before leaving with unsaved changes', async () => {
    mock.onGet(LIST_URL).reply(200, { items: settingsFixture() })
    const { wrapper, router } = await mountView('/settings/system?tab=pickup')
    await setExpireMinutes(wrapper, '90')

    await clickTab(wrapper, '通知')
    expect(document.body.textContent).toContain('尚未儲存的變更將會遺失')

    await answerMessageBox('繼續編輯')
    expect(activeTabTitle(wrapper)).toBe('接送')
    expect(router.currentRoute.value.query.tab).toBe('pickup')
    expect(expireMinutesValue(wrapper)).toBe('90')
  })

  it('SystemSettingsView discards changes when confirmed', async () => {
    mock.onGet(LIST_URL).reply(200, { items: settingsFixture() })
    const { wrapper, router } = await mountView('/settings/system?tab=pickup')
    await setExpireMinutes(wrapper, '90')
    expect(card(wrapper, 'pickup.window').text()).toContain('未儲存')

    await clickTab(wrapper, '通知')
    await answerMessageBox('放棄變更')
    expect(activeTabTitle(wrapper)).toBe('通知')
    expect(router.currentRoute.value.query.tab).toBe('notification')

    // 已還原、沒有變更：切回接送不再詢問
    const boxes = document.body.querySelectorAll('.el-message-box').length
    await clickTab(wrapper, '接送')
    expect(document.body.querySelectorAll('.el-message-box').length).toBe(boxes)
    expect(activeTabTitle(wrapper)).toBe('接送')
    expect(expireMinutesValue(wrapper)).toBe('120')
    expect(card(wrapper, 'pickup.window').text()).not.toContain('未儲存')
  })

  it('SystemSettingsView guards route leave with unsaved changes', async () => {
    mock.onGet(LIST_URL).reply(200, { items: settingsFixture() })
    const { wrapper, router } = await mountView('/settings/system?tab=pickup')

    await setExpireMinutes(wrapper, '90')
    const leaving = router.push('/students')
    await settle()
    expect(document.body.textContent).toContain('尚未儲存的變更將會遺失')
    await answerMessageBox('繼續編輯')
    await leaving
    expect(router.currentRoute.value.path).toBe('/settings/system')

    const leavingAgain = router.push('/students')
    await settle()
    await answerMessageBox('放棄變更')
    await leavingAgain
    expect(router.currentRoute.value.path).toBe('/students')
  })

  it('SystemSettingsView leaves without prompt when clean', async () => {
    mock.onGet(LIST_URL).reply(200, { items: settingsFixture() })
    const { router } = await mountView('/settings/system?tab=pickup')

    await router.push('/students')
    await settle()

    expect(router.currentRoute.value.path).toBe('/students')
    expect(document.body.querySelector('.el-message-box')).toBeNull()
  })

  it('SystemSettingsView shows skeleton while loading', async () => {
    let release: (() => void) | undefined
    mock.onGet(LIST_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, { items: settingsFixture() }])
        }),
    )
    const { wrapper } = await mountView()

    expect(wrapper.find('h1').text()).toBe('系統設定')
    expect(wrapper.findAll('.el-skeleton').length).toBeGreaterThanOrEqual(2)
    expect(wrapper.find('.el-tabs').exists()).toBe(false)

    release?.()
    await settle()
    expect(wrapper.find('.el-skeleton').exists()).toBe(false)
    expect(wrapper.findAll('.setting-card')).toHaveLength(9)
  })

  it('SystemSettingsView shows retry on load failure', async () => {
    mock.onGet(LIST_URL).replyOnce(500, { error: { code: 'internal_error', message: '伺服器發生錯誤' } })
    mock.onGet(LIST_URL).replyOnce(200, { items: settingsFixture() })
    const { wrapper } = await mountView()

    expect(wrapper.text()).toContain('無法載入系統設定')
    expect(wrapper.find('.setting-card').exists()).toBe(false)

    const retry = wrapper.findAll('button').find((b) => b.text() === '重試')
    if (!retry) throw new Error('找不到「重試」')
    await retry.trigger('click')
    await settle()

    expect(mock.history.get).toHaveLength(2)
    expect(wrapper.text()).not.toContain('無法載入系統設定')
    expect(wrapper.findAll('.setting-card')).toHaveLength(9)
  })

  it('SystemSettingsView shows unknown group last', async () => {
    const beta = setting(
      'beta.flag',
      'beta',
      '實驗功能',
      { properties: { enabled: { type: 'boolean', title: '啟用實驗功能' } } },
      { enabled: false },
    )
    mock.onGet(LIST_URL).reply(200, { items: [beta, ...settingsFixture()] })
    const { wrapper } = await mountView()

    expect(tabTitles(wrapper).at(-1)).toBe('beta')
    expect(tabTitles(wrapper)).toHaveLength(7)
    await clickTab(wrapper, 'beta')
    expect(activePane(wrapper).findAll('.setting-card').map((c) => c.attributes('data-key'))).toEqual(['beta.flag'])
  })

  it('SystemSettingsView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.SystemSettingsView()) as { default?: unknown }

    expect(loaded.default).toBe(SystemSettingsView)
  })
})
