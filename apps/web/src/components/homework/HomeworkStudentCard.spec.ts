import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { BoardStudent, HomeworkItem, Progress } from '@/api/homework'
import { mountWithApp } from '@/test/helpers'
import cardSource from './HomeworkStudentCard.vue?raw'
import HomeworkStudentCard from './HomeworkStudentCard.vue'

function makeItem(overrides: Partial<HomeworkItem> = {}): HomeworkItem {
  return {
    id: 'h1',
    student_id: 's1',
    service_date: '2026-10-02',
    subject_id: 'sub2',
    subject_name: '數學',
    title: '數學習作 p.12',
    status: 'doing',
    sort_order: 1,
    updated_at: '2026-10-02T07:00:00Z',
    ...overrides,
  }
}

function makeProgress(overrides: Partial<Progress> = {}): Progress {
  return {
    student_id: 's1',
    service_date: '2026-10-02',
    overall_status: 'in_progress',
    ready_eta: '17:30',
    note: '數學訂正中，預計 17:30 完成',
    eta_updated_at: null,
    eta_updated_by_name: null,
    ...overrides,
  }
}

function makeStudent(overrides: Partial<BoardStudent> = {}): BoardStudent {
  return {
    student_id: 's1',
    student_no: 'S11301',
    name: '王小明',
    class_id: 'c1',
    class_name: '低年級A班',
    attendance_status: 'present',
    items: [makeItem()],
    progress: makeProgress(),
    ...overrides,
  }
}

