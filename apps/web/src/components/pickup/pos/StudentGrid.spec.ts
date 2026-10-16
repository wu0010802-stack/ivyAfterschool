import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { RosterClass, RosterStudent } from '@/api/pickupRequests'
import { mountWithApp } from '@/test/helpers'
import gridSource from './StudentGrid.vue?raw'
import StudentGrid from './StudentGrid.vue'

function makeStudent(overrides: Partial<RosterStudent> = {}): RosterStudent {
  return {
    student_id: 's1',
    student_no: 'S1001',
    name: '王小明',
    grade_level: 1,
    attendance_status: 'present',
    check_in_at: '2026-10-02T06:20:00Z',
    check_out_at: null,
    leave_type: null,
    homework_status: null,
    ready_eta: null,
    open_request: null,
    active_authorization_count: 0,
    ...overrides,
  }
}

const LEFT = makeStudent({ student_id: 's1', student_no: 'S1001', name: '林小華', attendance_status: 'left', check_out_at: '2026-10-02T09:00:00Z' })
const WAITING = makeStudent({ student_id: 's2', student_no: 'S1002', name: '陳小美', attendance_status: 'present' })
const ARRIVED = makeStudent({
  student_id: 's3',
  student_no: 'S1003',
  name: '張語晴',
  open_request: { id: 'r3', status: 'arrived', expected_arrival_at: null, needs_reply: false },
})
const EXPECTED = makeStudent({ student_id: 's4', student_no: 'S1004', name: '吳承翰', attendance_status: 'expected', check_in_at: null })

interface GridProps {
  students: RosterStudent[]
  rosterClasses?: RosterClass[]
  stagingIds?: ReadonlySet<string>
  canOperate?: boolean
  groupByClass?: boolean
  query?: string
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountGrid(props: GridProps): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(StudentGrid, {
    props: {
      rosterClasses: [{ class_id: 'c1', class_name: '低年級A班', students: props.students }],
      stagingIds: new Set<string>(),
      canOperate: true,
      groupByClass: false,
      query: '',
      ...props,
    },
  })
  return wrapper as VueWrapper
}

function cardNos(wrapper: VueWrapper | DOMWrapper<Element>): string[] {
  return wrapper.findAll('.scard__no').map((n) => n.text())
}

function card(wrapper: VueWrapper, studentNo: string): DOMWrapper<Element> {
  const c = wrapper.findAll('.scard').find((x) => x.find('.scard__no').text() === studentNo)
  if (!c) throw new Error(`找不到學生卡 ${studentNo}`)
  return c
}

function groupTitles(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.student-grid__group').map((g) => g.text())
}

