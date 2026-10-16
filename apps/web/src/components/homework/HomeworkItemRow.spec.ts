import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { HomeworkItem } from '@/api/homework'
import { mountWithApp } from '@/test/helpers'
import rowSource from './HomeworkItemRow.vue?raw'
import HomeworkItemRow from './HomeworkItemRow.vue'

function makeItem(overrides: Partial<HomeworkItem> = {}): HomeworkItem {
  return {
    id: 'h1',
    student_id: 's1',
    service_date: '2026-10-02',
    subject_id: 'sub-math',
    subject_name: '數學',
    title: '數學習作 p.12-13',
    status: 'todo',
    sort_order: 1,
    updated_at: '2026-10-02T06:00:00Z',
    ...overrides,
  }
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountRow(item: HomeworkItem, props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(HomeworkItemRow, { props: { item, canWrite: true, pending: false, ...props } })
  return wrapper as VueWrapper
}

/** 掛到 document 上：click 才會沿路冒泡到 window（Element Plus 下拉的「點外面就收起」掛在 window） */
async function mountAttachedRow(item: HomeworkItem, props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const wrapper = await mountRow(item, props)
  document.body.appendChild(wrapper.element)
  return wrapper
}

function segments(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('[role=radio]')
}

function segment(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const found = segments(wrapper).find((s) => s.text() === label)
  if (!found) throw new Error(`找不到狀態段「${label}」`)
  return found
}

function menuButton(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find('button[aria-label="作業選項"]')
}

function menuItem(label: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>('.el-dropdown-menu__item')).find(
    (el) => el.textContent?.trim() === label,
  )
}

/** 選單是否開著：⋮ 的 aria-expanded 隨開關即時更新（不必等 happy-dom 不會結束的關閉動畫） */
function menuOpen(wrapper: VueWrapper): boolean {
  return menuButton(wrapper).attributes('aria-expanded') === 'true'
}

/** 長按：在 target 上 pointerdown，推進 ms 毫秒 */
async function press(target: DOMWrapper<Element>, ms: number): Promise<void> {
  await target.trigger('pointerdown')
  vi.advanceTimersByTime(ms)
  await settle()
}