interface CardProps {
  canWrite?: boolean
  isToday?: boolean
  pendingItemIds?: ReadonlySet<string>
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountCard(student: BoardStudent, props: CardProps = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(HomeworkStudentCard, {
    props: { student, canWrite: true, isToday: true, pendingItemIds: new Set<string>(), ...props },
  })
  return wrapper as VueWrapper
}

function menuButton(wrapper: VueWrapper) {
  return wrapper.find('button[aria-label="王小明 的選項"]')
}

/** 卡片自己的 ⋮ 選單項目（項目列也各有 ⋮，以觸發鈕的 aria-controls 找對應選單） */
async function openMenu(wrapper: VueWrapper): Promise<HTMLElement[]> {
  const more = menuButton(wrapper)
  await more.trigger('click')
  await settle()
  const menu = document.getElementById(more.attributes('aria-controls') ?? '')
  if (!menu) throw new Error('找不到卡片選單')
  return Array.from(menu.querySelectorAll<HTMLElement>('.el-dropdown-menu__item'))
}

function labels(items: HTMLElement[]): string[] {
  return items.map((el) => el.textContent?.trim() ?? '')
}

async function clickMenu(wrapper: VueWrapper, label: string): Promise<void> {
  const item = (await openMenu(wrapper)).find((el) => el.textContent?.trim() === label)
  if (!item) throw new Error(`選單沒有「${label}」`)
  item.click()
  await settle()
}

describe('HomeworkStudentCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('HomeworkStudentCard shows overall status and eta', async () => {
    const wrapper = await mountCard(makeStudent())
    expect(wrapper.text()).toContain('王小明')
    expect(wrapper.text()).toContain('S11301・低年級A班')
    expect(wrapper.text()).toContain('進行中')
    expect(wrapper.text()).toContain('預計 17:30 可接送')
    expect(wrapper.text()).toContain('數學訂正中，預計 17:30 完成')
    expect(wrapper.text()).not.toContain('尚未設定預計時間')
    // present 不顯示出勤 chip
    expect(wrapper.text()).not.toContain('已到班')

    const unset = await mountCard(makeStudent({ progress: makeProgress({ ready_eta: null, note: null }) }))
    expect(unset.text()).toContain('尚未設定預計時間')
    expect(unset.text()).not.toContain('預計 17:30 可接送')
    expect(unset.find('.hw-card__eta-note').exists()).toBe(false)
  })

  it('HomeworkStudentCard emits menu actions', async () => {
    const wrapper = await mountCard(makeStudent())
    expect(labels(await openMenu(wrapper))).toEqual(['設定預計可接送時間', '標記整體完成'])

    await clickMenu(wrapper, '設定預計可接送時間')
    expect(wrapper.emitted('edit-eta')).toHaveLength(1)
    expect((wrapper.emitted('edit-eta') as [BoardStudent][])[0]?.[0].student_id).toBe('s1')

    await clickMenu(wrapper, '標記整體完成')
    const setOverall = wrapper.emitted('set-overall') as [BoardStudent, string][]
    expect(setOverall).toHaveLength(1)
    expect(setOverall[0]?.[0].student_id).toBe('s1')
    expect(setOverall[0]?.[1]).toBe('done')
  })

  it('HomeworkStudentCard offers revert for manual done', async () => {
    const manual = await mountCard(
      makeStudent({
        items: [makeItem({ id: 'h1', status: 'done' }), makeItem({ id: 'h2', status: 'todo', sort_order: 2 })],
        progress: makeProgress({ overall_status: 'done' }),
      }),
    )
    expect(manual.text()).toContain('手動標記')
    const items = await openMenu(manual)
    expect(labels(items)).toContain('改回依項目判斷')
    expect(labels(items)).not.toContain('標記整體完成')
    items.find((el) => el.textContent?.trim() === '改回依項目判斷')?.click()
    await settle()
    expect((manual.emitted('set-overall') as [BoardStudent, string][])[0]?.[1]).toBe('auto')
    manual.unmount()
    document.body.innerHTML = ''

    // 沒有任何項目卻被標 done 也算手動標記
    const empty = await mountCard(makeStudent({ items: [], progress: makeProgress({ overall_status: 'done' }) }))
    expect(empty.text()).toContain('手動標記')
    expect(labels(await openMenu(empty))).toContain('改回依項目判斷')
    empty.unmount()
    document.body.innerHTML = ''

    // 項目全部完成推導出 done：不是手動標記
    const auto = await mountCard(
      makeStudent({
        items: [makeItem({ id: 'h1', status: 'done' }), makeItem({ id: 'h2', status: 'done', sort_order: 2 })],
        progress: makeProgress({ overall_status: 'done' }),
      }),
    )
    expect(auto.text()).not.toContain('手動標記')
    expect(labels(await openMenu(auto))).toEqual(['設定預計可接送時間'])
  })

  it('HomeworkStudentCard hides eta action on other dates', async () => {
    const doneStudent = makeStudent({
      items: [makeItem({ status: 'done' })],
      progress: makeProgress({ overall_status: 'done' }),
    })
    const today = await mountCard(doneStudent)
    expect(today.find('.hw-card__ready').text()).toBe('可接送')
    expect(today.classes()).toContain('is-ready')
    today.unmount()
    document.body.innerHTML = ''

    const otherDay = await mountCard(doneStudent, { isToday: false })
    expect(otherDay.find('.hw-card__ready').exists()).toBe(false)
    expect(otherDay.classes()).not.toContain('is-ready')
    otherDay.unmount()
    document.body.innerHTML = ''

    const otherDayOpen = await mountCard(makeStudent(), { isToday: false })
    expect(labels(await openMenu(otherDayOpen))).toEqual(['標記整體完成'])

    // 非 done 不顯示徽章
    const inProgress = await mountCard(makeStudent())
    expect(inProgress.find('.hw-card__ready').exists()).toBe(false)
  })

  it('HomeworkStudentCard hides menu when no actions apply', async () => {
    // 非今天、項目全部完成推導出 done（非手動標記）：三個選項都不適用 → 不渲染 ⋮
    const wrapper = await mountCard(
      makeStudent({
        items: [makeItem({ id: 'h1', status: 'done' }), makeItem({ id: 'h2', status: 'done', sort_order: 2 })],
        progress: makeProgress({ overall_status: 'done' }),
      }),
      { isToday: false },
    )
    expect(wrapper.text()).not.toContain('手動標記')
    expect(menuButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('.hw-card__head .el-dropdown').exists()).toBe(false)
    // 仍可寫：「＋ 新增作業」照常顯示
    expect(wrapper.text()).toContain('新增作業')
  })

  it('HomeworkStudentCard keeps menu when an action applies', async () => {
    const wrapper = await mountCard(makeStudent(), { isToday: false })
    expect(menuButton(wrapper).exists()).toBe(true)
    expect(labels(await openMenu(wrapper))).toEqual(['標記整體完成'])
  })

  it('HomeworkStudentCard keeps menu when an action applies: manual done on past day', async () => {
    const wrapper = await mountCard(
      makeStudent({
        items: [makeItem({ id: 'h1', status: 'done' }), makeItem({ id: 'h2', status: 'todo', sort_order: 2 })],
        progress: makeProgress({ overall_status: 'done' }),
      }),
      { isToday: false },
    )
    expect(wrapper.text()).toContain('手動標記')
    expect(menuButton(wrapper).exists()).toBe(true)
    expect(labels(await openMenu(wrapper))).toEqual(['改回依項目判斷'])
  })

  it('HomeworkStudentCard dims leave students and empty items', async () => {
    const leave = await mountCard(makeStudent({ attendance_status: 'leave' }))
    expect(leave.classes()).toContain('is-dimmed')
    expect(leave.text()).toContain('請假')

    const absent = await mountCard(makeStudent({ attendance_status: 'absent' }))
    expect(absent.classes()).toContain('is-dimmed')
    expect(absent.text()).toContain('缺席')

    // 已離班、預計到班：顯示 chip 但不淡化
    const left = await mountCard(makeStudent({ attendance_status: 'left' }))
    expect(left.text()).toContain('已離班')
    expect(left.classes()).not.toContain('is-dimmed')
    const expected = await mountCard(makeStudent({ attendance_status: 'expected' }))
    expect(expected.text()).toContain('預計到班')
    expect(expected.classes()).not.toContain('is-dimmed')

    const present = await mountCard(makeStudent())
    expect(present.classes()).not.toContain('is-dimmed')

    const noItems = await mountCard(makeStudent({ items: [] }))
    expect(noItems.text()).toContain('今天沒有作業項目')
    expect(noItems.findAll('.hw-item')).toHaveLength(0)
  })

  it('HomeworkStudentCard readonly hides write actions', async () => {
    const wrapper = await mountCard(makeStudent(), { canWrite: false })
    expect(wrapper.text()).not.toContain('新增作業')
    expect(menuButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('.hw-card__head .el-dropdown').exists()).toBe(false)
    // 項目列也唯讀：四段切換停用
    expect(wrapper.findAll('.hw-seg__btn').every((b) => b.attributes('disabled') !== undefined)).toBe(true)
  })

  it('HomeworkStudentCard eta row opens dialog when writable today', async () => {
    const wrapper = await mountCard(makeStudent())
    const row = wrapper.find('[aria-label="設定 王小明 的預計可接送時間"]')
    expect(row.element.tagName).toBe('BUTTON')
    expect(row.attributes('type')).toBe('button')
    await row.trigger('click')
    expect((wrapper.emitted('edit-eta') as [BoardStudent][])[0]?.[0].student_id).toBe('s1')

    for (const props of [{ isToday: false }, { canWrite: false }]) {
      const plain = await mountCard(makeStudent(), props)
      expect(plain.find('[aria-label="設定 王小明 的預計可接送時間"]').exists()).toBe(false)
      expect(plain.find('.hw-card__eta').element.tagName).toBe('DIV')
      await plain.find('.hw-card__eta').trigger('click')
      expect(plain.emitted('edit-eta')).toBeUndefined()
    }
  })

  it('HomeworkStudentCard forwards item row events in sort order', async () => {
    const h1 = makeItem({ id: 'h1', title: '國語習作', subject_name: '國語', status: 'todo', sort_order: 2 })
    const h2 = makeItem({ id: 'h2', title: '數學習作 p.12', status: 'doing', sort_order: 1 })
    const wrapper = await mountCard(makeStudent({ items: [h1, h2] }), { pendingItemIds: new Set(['h1']) })

    expect(wrapper.findAll('.hw-item__title').map((t) => t.text())).toEqual(['數學習作 p.12', '國語習作'])
    // pending 只在 h1（第二列）顯示轉圈
    const rows = wrapper.findAll('.hw-item')
    expect(rows[0]?.find('[aria-label="儲存中"]').exists()).toBe(false)
    expect(rows[1]?.find('[aria-label="儲存中"]').exists()).toBe(true)

    const doneBtn = rows[1]?.findAll('.hw-seg__btn').find((b) => b.text() === '完成')
    await doneBtn?.trigger('click')
    const setStatus = wrapper.emitted('set-status') as [HomeworkItem, string][]
    expect(setStatus[0]?.[0].id).toBe('h1')
    expect(setStatus[0]?.[1]).toBe('done')

    // 項目列的 ⋮：編輯 / 刪除
    const rowMore = rows[0]!.find('button[aria-label="作業選項"]')
    await rowMore.trigger('click')
    await settle()
    const rowMenu = document.getElementById(rowMore.attributes('aria-controls') ?? '')
    const rowItems = Array.from(rowMenu?.querySelectorAll<HTMLElement>('.el-dropdown-menu__item') ?? [])
    rowItems.find((el) => el.textContent?.trim() === '編輯')?.click()
    await settle()
    expect((wrapper.emitted('edit-item') as [HomeworkItem][])[0]?.[0].id).toBe('h2')
    rowItems.find((el) => el.textContent?.trim() === '刪除')?.click()
    await settle()
    expect((wrapper.emitted('remove-item') as [HomeworkItem][])[0]?.[0].id).toBe('h2')

    const add = wrapper.findAll('button').find((b) => b.text().includes('新增作業'))
    await add?.trigger('click')
    expect((wrapper.emitted('add-item') as [BoardStudent][])[0]?.[0].student_id).toBe('s1')
  })

  it('HomeworkStudentCard keeps touch targets', async () => {
    // happy-dom 不計算版面：以原始碼斷言 ⋮ 44×44、預計可接送列與「＋ 新增作業」高 ≥ 44px、淡化 55%
    expect(cardSource).toMatch(/\.hw-card__menu\s*{[^}]*width:\s*44px/)
    expect(cardSource).toMatch(/\.hw-card__menu\s*{[^}]*height:\s*44px/)
    expect(cardSource).toMatch(/\.hw-card__eta\.is-button\s*{[^}]*min-height:\s*44px/)
    expect(cardSource).toMatch(/\.hw-card__add\s*{[^}]*height:\s*44px/)
    expect(cardSource).toMatch(/\.hw-card\.is-dimmed\s*{[^}]*opacity:\s*0?\.55/)
    const wrapper = await mountCard(makeStudent())
    expect(wrapper.element.tagName).toBe('ARTICLE')
  })
})
