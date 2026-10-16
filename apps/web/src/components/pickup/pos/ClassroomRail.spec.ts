import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { RailItem } from '@/composables/useDismissalRoster'
import { mountWithApp } from '@/test/helpers'
import railSource from './ClassroomRail.vue?raw'
import ClassroomRail from './ClassroomRail.vue'

const ITEMS: RailItem[] = [
  { key: 'all', classId: null, label: '全部班級', total: 40, openCount: 3, arrivedCount: 1 },
  { key: 'c1', classId: 'c1', label: '低年級A班', total: 18, openCount: 2, arrivedCount: 1 },
  { key: 'c2', classId: 'c2', label: '高年級B班', total: 12, openCount: 1, arrivedCount: 0 },
  { key: 'c3', classId: 'c3', label: '中年級', total: 10, openCount: 0, arrivedCount: 0 },
]

async function mountRail(selectedKey = 'all', items: RailItem[] = ITEMS): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(ClassroomRail, { props: { items, selectedKey } })
  return wrapper as VueWrapper
}

function itemByLabel(wrapper: VueWrapper, label: string): DOMWrapper<Element> {
  const item = wrapper.findAll('.rail__item').find((b) => b.find('.rail__name').text() === label)
  if (!item) throw new Error(`找不到班級「${label}」`)
  return item
}

describe('ClassroomRail', () => {
  it('ClassroomRail renders badges by urgency', async () => {
    const wrapper = await mountRail()

    const c1 = itemByLabel(wrapper, '低年級A班')
    expect(c1.text()).toContain('18 人')
    expect(c1.text()).toContain('1 已到')
    expect(c1.text()).not.toContain('接送中')
    expect(c1.find('.rail__badge').classes()).toContain('is-danger')

    const c2 = itemByLabel(wrapper, '高年級B班')
    expect(c2.text()).toContain('12 人')
    expect(c2.text()).toContain('1 接送中')
    expect(c2.find('.rail__badge').classes()).toContain('is-warning')
    expect(c2.find('.rail__badge').classes()).not.toContain('is-danger')

    const c3 = itemByLabel(wrapper, '中年級')
    expect(c3.text()).toContain('10 人')
    expect(c3.find('.rail__badge').exists()).toBe(false)
  })

  it('ClassroomRail emits selection and marks active', async () => {
    const wrapper = await mountRail('all')

    const all = itemByLabel(wrapper, '全部班級')
    expect(all.attributes('aria-current')).toBe('true')
    expect(all.classes()).toContain('is-active')
    expect(itemByLabel(wrapper, '高年級B班').attributes('aria-current')).toBeUndefined()
    expect(itemByLabel(wrapper, '高年級B班').classes()).not.toContain('is-active')

    await itemByLabel(wrapper, '高年級B班').trigger('click')
    expect(wrapper.emitted('update:selectedKey')?.[0]).toEqual(['c2'])

    // 選中狀態完全由 prop 決定，元件不自己記
    expect(itemByLabel(wrapper, '高年級B班').attributes('aria-current')).toBeUndefined()
    await wrapper.setProps({ selectedKey: 'c2' })
    expect(itemByLabel(wrapper, '高年級B班').attributes('aria-current')).toBe('true')
    expect(itemByLabel(wrapper, '全部班級').attributes('aria-current')).toBeUndefined()
  })

  it('ClassroomRail moves selection with arrow keys', async () => {
    const wrapper = await mountRail('c1')

    await itemByLabel(wrapper, '低年級A班').trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('update:selectedKey')?.[0]).toEqual(['c2'])

    await itemByLabel(wrapper, '低年級A班').trigger('keydown', { key: 'ArrowUp' })
    expect(wrapper.emitted('update:selectedKey')?.[1]).toEqual(['all'])

    // 第一項再往上不動、最後一項再往下不動
    const top = await mountRail('all')
    await itemByLabel(top, '全部班級').trigger('keydown', { key: 'ArrowUp' })
    expect(top.emitted('update:selectedKey')).toBeUndefined()
    const bottom = await mountRail('c3')
    await itemByLabel(bottom, '中年級').trigger('keydown', { key: 'ArrowDown' })
    expect(bottom.emitted('update:selectedKey')).toBeUndefined()
  })

  it('ClassroomRail keeps touch height at least 56px', async () => {
    const wrapper = await mountRail()
    expect(wrapper.find('nav').attributes('aria-label')).toBe('班級列表')
    expect(wrapper.findAll('button.rail__item')).toHaveLength(4)
    // happy-dom 不計算版面：以原始碼斷言觸控高度規則
    expect(railSource).toMatch(/\.rail__item\s*{[^}]*min-height:\s*56px/)
  })
})
