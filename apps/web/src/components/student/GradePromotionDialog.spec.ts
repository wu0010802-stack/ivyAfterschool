import { DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { PromotionItem, PromotionPreview } from '@/api/students'
import { createApiMock, mountWithApp } from '@/test/helpers'
import GradePromotionDialog from './GradePromotionDialog.vue'

const URL_PROMOTE = '/admin/students/promote-grade'

function items(count: number, grade: number, prefix: string): PromotionItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    student_no: `S${prefix}${String(i).padStart(3, '0')}`,
    name: `學生${prefix}${i}`,
    grade_from: grade,
    grade_to: grade < 6 ? grade + 1 : null,
    class_name: i === 0 ? null : '中年級班',
  }))
}

function preview(overrides: Partial<PromotionPreview> = {}): PromotionPreview {
  return {
    from_academic_year: 114,
    to_academic_year: 115,
    promote: items(80, 3, 'p'),
    graduate: items(16, 6, 'g'),
    total: 96,
    already_promoted: false,
    ...overrides,
  }
}

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountDialog(): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(GradePromotionDialog, { props: { modelValue: true } })
  await settle()
  return wrapper as VueWrapper
}

function dialogByTitle(title: string): DOMWrapper<Element> {
  const el = Array.from(document.body.querySelectorAll('.el-dialog')).find(
    (d) => d.querySelector('.el-dialog__title')?.textContent?.trim() === title,
  )
  if (!el) throw new Error(`找不到 dialog「${title}」`)
  return new DOMWrapper(el)
}

function mainDialog(): DOMWrapper<Element> {
  return dialogByTitle('學年升級')
}

function confirmDialog(): DOMWrapper<Element> {
  return dialogByTitle('確認執行學年升級')
}

function button(root: DOMWrapper<Element>, text: string): DOMWrapper<Element> {
  const btn = root.findAll('button').find((b) => b.text() === text)
  if (!btn) throw new Error(`找不到按鈕「${text}」`)
  return btn
}

function bodies(): Record<string, unknown>[] {
  return mock.history.post.map((c) => JSON.parse(c.data as string) as Record<string, unknown>)
}

async function openConfirmAndType(text: string): Promise<void> {
  await button(mainDialog(), '執行升級').trigger('click')
  await settle()
  await confirmDialog().find('input').setValue(text)
  await settle()
}

