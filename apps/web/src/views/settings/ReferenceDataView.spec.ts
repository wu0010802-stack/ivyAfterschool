import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { adminHttp } from '@/api/http'
import ClosedDayTable from '@/components/settings/reference/ClosedDayTable.vue'
import ExamTypeTable from '@/components/settings/reference/ExamTypeTable.vue'
import SchoolTable from '@/components/settings/reference/SchoolTable.vue'
import SubjectTable from '@/components/settings/reference/SubjectTable.vue'
import { VIEW_LOADERS } from '@/router/viewLoaders'
import { useLookupsStore } from '@/stores/lookups'
import { createApiMock, mountWithApp } from '@/test/helpers'
import ReferenceDataView from './ReferenceDataView.vue'

const SUBJECTS = [
  { id: 's1', name: '國語', sort_order: 1, is_active: true },
  { id: 's2', name: '數學', sort_order: 2, is_active: true },
]
const SCHOOLS = [{ id: 'sc1', name: '某某國小', short_name: '某某', is_active: true }]

const ROUTES: RouteRecordRaw[] = [{ path: '/settings/reference', component: ReferenceDataView }]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountView(initialRoute = '/settings/reference') {
  const mounted = await mountWithApp(ReferenceDataView, {
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
          permissions: ['settings:read', 'settings:write'],
          must_change_password: false,
        },
      },
      lookups: { loaded: { classes: true, subjects: true, examTypes: true, schools: true } },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  return mounted
}

function getUrls(): (string | undefined)[] {
  return mock.history.get.map((c) => c.url)
}

async function clickTab(wrapper: VueWrapper, title: string): Promise<void> {
  const tab = wrapper.findAll('.el-tabs__item').find((t) => t.text() === title)
  if (!tab) throw new Error(`找不到分頁「${title}」`)
  await tab.trigger('click')
  await settle()
}

async function clickIn(root: VueWrapper | DOMWrapper<Element>, text: string): Promise<void> {
  const btn = root.findAll('button').find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  await btn.trigger('click')
  await settle()
}

function dialog(): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).at(-1)
  if (!el) throw new Error('dialog 沒有出現')
  return new DOMWrapper(el)
}

describe('ReferenceDataView', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/subjects').reply(200, SUBJECTS)
    mock.onGet('/admin/exam-types').reply(200, [])
    mock.onGet('/admin/schools').reply(200, SCHOOLS)
    mock.onGet('/admin/closed-days').reply(200, [])
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('ReferenceDataView shows header and four tabs', async () => {
    const { wrapper } = await mountView()

    expect(wrapper.find('h1').text()).toBe('參考資料')
    expect(wrapper.find('[data-test=page-subtitle]').text()).toBe('科目、考試類型、合作國小與休息日')
    expect(wrapper.findAll('.el-tabs__item').map((t) => t.text())).toEqual(['科目', '考試類型', '合作國小', '休息日'])
    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('科目')
  })

  it('ReferenceDataView loads only active tab', async () => {
    const { wrapper, router } = await mountView()

    expect(getUrls()).toEqual(['/admin/subjects'])
    expect(wrapper.findComponent(SubjectTable).exists()).toBe(true)
    expect(wrapper.findComponent(ClosedDayTable).exists()).toBe(false)

    await clickTab(wrapper, '休息日')

    expect(getUrls()).toEqual(['/admin/subjects', '/admin/closed-days'])
    expect(router.currentRoute.value.query.tab).toBe('closed-days')
    expect(wrapper.findComponent(ExamTypeTable).exists()).toBe(false)
    expect(wrapper.findComponent(SchoolTable).exists()).toBe(false)

    await clickTab(wrapper, '考試類型')
    expect(router.currentRoute.value.query.tab).toBe('exam-types')
    expect(getUrls()).toEqual(['/admin/subjects', '/admin/closed-days', '/admin/exam-types'])
  })

  it('ReferenceDataView restores tab from query', async () => {
    const { wrapper, router } = await mountView('/settings/reference?tab=schools')

    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('合作國小')
    expect(wrapper.findComponent(SchoolTable).exists()).toBe(true)
    expect(wrapper.findComponent(SubjectTable).exists()).toBe(false)
    expect(mock.history.get[0]?.url).toBe('/admin/schools')
    expect(wrapper.text()).toContain('某某國小')

    // 不認得的 tab 退回科目
    await router.push('/settings/reference?tab=nope')
    await settle()
    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('科目')
  })

  it('ReferenceDataView invalidates lookups after write', async () => {
    mock.onPost('/admin/subjects').reply(201, { id: 's3', name: '自然', sort_order: 3, is_active: true })
    const { wrapper, pinia } = await mountView()
    const lookups = useLookupsStore(pinia)
    expect(lookups.subjectsLoaded).toBe(true)

    await clickIn(wrapper.find('.ref-toolbar'), '新增科目')
    const nameInput = dialog()
      .findAll('.el-form-item')
      .find((i) => i.find('.el-form-item__label').text().trim() === '名稱')
      ?.find('input')
    if (!nameInput) throw new Error('找不到名稱欄位')
    await nameInput.setValue('自然')
    await clickIn(dialog(), '儲存')

    expect(mock.history.post).toHaveLength(1)
    expect(lookups.subjectsLoaded).toBe(false)
    expect(lookups.schoolsLoaded).toBe(true)
  })

  it('ReferenceDataView is wired in view loaders', async () => {
    const loaded = (await VIEW_LOADERS.ReferenceDataView()) as { default?: unknown }

    expect(loaded.default).toBe(ReferenceDataView)
  })
})