describe('HomeworkItemRow', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('HomeworkItemRow renders subject title and status', async () => {
    const wrapper = await mountRow(makeItem({ subject_name: '數學', title: '數學習作 p.12-13', status: 'correcting' }))

    expect(wrapper.text()).toContain('數學')
    expect(wrapper.find('.hw-item__title').text()).toBe('數學習作 p.12-13')
    expect(segments(wrapper).map((s) => s.text())).toEqual(['未開始', '進行中', '訂正中', '完成'])
    expect(segment(wrapper, '訂正中').attributes('aria-checked')).toBe('true')
    expect(segment(wrapper, '訂正中').classes()).toEqual(expect.arrayContaining(['is-active', 'tone-danger']))
    expect(segment(wrapper, '未開始').attributes('aria-checked')).toBe('false')
    expect(segment(wrapper, '未開始').classes()).not.toContain('is-active')

    // 無科目不顯示科目 tag
    const noSubject = await mountRow(makeItem({ subject_id: null, subject_name: null, title: '閱讀心得' }))
    expect(noSubject.find('.el-tag').exists()).toBe(false)
  })

  it('HomeworkItemRow emits only on status change', async () => {
    const wrapper = await mountRow(makeItem({ status: 'todo' }))

    await segment(wrapper, '完成').trigger('click')
    expect(wrapper.emitted('set-status')?.[0]).toEqual(['done'])

    await segment(wrapper, '未開始').trigger('click')
    expect(wrapper.emitted('set-status')).toHaveLength(1)
  })

  it('HomeworkItemRow readonly disables segments', async () => {
    const wrapper = await mountRow(makeItem({ status: 'doing' }), { canWrite: false })

    expect(segments(wrapper)).toHaveLength(4)
    for (const s of segments(wrapper)) expect(s.attributes('disabled')).toBeDefined()
    // 唯讀仍以色塊顯示目前狀態
    expect(segment(wrapper, '進行中').classes()).toContain('is-active')
    expect(menuButton(wrapper).exists()).toBe(false)
    await segment(wrapper, '完成').trigger('click')
    expect(wrapper.emitted('set-status')).toBeUndefined()
  })

  it('HomeworkItemRow edit and remove via menu', async () => {
    const wrapper = await mountRow(makeItem())

    await menuButton(wrapper).trigger('click')
    await settle()
    menuItem('刪除')?.click()
    await settle()
    expect(wrapper.emitted('remove')).toHaveLength(1)

    await menuButton(wrapper).trigger('click')
    await settle()
    menuItem('編輯')?.click()
    await settle()
    expect(wrapper.emitted('edit')).toHaveLength(1)
    expect(wrapper.emitted('remove')).toHaveLength(1)
  })

  it('HomeworkItemRow pending shows spinner and stays clickable', async () => {
    const wrapper = await mountRow(makeItem({ status: 'doing' }), { pending: true })

    expect(wrapper.find('[aria-label="儲存中"]').exists()).toBe(true)
    expect(segment(wrapper, '完成').attributes('disabled')).toBeUndefined()
    await segment(wrapper, '完成').trigger('click')
    expect(wrapper.emitted('set-status')?.[0]).toEqual(['done'])

    const idle = await mountRow(makeItem({ status: 'doing' }))
    expect(idle.find('[aria-label="儲存中"]').exists()).toBe(false)
  })

  it('HomeworkItemRow long press opens menu', async () => {
    vi.useFakeTimers()
    const wrapper = await mountAttachedRow(makeItem({ status: 'todo' }))
    const row = wrapper.find('.hw-item')

    // 短按不開選單
    await press(row, 300)
    await row.trigger('pointerup')
    vi.advanceTimersByTime(600)
    await settle()
    expect(menuOpen(wrapper)).toBe(false)

    // 在狀態段上長按 600ms：開選單，放開後的 click 不切換狀態
    await press(segment(wrapper, '完成'), 599)
    expect(menuOpen(wrapper)).toBe(false)
    vi.advanceTimersByTime(1)
    await settle()
    // Element Plus 下拉開啟有短暫延遲
    vi.advanceTimersByTime(200)
    await settle()
    expect(menuOpen(wrapper)).toBe(true)
    await segment(wrapper, '完成').trigger('pointerup')
    await segment(wrapper, '完成').trigger('click')
    expect(wrapper.emitted('set-status')).toBeUndefined()

    // 下一次正常點擊照常切換
    await segment(wrapper, '完成').trigger('pointerdown')
    await segment(wrapper, '完成').trigger('pointerup')
    await segment(wrapper, '完成').trigger('click')
    expect(wrapper.emitted('set-status')?.[0]).toEqual(['done'])
  })

  it('HomeworkItemRow long press menu stays open after release click', async () => {
    vi.useFakeTimers()
    const wrapper = await mountAttachedRow(makeItem({ status: 'todo' }))

    await press(segment(wrapper, '進行中'), 700)
    expect(menuOpen(wrapper)).toBe(true)

    // 放開：pointerup + 冒泡到 window 的 click（Element Plus 的點外面判定在 window 捕獲階段）
    await segment(wrapper, '進行中').trigger('pointerup')
    await segment(wrapper, '進行中').trigger('click')
    vi.advanceTimersByTime(0)
    await settle()

    expect(menuOpen(wrapper)).toBe(true)
    expect(wrapper.emitted('set-status')).toBeUndefined()
    menuItem('編輯')?.click()
    await settle()
    expect(wrapper.emitted('edit')).toHaveLength(1)
  })

  it('HomeworkItemRow tap works after touch long press without click', async () => {
    vi.useFakeTimers()
    const wrapper = await mountAttachedRow(makeItem({ status: 'todo' }))

    // 觸控長按放開可能不產生 click
    await press(segment(wrapper, '進行中'), 700)
    await segment(wrapper, '進行中').trigger('pointerup')
    await settle()

    // 下一次點擊不可被吞掉
    await segment(wrapper, '完成').trigger('pointerdown')
    await segment(wrapper, '完成').trigger('pointerup')
    await segment(wrapper, '完成').trigger('click')
    expect(wrapper.emitted('set-status')?.[0]).toEqual(['done'])
  })

  it('HomeworkItemRow pointerleave cancels long press', async () => {
    vi.useFakeTimers()
    const wrapper = await mountAttachedRow(makeItem({ status: 'todo' }))
    const row = wrapper.find('.hw-item')

    await press(row, 300)
    await row.trigger('pointerleave')
    vi.advanceTimersByTime(600)
    await settle()

    expect(menuOpen(wrapper)).toBe(false)
  })

  it('HomeworkItemRow long press does nothing when readonly', async () => {
    vi.useFakeTimers()
    const wrapper = await mountRow(makeItem(), { canWrite: false })

    await wrapper.find('.hw-item').trigger('pointerdown')
    vi.advanceTimersByTime(800)
    await settle()

    expect(document.body.querySelector('.el-dropdown__popper')).toBeNull()
    expect(wrapper.emitted('edit')).toBeUndefined()
  })

  it('HomeworkItemRow keeps touch targets at least 44px', () => {
    // happy-dom 不計算版面：以原始碼斷言四段切換每段 ≥ 48×44、⋮ 44×44（實際尺寸另以 Chromium 量測）
    expect(rowSource).toMatch(/\.hw-seg__btn\s*\{[^}]*min-width:\s*48px;[^}]*height:\s*44px/)
    expect(rowSource).toMatch(/\.hw-item__menu\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/)
  })
})