describe('GradePromotionDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-15T02:00:00Z'))
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('GradePromotionDialog previews default year', async () => {
    mock.onPost(URL_PROMOTE).reply(200, preview())
    await mountDialog()

    expect(bodies()).toEqual([{ from_academic_year: 114, dry_run: true }])
    const text = mainDialog().text()
    expect(text).toContain('114 → 115 學年度：升級 80 位、六年級轉退班 16 位')
    expect(text).toContain('升級不會變更安親班班級，請於升級後到學生工作台調整')
    expect(mainDialog().findAll('.el-tabs__item').map((t) => t.text())).toEqual(['升級（80）', '六年級轉退班（16）'])
    const firstRow = mainDialog().find('.el-table__body tr.el-table__row')
    expect(firstRow.findAll('td').map((td) => td.text())).toEqual(['Sp000', '學生p0', '三年級 → 四年級', '—'])
    expect(button(mainDialog(), '執行升級').attributes('disabled')).toBeUndefined()
  })

  it('GradePromotionDialog requires typed confirmation and sends expected total', async () => {
    mock.onPost(URL_PROMOTE).replyOnce(200, preview()).onPost(URL_PROMOTE).replyOnce(200, { promoted: 80, graduated: 16 })
    const wrapper = await mountDialog()

    await openConfirmAndType('確認')
    expect(confirmDialog().text()).toContain('將升級 80 位、六年級轉退班 16 位，此操作無法復原。請輸入「確認升級」以執行。')
    expect(button(confirmDialog(), '確定').attributes('disabled')).toBeDefined()

    await confirmDialog().find('input').setValue('確認升級')
    await settle()
    expect(button(confirmDialog(), '確定').attributes('disabled')).toBeUndefined()
    await button(confirmDialog(), '確定').trigger('click')
    await settle()

    expect(bodies()[1]).toEqual({
      from_academic_year: 114,
      dry_run: false,
      expected_total: 96,
      withdrawn_on: '2026-08-15',
    })
    expect(document.body.textContent).toContain('已升級 80 位、退班 16 位')
    expect(wrapper.emitted('promoted')?.[0]).toEqual([{ promoted: 80, graduated: 16 }])
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false])
  })

  it('GradePromotionDialog cancel confirmation sends nothing', async () => {
    mock.onPost(URL_PROMOTE).reply(200, preview())
    await mountDialog()

    await openConfirmAndType('確認升級')
    await button(confirmDialog(), '取消').trigger('click')
    await settle()

    expect(bodies()).toHaveLength(1)
  })

  it('GradePromotionDialog disables execute when already promoted', async () => {
    mock.onPost(URL_PROMOTE).reply(200, preview({ already_promoted: true }))
    await mountDialog()

    expect(mainDialog().text()).toContain('此學年度已執行過升級')
    expect(button(mainDialog(), '執行升級').attributes('disabled')).toBeDefined()
  })

  it('GradePromotionDialog re-previews on stale preview', async () => {
    mock
      .onPost(URL_PROMOTE)
      .replyOnce(200, preview())
      .onPost(URL_PROMOTE)
      .replyOnce(409, {
        error: { code: 'preview_stale', message: '名單已變動', details: { expected_total: 96, total: 97 } },
      })
      .onPost(URL_PROMOTE)
      .replyOnce(200, preview({ promote: items(81, 3, 'p'), total: 97 }))
    const wrapper = await mountDialog()

    await openConfirmAndType('確認升級')
    await button(confirmDialog(), '確定').trigger('click')
    await settle()

    expect(mainDialog().text()).toContain('名單在預覽後有變動，已重新預覽，請再次確認')
    expect(bodies()).toHaveLength(3)
    expect(bodies()[2]).toEqual({ from_academic_year: 114, dry_run: true })
    expect(mainDialog().text()).toContain('升級 81 位')
    expect(wrapper.emitted('promoted')).toBeUndefined()
  })

  it('GradePromotionDialog re-previews when already promoted on execute', async () => {
    mock
      .onPost(URL_PROMOTE)
      .replyOnce(200, preview())
      .onPost(URL_PROMOTE)
      .replyOnce(409, { error: { code: 'already_promoted', message: '114 學年度已執行過升級' } })
      .onPost(URL_PROMOTE)
      .replyOnce(200, preview({ already_promoted: true }))
    await mountDialog()

    await openConfirmAndType('確認升級')
    await button(confirmDialog(), '確定').trigger('click')
    await settle()

    expect(document.body.textContent).toContain('114 學年度已執行過升級')
    expect(bodies()).toHaveLength(3)
    expect(bodies()[2]).toEqual({ from_academic_year: 114, dry_run: true })
    expect(button(mainDialog(), '執行升級').attributes('disabled')).toBeDefined()
  })

  it('GradePromotionDialog re-previews when year changes', async () => {
    mock.onPost(URL_PROMOTE).reply((config) => {
      const year = (JSON.parse(config.data as string) as { from_academic_year: number }).from_academic_year
      return [200, preview({ from_academic_year: year, to_academic_year: year + 1 })]
    })
    await mountDialog()

    const select = mainDialog().find('.el-select__wrapper')
    await select.trigger('click')
    await settle()
    const listId = mainDialog().find('.el-select input').attributes('aria-controls')
    const option = Array.from(document.getElementById(listId!)?.querySelectorAll<HTMLElement>('.el-select-dropdown__item') ?? []).find(
      (o) => o.textContent?.trim() === '113 學年度',
    )
    option?.click()
    await settle()

    expect(bodies().at(-1)).toEqual({ from_academic_year: 113, dry_run: true })
    expect(mainDialog().text()).toContain('113 → 114 學年度')
  })

  it('GradePromotionDialog shows preview failure', async () => {
    mock.onPost(URL_PROMOTE).reply(500, { error: { code: 'internal_error', message: '伺服器忙碌中' } })
    await mountDialog()

    expect(mainDialog().text()).toContain('伺服器忙碌中')
    expect(button(mainDialog(), '執行升級').attributes('disabled')).toBeDefined()
  })
})