describe('StudentGrid', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('StudentGrid sorts by pos status weight', async () => {
    const wrapper = await mountGrid({ students: [LEFT, WAITING, ARRIVED, EXPECTED] })
    expect(cardNos(wrapper)).toEqual(['S1003', 'S1002', 'S1004', 'S1001'])

    // 同權重依學號；請假與缺席同權重
    const sameWeight = await mountGrid({
      students: [
        makeStudent({ student_id: 'a', student_no: 'S2003', attendance_status: 'absent', check_in_at: null }),
        makeStudent({ student_id: 'b', student_no: 'S2002', attendance_status: 'present' }),
        makeStudent({ student_id: 'c', student_no: 'S2001', attendance_status: 'leave', leave_type: 'sick', check_in_at: null }),
        makeStudent({ student_id: 'd', student_no: 'S2000', attendance_status: 'present' }),
        makeStudent({
          student_id: 'e',
          student_no: 'S2004',
          open_request: { id: 'r9', status: 'pending', expected_arrival_at: null, needs_reply: true },
        }),
      ],
    })
    expect(cardNos(sameWeight)).toEqual(['S2004', 'S2000', 'S2002', 'S2001', 'S2003'])
    expect(sameWeight.findAll('.student-grid__group')).toHaveLength(0)
  })

  it('StudentGrid groups by class when requested', async () => {
    const a1 = makeStudent({ student_id: 'a1', student_no: 'S3002', name: '王小明', attendance_status: 'present' })
    const a2 = makeStudent({
      student_id: 'a2',
      student_no: 'S3001',
      name: '李承恩',
      attendance_status: 'left',
      check_out_at: '2026-10-02T09:00:00Z',
    })
    const b1 = makeStudent({ student_id: 'b1', student_no: 'S3101', name: '劉冠廷', attendance_status: 'expected', check_in_at: null })
    const c1 = makeStudent({ student_id: 'c1x', student_no: 'S3201', name: '周子晴' })
    const rosterClasses: RosterClass[] = [
      { class_id: 'c1', class_name: '低年級A班', students: [a1, a2] },
      { class_id: 'c2', class_name: '高年級B班', students: [b1] },
      // 被搜尋過濾掉、沒有學生的組不顯示
      { class_id: 'c3', class_name: '中年級班', students: [c1] },
    ]
    // students 是 studentsForRail 的扁平結果（順序不保證依班級）
    const wrapper = await mountGrid({ students: [b1, a2, a1], rosterClasses, groupByClass: true })

    expect(groupTitles(wrapper)).toEqual(['低年級A班（2）', '高年級B班（1）'])
    const sections = wrapper.findAll('section')
    expect(cardNos(sections[0]!)).toEqual(['S3002', 'S3001'])
    expect(cardNos(sections[1]!)).toEqual(['S3101'])

    const flat = await mountGrid({ students: [b1, a2, a1], rosterClasses, groupByClass: false })
    expect(flat.findAll('.student-grid__group')).toHaveLength(0)
    expect(cardNos(flat)).toEqual(['S3002', 'S3101', 'S3001'])
  })

  it('StudentGrid puts students without a known class under unassigned', async () => {
    const known = makeStudent({ student_id: 'k1', student_no: 'S4001' })
    const nullClass = makeStudent({ student_id: 'n1', student_no: 'S4002' })
    const orphan = makeStudent({ student_id: 'o1', student_no: 'S4003' })
    const wrapper = await mountGrid({
      students: [orphan, nullClass, known],
      rosterClasses: [
        { class_id: 'c1', class_name: '低年級A班', students: [known] },
        { class_id: null, class_name: null, students: [nullClass] },
      ],
      groupByClass: true,
    })
    expect(groupTitles(wrapper)).toEqual(['低年級A班（1）', '未分班（2）'])
    expect(cardNos(wrapper)).toEqual(['S4001', 'S4002', 'S4003'])
  })

  it('StudentGrid forwards card events', async () => {
    const wrapper = await mountGrid({ students: [LEFT, WAITING, ARRIVED, EXPECTED] })

    await card(wrapper, 'S1002').trigger('click')
    expect((wrapper.emitted('quick-dispatch') as [RosterStudent][])[0]?.[0].student_id).toBe('s2')

    await card(wrapper, 'S1003').trigger('click')
    expect(wrapper.emitted('focus-request')?.[0]).toEqual(['r3'])

    // 多張卡的 ⋮ 選單都會留在 body：以觸發鈕的 aria-controls 找到這張卡自己的選單
    const more = card(wrapper, 'S1004').find('button[aria-label="吳承翰 的選項"]')
    await more.trigger('click')
    await settle()
    const menuId = more.attributes('aria-controls')
    expect(menuId).toBeTruthy()
    const menu = document.getElementById(menuId ?? '')
    const item = Array.from(menu?.querySelectorAll<HTMLElement>('.el-dropdown-menu__item') ?? []).find(
      (el) => el.textContent?.trim() === '代建接送請求…',
    )
    expect(item?.textContent?.trim()).toBe('代建接送請求…')
    item?.click()
    await settle()
    expect((wrapper.emitted('create-request') as [RosterStudent][])[0]?.[0].student_id).toBe('s4')
    expect(wrapper.emitted('quick-dispatch')).toHaveLength(1)
  })

  it('StudentGrid passes staging and operate flags to cards', async () => {
    const staging = await mountGrid({ students: [WAITING, EXPECTED], stagingIds: new Set(['s2']) })
    expect(card(staging, 'S1002').text()).toContain('建立中…')
    expect(card(staging, 'S1004').text()).not.toContain('建立中…')
    await card(staging, 'S1002').trigger('click')
    expect(staging.emitted('quick-dispatch')).toBeUndefined()
    await card(staging, 'S1004').trigger('click')
    expect((staging.emitted('quick-dispatch') as [RosterStudent][])[0]?.[0].student_id).toBe('s4')

    const reader = await mountGrid({ students: [WAITING, ARRIVED], canOperate: false })
    await card(reader, 'S1002').trigger('click')
    expect(reader.emitted('quick-dispatch')).toBeUndefined()
    expect(reader.find('button[aria-label="陳小美 的選項"]').exists()).toBe(false)
    await card(reader, 'S1003').trigger('click')
    expect(reader.emitted('focus-request')?.[0]).toEqual(['r3'])
  })

  it('StudentGrid empty states', async () => {
    const searched = await mountGrid({ students: [], query: '王' })
    expect(searched.text()).toContain('找不到符合的學生')
    expect(searched.findAll('.scard')).toHaveLength(0)

    const blank = await mountGrid({ students: [], query: '   ', groupByClass: false })
    expect(blank.text()).toContain('此班級今天沒有學生')

    const oneClass = await mountGrid({ students: [], groupByClass: false })
    expect(oneClass.text()).toContain('此班級今天沒有學生')
    expect(oneClass.text()).not.toContain('找不到符合的學生')

    const all = await mountGrid({ students: [], groupByClass: true, rosterClasses: [] })
    expect(all.text()).toContain('目前沒有在學學生')
    expect(all.text()).not.toContain('此班級今天沒有學生')

    // 有學生時沒有空狀態
    const filled = await mountGrid({ students: [WAITING], query: '陳' })
    expect(filled.text()).not.toContain('找不到符合的學生')
  })

  it('StudentGrid lays cards out in auto-fill grid of 148px', async () => {
    // happy-dom 不計算版面：以原始碼斷言卡片最小寬 148px 的 auto-fill grid
    expect(gridSource).toMatch(/\.student-grid__cards\s*{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(148px,\s*1fr\)\)/)
    const wrapper = await mountGrid({ students: [WAITING] })
    expect(wrapper.findAll('.student-grid__cards .scard')).toHaveLength(1)
  })
})
