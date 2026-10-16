import { flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, onMounted, type PropType } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { Guardian } from '@/api/guardians'
import { adminHttp } from '@/api/http'
import type { StudentDetail } from '@/api/students'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentDetailPanel from './StudentDetailPanel.vue'

// 子元件各自有完整測試：照片、監護人、成績紀錄、編輯 dialog 以替身驗證本元件傳入的 props 與完成事件
// （也避免它們各自發請求、多個 el-select 拖慢 happy-dom）。敏感欄位與永久刪除 dialog 用真實元件。
// 替身記錄掛載次數：靜默重抓不可卸載重掛子元件（GuardianManager 內的綁定碼 dialog 只顯示一次）。
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

vi.mock('./StudentPhotoUploader.vue', () => ({
  default: stub('StudentPhotoUploader', ['studentId', 'photoUrl', 'name', 'editable'], ['uploaded']),
}))
vi.mock('./GuardianManager.vue', () => ({
  default: stub('GuardianManager', ['studentId', 'studentName', 'initial', 'readonly'], ['change']),
}))
vi.mock('./StudentExamHistoryTab.vue', () => ({ default: stub('StudentExamHistoryTab', ['studentId'], []) }))
vi.mock('./StudentFormDialog.vue', () => ({
  default: stub('StudentFormDialog', ['modelValue', 'student'], ['update:modelValue', 'saved']),
}))

const ALL = ['students:read', 'students:write', 'students:sensitive', 'students:purge', 'guardians:write', 'exams:read']
const READER = ['students:read']

const GUARDIAN: Guardian = {
  id: 'g1',
  student_id: 's1',
  name: '王大明',
  relation: 'father',
  phone: '0912-000-123',
  is_primary: true,
  can_pickup: true,
  receives_notifications: true,
  binding: { status: 'unbound' },
} as Guardian

function detail(overrides: Partial<StudentDetail> = {}): StudentDetail {
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
    birthday: '2018-05-02',
    enrolled_on: '2026-08-01',
    withdrawn_on: null,
    note: '對花生過敏\n午睡需要小被子',
    photo_url: null,
    has_id_number: true,
    has_health_note: false,
    sensitive: null,
    guardians: [GUARDIAN],
    ...overrides,
  } as StudentDetail
}

const ARCHIVED_WITHDRAWN = detail({
  status: 'withdrawn',
  archived_at: '2026-09-01T02:00:00Z',
  withdrawn_on: '2026-08-31',
})

const ROUTES: RouteRecordRaw[] = [{ path: '/students', component: { render: () => null } }]

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountPanel(
  options: { permissions?: string[]; studentId?: string; initialRoute?: string } = {},
) {
  const mounted = await mountWithApp(StudentDetailPanel, {
    routes: ROUTES,
    initialRoute: options.initialRoute ?? '/students?student=s1',
    props: { studentId: options.studentId ?? 's1' },
    piniaInitialState: {
      auth: {
        status: 'authenticated',
        user: {
          id: 'u1',
          username: 'director01',
          display_name: '張主任',
          role: { id: 'r-director', code: 'director', name: '主任' },
          permissions: options.permissions ?? ALL,
          must_change_password: false,
        },
      },
    },
  })
  document.body.appendChild(mounted.wrapper.element)
  await settle()
  return mounted
}

function detailGets(id = 's1'): number {
  return mock.history.get.filter((c) => c.url === `/admin/students/${id}`).length
}

/** header 的 meta 兩行（以 <br> 分隔）：學號・年級・安親班班級／就讀國小與班級 */
function metaLines(wrapper: VueWrapper): string[] {
  const lines: string[] = ['']
  for (const node of Array.from(wrapper.find('.detail-head__meta').element.childNodes)) {
    if (node.nodeName === 'BR') lines.push('')
    else lines[lines.length - 1] += node.textContent ?? ''
  }
  return lines.map((l) => l.replace(/\s+/g, ' ').trim())
}

