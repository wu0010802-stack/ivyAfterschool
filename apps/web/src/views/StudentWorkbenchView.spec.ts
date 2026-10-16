import { flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, onMounted, type PropType } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import { adminHttp } from '@/api/http'
import type { StudentDetail, StudentListItem } from '@/api/students'
import StudentDetailPanel from '@/components/student/StudentDetailPanel.vue'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentWorkbenchView from './StudentWorkbenchView.vue'

// 列表與詳情用真實元件（FRONTEND-086 / 087）；它們底下的 dialog、照片、監護人、成績紀錄各自有完整測試，
// 以替身代替（也避免多個 el-select 與各自的請求拖慢 happy-dom）。替身記錄掛載次數：
// 雙欄 / 抽屜切換不可卸載重掛詳情（GuardianManager 內的綁定碼 dialog 只顯示一次）。
const stubMounts: Record<string, number> = {}

function stub(name: string, propNames: string[], emits: string[]) {
  return defineComponent({
    name,
    props: Object.fromEntries(propNames.map((p) => [p, { type: null as unknown as PropType<unknown>, default: undefined }])),
    emits,
    setup(props) {
      onMounted(() => {
        stubMounts[name] = (stubMounts[name] ?? 0) + 1
      })
      return () => h('div', { 'data-test': name }, JSON.stringify(props))
    },
  })
}

vi.mock('@/components/student/StudentFormDialog.vue', () => ({
  default: stub('StudentFormDialog', ['modelValue', 'student'], ['update:modelValue', 'saved']),
}))
vi.mock('@/components/student/StudentImportDialog.vue', () => ({
  default: stub('StudentImportDialog', ['modelValue'], ['update:modelValue', 'imported']),
}))
vi.mock('@/components/student/GradePromotionDialog.vue', () => ({
  default: stub('GradePromotionDialog', ['modelValue'], ['update:modelValue', 'promoted']),
}))
vi.mock('@/components/student/StudentPhotoUploader.vue', () => ({
  default: stub('StudentPhotoUploader', ['studentId', 'photoUrl', 'name', 'editable'], ['uploaded']),
}))
vi.mock('@/components/student/GuardianManager.vue', () => ({
  default: stub('GuardianManager', ['studentId', 'studentName', 'initial', 'readonly'], ['change']),
}))
vi.mock('@/components/student/StudentExamHistoryTab.vue', () => ({
  default: stub('StudentExamHistoryTab', ['studentId'], []),
}))

const LIST_URL = '/admin/students'
const ALL = ['students:read', 'students:write', 'students:sensitive', 'guardians:write', 'exams:read']

function row(overrides: Partial<StudentListItem> = {}): StudentListItem {
  return {
    id: 's1',
    student_no: 'S1001',
    name: '王小明',
    gender: 'male',
    grade_level: 3,
    school: { id: 'sc1', name: '某某國民小學', short_name: '某某國小' },
    school_class: '三年二班',
    class: { id: 'c1', name: '低年級A班' },
    status: 'active',
    archived_at: null,
    ...overrides,
  } as StudentListItem
}

const ROWS = [row(), row({ id: 's2', student_no: 'S1002', name: '陳小美', grade_level: 2 })]

function detail(overrides: Partial<StudentDetail> = {}): StudentDetail {
  return {
    ...row(),
    birthday: '2018-05-02',
    enrolled_on: '2026-08-01',
    withdrawn_on: null,
    note: null,
    photo_url: null,
    has_id_number: false,
    has_health_note: false,
    sensitive: null,
    guardians: [],
    ...overrides,
  } as StudentDetail
}

const DETAILS: Record<string, StudentDetail> = {
  s1: detail(),
  s2: detail({ id: 's2', student_no: 'S1002', name: '陳小美', grade_level: 2 }),
}

const ROUTES: RouteRecordRaw[] = [{ path: '/students', component: { render: () => null } }]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

function setWidth(width: number): void {
  vi.stubGlobal('innerWidth', width)
}

async function resize(width: number): Promise<void> {
  setWidth(width)
  window.dispatchEvent(new Event('resize'))
  await settle()
  await settle()
}

async function mountView(initialRoute = '/students') {
  const mounted = await mountWithApp(StudentWorkbenchView, {
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
          permissions: ALL,
          must_change_password: false,
        },
      },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  await settle()
  return mounted
}

