import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Router } from 'vue-router'
import type { DashboardRecentLeave } from '@/api/dashboard'
import { mountWithApp } from '@/test/helpers'
import RecentLeavesList from './RecentLeavesList.vue'

const ALL_PERMS = ['dashboard:read', 'leaves:read', 'students:read']

function rl(overrides: Partial<DashboardRecentLeave> = {}): DashboardRecentLeave {
  return {
    id: 'l1',
    student_id: 's1',
    student_name: '王小明',
    class_name: '低年級A班',
    leave_type_label: '病假',
    start_date: '2026-10-02',
    end_date: '2026-10-02',
    created_by_type: 'parent',
    created_at: '2026-10-01T23:45:00Z',
    ...overrides,
  }
}

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountList(
  props: { items: DashboardRecentLeave[]; loading?: boolean },
  permissions: string[] = ALL_PERMS,
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const { wrapper, router } = await mountWithApp(RecentLeavesList, {
    props,
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
  await settle()
  return { wrapper: wrapper as VueWrapper, router }
}

function rows(wrapper: VueWrapper): DOMWrapper<Element>[] {
  return wrapper.findAll('.rl__row')
}

function viewAll(wrapper: VueWrapper): DOMWrapper<Element> | undefined {
  return wrapper.findAll('button').find((b) => b.text() === '查看全部請假')
}

describe('RecentLeavesList', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 台北 2026-10-02 09:00
    vi.setSystemTime(new Date('2026-10-02T01:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('RecentLeavesList renders rows with today tag', async () => {
    const { wrapper } = await mountList({ items: [rl()] })

    const row = rows(wrapper)[0]!
    expect(rows(wrapper)).toHaveLength(1)
    expect(row.find('.rl__student').text()).toContain('王小明')
    expect(row.find('.rl__class').text()).toBe('低年級A班')
    const tags = row.findAll('.el-tag').map((t) => t.text())
    expect(tags).toEqual(['病假', '今天'])
    expect(row.find('.rl__period').text()).toBe('2026-10-02今天')
    expect(row.find('.rl__meta').text()).toBe('家長申請・2026/10/02 07:45')
  })

  it('RecentLeavesList renders rows with today tag: ranges, staff and unassigned class', async () => {
    const { wrapper } = await mountList({
      items: [
        rl({ id: 'l2', start_date: '2026-09-30', end_date: '2026-10-03', created_by_type: 'staff' }),
        rl({ id: 'l3', student_name: '王語晴', class_name: null, start_date: '2026-10-05', end_date: '2026-10-06' }),
      ],
    })

    const [started, future] = rows(wrapper)
    expect(started!.find('.rl__period').text()).toBe('2026-09-30~2026-10-03今天')
    expect(started!.find('.rl__meta').text()).toBe('員工代登記・2026/10/02 07:45')
    expect(future!.find('.rl__period').text()).toBe('2026-10-05~2026-10-06')
    expect(future!.find('.rl__class').text()).toBe('未分班')
    // 假別不依代碼上色（回應沒有假別代碼）
    expect(future!.find('.rl__type .el-tag').classes()).toContain('el-tag--info')
  })

  it('RecentLeavesList limits to eight and links by permission', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => rl({ id: `l${i}`, student_id: `s${i}`, student_name: `學生${i}` }))
    const { wrapper, router } = await mountList({ items: ten })

    expect(rows(wrapper)).toHaveLength(8)
    expect(rows(wrapper).map((r) => r.find('.rl__student button').text())).toEqual([
      '學生0',
      '學生1',
      '學生2',
      '學生3',
      '學生4',
      '學生5',
      '學生6',
      '學生7',
    ])
    expect(wrapper.text()).not.toContain('還有')
    const link = viewAll(wrapper)
    expect(link).toBeDefined()
    await link!.trigger('click')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/leaves')

    const noLeaves = await mountList({ items: ten }, ['dashboard:read', 'students:read'])
    expect(viewAll(noLeaves.wrapper)).toBeUndefined()
  })

  it('RecentLeavesList empty state', async () => {
    const { wrapper } = await mountList({ items: [] })

    expect(wrapper.find('.empty-state').text()).toBe('近期沒有請假')
    expect(rows(wrapper)).toHaveLength(0)
    // 空清單也顯示「查看全部請假」
    expect(viewAll(wrapper)).toBeDefined()
  })

  it('RecentLeavesList links student by permission', async () => {
    const { wrapper, router } = await mountList({ items: [rl()] })

    const name = wrapper.findAll('.rl__student button').find((b) => b.text() === '王小明')
    expect(name).toBeDefined()
    await name!.trigger('click')
    await settle()
    expect(router.currentRoute.value.fullPath).toBe('/students?student=s1')

    const plain = await mountList({ items: [rl()] }, ['dashboard:read', 'leaves:read'])
    expect(plain.wrapper.find('.rl__student button').exists()).toBe(false)
    const text = plain.wrapper.find('.rl__name')
    expect(text.text()).toBe('王小明')
    await text.trigger('click')
    await settle()
    expect(plain.router.currentRoute.value.fullPath).toBe('/')
  })

  it('RecentLeavesList shows loading skeleton', async () => {
    const { wrapper } = await mountList({ items: [rl()], loading: true })

    expect(wrapper.find('.el-skeleton').exists()).toBe(true)
    expect(rows(wrapper)).toHaveLength(0)
    expect(wrapper.text()).not.toContain('近期沒有請假')
    expect(viewAll(wrapper)).toBeUndefined()

    const empty = await mountList({ items: [], loading: true })
    expect(empty.wrapper.find('.el-skeleton').exists()).toBe(true)
    expect(empty.wrapper.text()).not.toContain('近期沒有請假')
  })
})