function buttonsText(wrapper: VueWrapper): string[] {
  return wrapper.findAll('button').map((b) => b.text())
}

async function click(wrapper: VueWrapper, text: string): Promise<void> {
  const btn = wrapper.findAll('button').find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  await btn.trigger('click')
  await settle()
}

function tabTitles(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.el-tabs__item').map((t) => t.text())
}

async function clickTab(wrapper: VueWrapper, title: string): Promise<void> {
  const tab = wrapper.findAll('.el-tabs__item').find((t) => t.text().startsWith(title))
  if (!tab) throw new Error(`找不到分頁 ${title}`)
  await tab.trigger('click')
  await settle()
}

function stubProps(wrapper: VueWrapper, name: string): Record<string, unknown> {
  const el = wrapper.findComponent({ name })
  if (!el.exists()) throw new Error(`沒有 ${name}`)
  return el.props() as Record<string, unknown>
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

async function openMoreMenu(wrapper: VueWrapper): Promise<string[]> {
  const more = wrapper.find('[aria-label=更多操作]')
  if (!more.exists()) return []
  await more.trigger('click')
  await vi.advanceTimersByTimeAsync(300)
  await settle()
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown__popper'))
    .filter((p) => p.style.display !== 'none')
    .flatMap((p) => Array.from(p.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')))
    .map((i) => i.textContent?.trim() ?? '')
}

describe('StudentDetailPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mock = createApiMock(adminHttp)
    for (const key of Object.keys(stubMounts)) delete stubMounts[key]
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('StudentDetailPanel renders header and basic info', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const { wrapper } = await mountPanel()

    const head = wrapper.find('.detail-head')
    expect(head.find('h2').text().replace(/\s+/g, '')).toBe('王小明在學')
    expect(head.find('h2 .el-tag').classes()).toContain('el-tag--success')
    expect(metaLines(wrapper)).toEqual(['S1001・三年級・低年級A班', '某某國小 三年二班'])
    expect(head.find('.detail-head__archived').exists()).toBe(false)

    // 第一個 el-descriptions 是基本資料；敏感欄位（StudentSensitiveFields）另有自己的 descriptions
    const basic = wrapper.findAll('.el-descriptions')[0]!
    const items = Object.fromEntries(
      basic.findAll('.el-descriptions__label').map((l, i) => [l.text(), basic.findAll('.el-descriptions__content')[i]?.text()]),
    )
    expect(items).toEqual({
      性別: '男',
      生日: '2018/05/02',
      入學日: '2026/08/01',
      退班日: '—',
      備註: '對花生過敏\n午睡需要小被子',
    })
    expect(wrapper.text()).toContain('敏感資料')
    // 真實 StudentSensitiveFields：有權限但後端未給明文時顯示已填寫 / 未填寫
    expect(wrapper.text()).toContain('身分證字號')

    expect(stubProps(wrapper, 'StudentPhotoUploader')).toMatchObject({
      studentId: 's1',
      photoUrl: null,
      name: '王小明',
      editable: true,
    })
    expect(tabTitles(wrapper)).toEqual(['基本資料', '監護人（1）', '成績紀錄'])
  })

  it('StudentDetailPanel shows fallbacks for missing class and school', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail({ class: null, school: null, school_class: null, gender: null, note: null }))
    const { wrapper } = await mountPanel()

    expect(metaLines(wrapper)).toEqual(['S1001・三年級・未分班', '未填就讀國小'])
    const labels = wrapper.findAll('.el-descriptions__label').map((l) => l.text())
    const contents = wrapper.findAll('.el-descriptions__content').map((c) => c.text())
    expect(contents[labels.indexOf('性別')]).toBe('—')
    expect(contents[labels.indexOf('備註')]).toBe('—')
  })

  it('StudentDetailPanel archives with confirmation', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    mock.onPost('/admin/students/s1/archive').reply(200, detail({ archived_at: '2026-10-02T03:00:00Z' }))
    const { wrapper } = await mountPanel()

    await click(wrapper, '封存')
    const box = Array.from(document.body.querySelectorAll<HTMLElement>('.el-message-box')).at(-1)
    expect(box?.textContent).toContain('封存後此學生不會出現在出勤、接送等名單，確定要封存 王小明 嗎？')
    expect(box?.querySelector('.el-message-box__title')?.textContent?.trim()).toBe('封存學生')
    await answerMessageBox('封存')

    expect(mock.history.post[0]?.url).toBe('/admin/students/s1/archive')
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.find('.detail-head__archived').text()).toContain('已封存（2026/10/02）')
    expect(buttonsText(wrapper)).not.toContain('編輯')
  })

  it('StudentDetailPanel cancel archive keeps student', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const { wrapper } = await mountPanel()

    await click(wrapper, '封存')
    await answerMessageBox('取消')

    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('changed')).toBeUndefined()
  })

  it('StudentDetailPanel hides write actions for readers and archived students', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const reader = await mountPanel({ permissions: READER })
    expect(buttonsText(reader.wrapper)).not.toContain('編輯')
    expect(buttonsText(reader.wrapper)).not.toContain('封存')
    expect(stubProps(reader.wrapper, 'StudentPhotoUploader').editable).toBe(false)
    reader.wrapper.unmount()
    document.body.innerHTML = ''

    mock.onGet('/admin/students/s2').reply(200, detail({ id: 's2', archived_at: '2026-09-01T02:00:00Z' }))
    const archived = await mountPanel({ studentId: 's2', permissions: ['students:read', 'students:write'] })
    expect(archived.wrapper.text()).toContain('已封存（2026/09/01）')
    expect(buttonsText(archived.wrapper)).not.toContain('編輯')
    expect(buttonsText(archived.wrapper)).not.toContain('封存')
    expect(stubProps(archived.wrapper, 'StudentPhotoUploader').editable).toBe(false)
  })

  it('StudentDetailPanel edits via form dialog', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const { wrapper } = await mountPanel()

    expect(stubProps(wrapper, 'StudentFormDialog').modelValue).toBe(false)
    await click(wrapper, '編輯')
    expect(stubProps(wrapper, 'StudentFormDialog')).toMatchObject({ modelValue: true, student: { id: 's1', name: '王小明' } })

    wrapper.findComponent({ name: 'StudentFormDialog' }).vm.$emit('saved', detail({ name: '王大華', grade_level: 4 }))
    await settle()

    expect(wrapper.find('.detail-head h2').text()).toContain('王大華')
    expect(wrapper.find('.detail-head__meta').text()).toContain('四年級')
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('StudentDetailPanel emits changed after photo upload', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const { wrapper } = await mountPanel()

    wrapper.findComponent({ name: 'StudentPhotoUploader' }).vm.$emit('uploaded', 'https://r2.example/s1.jpg')
    await settle()

    expect(stubProps(wrapper, 'StudentPhotoUploader').photoUrl).toBe('https://r2.example/s1.jpg')
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('StudentDetailPanel passes guardians and refreshes count after change', async () => {
    let releaseReload: (() => void) | undefined
    mock
      .onGet('/admin/students/s1')
      .replyOnce(200, detail())
      .onGet('/admin/students/s1')
      .replyOnce(
        () =>
          new Promise((resolve) => {
            releaseReload = () =>
              resolve([
                200,
                detail({ guardians: [GUARDIAN, { ...GUARDIAN, id: 'g2', name: '王媽媽', is_primary: false }] }),
              ])
          }),
      )
    const { wrapper } = await mountPanel()

    await clickTab(wrapper, '監護人')
    expect(stubProps(wrapper, 'GuardianManager')).toMatchObject({
      studentId: 's1',
      studentName: '王小明',
      initial: [{ id: 'g1', name: '王大明' }],
      readonly: false,
    })
    expect(stubMounts.GuardianManager).toBe(1)

    wrapper.findComponent({ name: 'GuardianManager' }).vm.$emit('change')
    await settle()

    // 重抓回應前：不顯示骨架、監護人元件沒有被卸載重掛（綁定碼 dialog 在 GuardianManager 裡，只顯示一次）
    expect(detailGets()).toBe(2)
    expect(wrapper.find('.el-skeleton').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'GuardianManager' }).exists()).toBe(true)
    expect(stubMounts.GuardianManager).toBe(1)

    releaseReload?.()
    await settle()

    expect(detailGets()).toBe(2)
    expect(tabTitles(wrapper)).toContain('監護人（2）')
    expect(stubMounts.GuardianManager).toBe(1)
  })

  it('StudentDetailPanel guardians readonly when archived', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail({ archived_at: '2026-09-01T02:00:00Z' }))
    const { wrapper } = await mountPanel({ initialRoute: '/students?student=s1&tab=guardians' })

    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('監護人（1）')
    expect(stubProps(wrapper, 'GuardianManager').readonly).toBe(true)
  })

  it('StudentDetailPanel shows exam tab only with exams:read', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const without = await mountPanel({ permissions: ['students:read'] })
    expect(tabTitles(without.wrapper)).toEqual(['基本資料', '監護人（1）'])
    expect(tabTitles(without.wrapper)).not.toContain('成績紀錄')
    without.wrapper.unmount()
    document.body.innerHTML = ''

    const withExams = await mountPanel({ permissions: ['students:read', 'exams:read'] })
    expect(tabTitles(withExams.wrapper)).toContain('成績紀錄')
    // 成績紀錄分頁沒切到前不掛載（避免多發請求）
    expect(withExams.wrapper.findComponent({ name: 'StudentExamHistoryTab' }).exists()).toBe(false)
    await clickTab(withExams.wrapper, '成績紀錄')
    expect(stubProps(withExams.wrapper, 'StudentExamHistoryTab')).toEqual({ studentId: 's1' })
  })

  it('StudentDetailPanel syncs tab with query', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const { wrapper, router } = await mountPanel()

    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('基本資料')
    await clickTab(wrapper, '監護人')
    expect(router.currentRoute.value.query).toMatchObject({ student: 's1', tab: 'guardians' })

    await router.push('/students?student=s1&tab=exams')
    await settle()
    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('成績紀錄')
  })

  it('StudentDetailPanel falls back to basic tab without exam permission', async () => {
    mock.onGet('/admin/students/s1').reply(200, detail())
    const { wrapper } = await mountPanel({
      permissions: ['students:read'],
      initialRoute: '/students?student=s1&tab=exams',
    })

    expect(wrapper.find('.el-tabs__item.is-active').text()).toBe('基本資料')
  })

  it('StudentDetailPanel ignores stale responses when switching', async () => {
    let releaseS1: (() => void) | undefined
    mock.onGet('/admin/students/s1').reply(
      () =>
        new Promise((resolve) => {
          releaseS1 = () => resolve([200, detail()])
        }),
    )
    mock.onGet('/admin/students/s2').reply(200, detail({ id: 's2', student_no: 'S1002', name: '陳小美' }))
    const { wrapper } = await mountPanel()
    expect(wrapper.find('.el-skeleton').exists()).toBe(true)

    await wrapper.setProps({ studentId: 's2' })
    await settle()
    expect(wrapper.find('.detail-head h2').text()).toContain('陳小美')

    // s1 的回應比 s2 晚到：不可蓋掉
    releaseS1?.()
    await settle()
    expect(wrapper.find('.detail-head h2').text()).toContain('陳小美')
    expect(wrapper.find('.detail-head__meta').text()).toContain('S1002')
  })

  it('StudentDetailPanel not found state', async () => {
    mock.onGet('/admin/students/s1').reply(404, {
      error: { code: 'student_not_found', message: '找不到學生', details: null },
    })
    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('找不到此學生，可能已被刪除')
    expect(wrapper.find('.detail-head').exists()).toBe(false)
  })

  it('StudentDetailPanel shows retry on load failure', async () => {
    mock
      .onGet('/admin/students/s1')
      .replyOnce(500, { error: { code: 'internal_error', message: '伺服器暫時無法回應', details: null } })
      .onGet('/admin/students/s1')
      .replyOnce(200, detail())
    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('無法載入學生資料')
    await click(wrapper, '重試')

    expect(detailGets()).toBe(2)
    expect(wrapper.find('.detail-head h2').text()).toContain('王小明')
  })

  it('StudentDetailPanel shows purge only for archived withdrawn students with permission', async () => {
    mock.onGet('/admin/students/s1').reply(200, ARCHIVED_WITHDRAWN)
    const { wrapper } = await mountPanel()

    expect(await openMoreMenu(wrapper)).toEqual(['永久刪除'])
    const item = Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')).find(
      (i) => i.textContent?.trim() === '永久刪除',
    )
    item!.click()
    await vi.advanceTimersByTimeAsync(300)
    await settle()
    expect(document.body.textContent).toContain('請輸入學號 S1001 以確認')
  })

  it('StudentDetailPanel hides purge in other cases', async () => {
    const cases: [StudentDetail, string[]][] = [
      [detail({ status: 'suspended', archived_at: '2026-09-01T02:00:00Z' }), ALL],
      [detail({ status: 'withdrawn', archived_at: null }), ALL],
      [ARCHIVED_WITHDRAWN, ALL.filter((p) => p !== 'students:purge')],
    ]
    for (const [student, permissions] of cases) {
      mock.onGet('/admin/students/s1').reply(200, student)
      const { wrapper } = await mountPanel({ permissions })
      expect(wrapper.find('[aria-label=更多操作]').exists()).toBe(false)
      expect(document.body.textContent).not.toContain('永久刪除')
      wrapper.unmount()
      document.body.innerHTML = ''
      mock.resetHandlers()
    }
  })

  it('StudentDetailPanel reloads and emits changed after purge', async () => {
    let releaseReload: (() => void) | undefined
    mock
      .onGet('/admin/students/s1')
      .replyOnce(200, ARCHIVED_WITHDRAWN)
      .onGet('/admin/students/s1')
      .replyOnce(
        () =>
          new Promise((resolve) => {
            releaseReload = () => resolve([200, { ...ARCHIVED_WITHDRAWN, name: '已刪除學生', guardians: [] }])
          }),
      )
    mock
      .onPost('/admin/students/s1/purge')
      .reply(200, { student_id: 's1', purged_at: '2026-10-16T03:00:00Z', anonymized_student_no: 'X0001' })
    const { wrapper } = await mountPanel()

    await openMoreMenu(wrapper)
    Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item'))
      .find((i) => i.textContent?.trim() === '永久刪除')!
      .click()
    await vi.advanceTimersByTimeAsync(300)
    await settle()
    const dialog = Array.from(document.body.querySelectorAll<HTMLElement>('.el-dialog')).at(-1)!
    const input = dialog.querySelector<HTMLInputElement>('input')!
    input.value = 'S1001'
    input.dispatchEvent(new Event('input'))
    await settle()
    Array.from(dialog.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.trim() === '永久刪除')!
      .click()
    await settle()
    await settle()

    expect(mock.history.post[0]?.url).toBe('/admin/students/s1/purge')
    // 重抓回應前：不顯示骨架、header 仍在
    expect(detailGets()).toBe(2)
    expect(wrapper.find('.el-skeleton').exists()).toBe(false)
    expect(wrapper.find('.detail-head h2').text()).toContain('王小明')

    releaseReload?.()
    await settle()

    expect(detailGets()).toBe(2)
    expect(wrapper.find('.detail-head h2').text()).toContain('已刪除學生')
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })
})