function listGets(): Record<string, unknown>[] {
  return mock.history.get.filter((c) => c.url === LIST_URL).map((c) => c.params as Record<string, unknown>)
}

function detailGets(id: string): number {
  return mock.history.get.filter((c) => c.url === `${LIST_URL}/${id}`).length
}

/** 詳情的姓名標題（不論在雙欄或抽屜） */
function detailName(): string | null {
  return document.body.querySelector('.detail-head h2')?.textContent?.trim() ?? null
}

function detailInDrawer(): boolean {
  return document.body.querySelector('.el-drawer .detail-head') !== null
}

function detailInColumn(wrapper: VueWrapper): boolean {
  return wrapper.find('.workbench__detail .detail-head').exists()
}

/** 抽屜是否顯示中（el-drawer 關閉時外層 overlay 以 v-show 隱藏） */
function drawerVisible(): boolean {
  const drawer = document.body.querySelector<HTMLElement>('.el-drawer')
  const overlay = drawer?.closest<HTMLElement>('.el-overlay')
  return !!overlay && overlay.style.display !== 'none'
}

async function clickRow(wrapper: VueWrapper, name: string): Promise<void> {
  const tr = wrapper
    .findAll('.el-table__body tr.el-table__row')
    .find((r) => r.findAll('td')[1]?.text().startsWith(name))
  if (!tr) throw new Error(`找不到學生列 ${name}`)
  await tr.trigger('click')
  await settle()
  await settle()
}

/** 以篩選標籤找到 AdminListToolbar 的下拉，選取選項（以 input 的 aria-controls 對應 teleport 的選單） */
async function chooseFilter(wrapper: VueWrapper, label: string, option: string): Promise<void> {
  const filter = wrapper
    .findAll('.list-toolbar__filter')
    .find((f) => f.find('.list-toolbar__filter-label').text() === label)
  if (!filter) throw new Error(`找不到篩選 ${label}`)
  await filter.find('.el-select__wrapper').trigger('click')
  await settle()
  const listId = filter.find('input').attributes('aria-controls')
  const options = Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? [])
  const found = options.find((o) => o.textContent?.trim() === option)
  if (!found) throw new Error(`篩選 ${label} 找不到「${option}」`)
  found.click()
  await settle()
}

async function answerMessageBox(text: string): Promise<void> {
  await settle()
  const box = Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
  const btn = Array.from(box?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (b) => b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`確認框找不到「${text}」`)
  btn.click()
  await settle()
  await settle()
}

describe('StudentWorkbenchView', { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setWidth(1600)
    for (const key of Object.keys(stubMounts)) delete stubMounts[key]
    mock = createApiMock(adminHttp)
    mock.onGet('/admin/classes').reply(200, [])
    mock.onGet('/admin/schools').reply(200, [])
    mock.onGet(LIST_URL).reply(200, { items: ROWS, total: 45 })
    mock.onGet(/^\/admin\/students\/s\d$/).reply((config) => {
      const id = config.url!.split('/').at(-1)!
      return [200, DETAILS[id]]
    })
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('StudentWorkbenchView selects student via list click', async () => {
    const { wrapper, router } = await mountView()
    expect(detailName()).toBeNull()

    await clickRow(wrapper, '王小明')

    expect(router.currentRoute.value.query.student).toBe('s1')
    expect(detailGets('s1')).toBe(1)
    expect(detailName()).toContain('王小明')
    expect(detailInColumn(wrapper)).toBe(true)
    expect(wrapper.find('.el-table__body tr.current-row').text()).toContain('王小明')

    // 換學生時保留詳情分頁
    await router.replace({ query: { ...router.currentRoute.value.query, tab: 'guardians' } })
    await clickRow(wrapper, '陳小美')
    expect(router.currentRoute.value.query).toMatchObject({ student: 's2', tab: 'guardians' })
    expect(detailName()).toContain('陳小美')
    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('監護人（0）')
  })

  it('StudentWorkbenchView opens student from query', async () => {
    const { wrapper } = await mountView('/students?student=s2')

    expect(detailGets('s2')).toBe(1)
    expect(detailGets('s1')).toBe(0)
    expect(detailName()).toContain('陳小美')
    expect(wrapper.find('.el-table__body tr.current-row').text()).toContain('陳小美')
  })

  it('StudentWorkbenchView reloads list after detail change', async () => {
    mock.onPost(`${LIST_URL}/s1/archive`).reply(200, { ...DETAILS.s1, archived_at: '2026-10-16T03:00:00Z' })
    const { wrapper } = await mountView('/students?student=s1&page=2')
    expect(listGets()).toHaveLength(1)

    const archive = wrapper.findAll('button').find((b) => b.text() === '封存')
    await archive!.trigger('click')
    await answerMessageBox('封存')

    // 重新載入目前頁（篩選與頁碼不變）
    expect(listGets()).toHaveLength(2)
    expect(listGets()[1]).toEqual(listGets()[0])
    expect(listGets()[1]).toMatchObject({ page: 2 })

    wrapper.findComponent(StudentDetailPanel).vm.$emit('changed')
    await settle()
    expect(listGets()).toHaveLength(3)
  })

  it('StudentWorkbenchView placeholder without selection', async () => {
    const { wrapper } = await mountView()

    expect(wrapper.find('.workbench__detail').text()).toContain('從左側選擇學生以檢視詳情')
    expect(mock.history.get.filter((c) => /\/admin\/students\/s\d$/.test(c.url ?? ''))).toHaveLength(0)
    expect(drawerVisible()).toBe(false)
  })

  it('StudentWorkbenchView switches to drawer below 1440', async () => {
    setWidth(1439)
    const { wrapper, router } = await mountView('/students?student=s1&tab=guardians&status=all&page=2')

    expect(drawerVisible()).toBe(true)
    expect(detailInDrawer()).toBe(true)
    expect(detailName()).toContain('王小明')
    expect(wrapper.find('.workbench__detail').isVisible()).toBe(false)

    const close = document.body.querySelector<HTMLButtonElement>('.el-drawer [aria-label=關閉]')
    close!.click()
    await settle()

    // 關閉只清掉選取與詳情分頁，列表的篩選與頁碼保留
    expect(router.currentRoute.value.query).toEqual({ status: 'all', page: '2' })
    expect(drawerVisible()).toBe(false)

    // 關閉動畫期間詳情仍在（抽屜不留白），動畫結束（closed）後才卸載
    expect(detailName()).toContain('王小明')
    wrapper.findComponent({ name: 'ElDrawer' }).vm.$emit('closed')
    await settle()
    expect(detailName()).toBeNull()

    // 窄版點列 → 開抽屜
    await clickRow(wrapper, '陳小美')
    expect(drawerVisible()).toBe(true)
    expect(detailInDrawer()).toBe(true)
    expect(detailName()).toContain('陳小美')
    wrapper.unmount()
    document.body.innerHTML = ''

    setWidth(1440)
    const wide = await mountView('/students?student=s1')
    expect(detailInDrawer()).toBe(false)
    expect(detailInColumn(wide.wrapper)).toBe(true)
    expect(drawerVisible()).toBe(false)
  })

  it('StudentWorkbenchView keeps detail mounted when crossing 1440', async () => {
    const { wrapper } = await mountView('/students?student=s1&tab=guardians')
    expect(detailInColumn(wrapper)).toBe(true)
    expect(stubMounts.GuardianManager).toBe(1)

    await resize(1200)
    expect(detailInDrawer()).toBe(true)
    expect(detailName()).toContain('王小明')
    expect(stubMounts.GuardianManager).toBe(1)
    expect(detailGets('s1')).toBe(1)

    await resize(1600)
    expect(detailInColumn(wrapper)).toBe(true)
    expect(detailInDrawer()).toBe(false)
    expect(drawerVisible()).toBe(false)
    expect(stubMounts.GuardianManager).toBe(1)
    expect(detailGets('s1')).toBe(1)
  })

  it('StudentWorkbenchView keeps selection across list query changes', async () => {
    const { wrapper, router } = await mountView('/students?student=s1')

    await chooseFilter(wrapper, '狀態', '暫停')
    expect(router.currentRoute.value.query).toMatchObject({ student: 's1', status: 'suspended', page: '1' })

    await wrapper.find('.el-pagination .btn-next').trigger('click')
    await settle()
    expect(listGets().at(-1)).toMatchObject({ status: 'suspended', page: 2 })
    expect(router.currentRoute.value.query).toMatchObject({ student: 's1', status: 'suspended', page: '2' })

    expect(detailName()).toContain('王小明')
    expect(detailGets('s1')).toBe(1)
  })
})
