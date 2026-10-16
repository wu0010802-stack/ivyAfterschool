import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mountWithApp } from '@/test/helpers'
import ScoreCell from './ScoreCell.vue'

type CellProps = {
  score?: number | null
  isAbsent?: boolean
  note?: string | null
  fullScore?: number
  state?: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
  errorMessage?: string
  readonly?: boolean
}

const DEFAULT_PROPS = { score: null, isAbsent: false, note: null, fullScore: 100, state: 'idle', readonly: false } as const

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
  await nextTick()
}

async function mountCell(props: CellProps = {}) {
  const { wrapper } = await mountWithApp(ScoreCell, { props: { ...DEFAULT_PROPS, ...props } })
  return wrapper
}

/** 需要真實焦點（document.activeElement）的案例：掛到 document 上 */
async function mountAttached(props: CellProps = {}): Promise<VueWrapper> {
  const wrapper = mount(ScoreCell, { props: { ...DEFAULT_PROPS, ...props }, attachTo: document.body })
  await settle()
  return wrapper as VueWrapper
}

async function typeAndBlur(wrapper: VueWrapper, value: string): Promise<void> {
  const input = wrapper.find('input[inputmode=decimal]')
  await input.setValue(value)
  await input.trigger('blur')
}

function changes(wrapper: VueWrapper): unknown[] {
  return (wrapper.emitted('change') ?? []).map((args) => args[0])
}

async function toggleAbsent(wrapper: VueWrapper): Promise<void> {
  const checkbox = wrapper.find('.score-cell__absent input[type=checkbox]')
  await checkbox.setValue(!(checkbox.element as HTMLInputElement).checked)
}

function noteTrigger(wrapper: VueWrapper) {
  return wrapper.find('[data-test=note-trigger]')
}

/** 備註編輯框 teleport 到 body */
function noteInput(): HTMLTextAreaElement | null {
  return document.body.querySelector<HTMLTextAreaElement>('[data-test=note-input]')
}

function editorEl(): HTMLElement {
  const el = noteInput()?.closest<HTMLElement>('.note-editor')
  if (!el) throw new Error('備註編輯框沒有開啟')
  return el
}

function editorButton(text: string): HTMLButtonElement | undefined {
  return Array.from(editorEl().querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent?.trim() === text,
  )
}

async function clickEditor(text: string): Promise<void> {
  const btn = editorButton(text)
  if (!btn) throw new Error(`編輯框找不到「${text}」`)
  btn.click()
  await settle()
}

async function openEditor(wrapper: VueWrapper): Promise<void> {
  await noteTrigger(wrapper).trigger('click')
  await settle()
  if (!noteInput()) throw new Error('點圖示後編輯框沒有開啟')
}

async function typeNote(value: string): Promise<void> {
  const ta = noteInput()
  if (!ta) throw new Error('備註編輯框沒有開啟')
  ta.value = value
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

async function keydownOn(el: Element | null, init: KeyboardEventInit): Promise<void> {
  if (!el) throw new Error('沒有可以按鍵的元素')
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
  await settle()
}

async function pointerdownOn(el: Element): Promise<void> {
  el.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
  await settle()
}

async function waitTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
  await settle()
}

describe('ScoreCell', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('ScoreCell emits valid score on blur', async () => {
    const wrapper = await mountCell()

    await typeAndBlur(wrapper, '88.5')

    expect(changes(wrapper)[0]).toEqual({ score: 88.5, is_absent: false, note: null })
    const input = wrapper.find('input[inputmode=decimal]')
    expect(input.exists()).toBe(true)
  })

  it('ScoreCell rejects out of range and extra decimals', async () => {
    const wrapper = await mountCell()

    await typeAndBlur(wrapper, '105')
    expect(wrapper.attributes('title')).toContain('需介於 0~100')
    expect(wrapper.classes()).toContain('is-invalid')
    expect(wrapper.emitted('change')).toBeUndefined()

    await typeAndBlur(wrapper, '88.25')
    expect(wrapper.attributes('title')).toContain('最多一位小數')
    expect(wrapper.emitted('change')).toBeUndefined()

    // 修正後恢復
    await typeAndBlur(wrapper, '88.2')
    expect(wrapper.classes()).not.toContain('is-invalid')
    expect(changes(wrapper)).toEqual([{ score: 88.2, is_absent: false, note: null }])
  })

  it('ScoreCell commits on Enter and rejects non-numeric', async () => {
    const wrapper = await mountCell({ fullScore: 100 })
    const input = wrapper.find('input[inputmode=decimal]')

    await input.setValue('77')
    await input.trigger('keyup', { key: 'Enter' })
    expect(changes(wrapper)).toEqual([{ score: 77, is_absent: false, note: null }])

    await typeAndBlur(wrapper, 'abc')
    expect(wrapper.attributes('title')).toContain('需介於 0~100')
    expect(changes(wrapper)).toHaveLength(1)

    await wrapper.setProps({ state: 'error', errorMessage: '儲存失敗，請重試' })
    expect(wrapper.attributes('title')).toBe('需介於 0~100')
  })

  it('ScoreCell absent toggle clears score', async () => {
    const wrapper = await mountCell({ score: 60 })

    await toggleAbsent(wrapper)
    expect(changes(wrapper)[0]).toEqual({ score: null, is_absent: true, note: null })
    await wrapper.setProps({ score: null, isAbsent: true })
    const input = wrapper.find('input[inputmode=decimal]')
    expect((input.element as HTMLInputElement).disabled).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('')

    const typed = await mountCell({ score: 60 })
    await typeAndBlur(typed, '缺')
    expect(changes(typed)[0]).toEqual({ score: null, is_absent: true, note: null })

    const dash = await mountCell()
    await typeAndBlur(dash, '-')
    expect(changes(dash)[0]).toEqual({ score: null, is_absent: true, note: null })
  })

  it('ScoreCell absent uncheck and placeholder', async () => {
    const wrapper = await mountCell({ isAbsent: true })
    const input = wrapper.find('input[inputmode=decimal]')
    expect((input.element as HTMLInputElement).disabled).toBe(true)
    expect(input.attributes('placeholder')).toBe('缺考')

    await toggleAbsent(wrapper)
    expect(changes(wrapper)[0]).toEqual({ score: null, is_absent: false, note: null })
  })

  it('ScoreCell does not emit unchanged value', async () => {
    const wrapper = await mountCell({ score: 90 })

    await typeAndBlur(wrapper, '90')
    expect(wrapper.emitted('change')).toBeUndefined()

    await typeAndBlur(wrapper, '')
    expect(changes(wrapper)).toEqual([{ score: null, is_absent: false, note: null }])
  })

  it('ScoreCell state marks', async () => {
    const wrapper = await mountCell({ state: 'dirty' })
    expect(wrapper.find('[data-test=mark-dirty]').exists()).toBe(true)

    await wrapper.setProps({ state: 'saving' })
    expect(wrapper.find('[data-test=mark-saving]').exists()).toBe(true)
    expect(wrapper.find('[data-test=mark-dirty]').exists()).toBe(false)

    await wrapper.setProps({ state: 'saved' })
    expect(wrapper.find('[data-test=mark-saved]').exists()).toBe(true)

    await wrapper.setProps({ state: 'idle' })
    for (const mark of ['mark-dirty', 'mark-saving', 'mark-saved', 'mark-error']) {
      expect(wrapper.find(`[data-test=${mark}]`).exists(), mark).toBe(false)
    }
  })

  it('ScoreCell readonly display and error state', async () => {
    const readonly = await mountCell({ readonly: true, isAbsent: true })
    expect(readonly.text()).toBe('缺考')
    expect(readonly.find('input').exists()).toBe(false)

    const error = await mountCell({ score: 80, state: 'error', errorMessage: '分數超出滿分' })
    expect(error.classes()).toContain('is-error')
    expect(error.attributes('title')).toContain('分數超出滿分')
    expect(error.find('[data-test=mark-error]').exists()).toBe(true)
  })

  it('ScoreCell readonly number formatting', async () => {
    expect((await mountCell({ readonly: true, score: 90 })).text()).toBe('90')
    expect((await mountCell({ readonly: true, score: 88.5 })).text()).toBe('88.5')
    expect((await mountCell({ readonly: true, score: null })).text()).toBe('—')
  })

  it('ScoreCell note edit emits trimmed note', async () => {
    const wrapper = await mountCell({ score: 90 })
    expect(noteInput()).toBeNull()

    await openEditor(wrapper)
    expect(noteTrigger(wrapper).attributes('aria-expanded')).toBe('true')
    expect(editorEl().textContent).toContain('備註')
    expect(editorEl().textContent).toContain('家長端成績明細會顯示')
    expect(noteInput()?.getAttribute('placeholder')).toBe('例如：補考、病假、提早離開')
    expect(editorEl().textContent).toContain('0 / 200')
    // 文字框空白時沒有「清空」
    expect(editorButton('清空')).toBeUndefined()

    await typeNote('  補考  ')
    expect(editorEl().textContent).toContain('2 / 200')
    expect(editorButton('清空')).toBeDefined()
    await clickEditor('確定')

    expect(changes(wrapper).at(-1)).toEqual({ score: 90, is_absent: false, note: '補考' })
    expect(noteInput()).toBeNull()
    expect(noteTrigger(wrapper).attributes('aria-expanded')).toBe('false')

    // 文字框內 Enter 也是確定；Shift+Enter 與中文輸入法組字中的 Enter 不是
    await openEditor(wrapper)
    await typeNote('病假')
    await keydownOn(noteInput(), { key: 'Enter', shiftKey: true })
    expect(noteInput()).not.toBeNull()
    await keydownOn(noteInput(), { key: 'Enter', isComposing: true })
    expect(noteInput()).not.toBeNull()
    expect(changes(wrapper)).toHaveLength(1)
    await keydownOn(noteInput(), { key: 'Enter' })
    expect(changes(wrapper).at(-1)).toEqual({ score: 90, is_absent: false, note: '病假' })
    expect(noteInput()).toBeNull()
  })

  it('ScoreCell note clear and unchanged', async () => {
    const wrapper = await mountCell({ score: 90, note: '補考' })

    await openEditor(wrapper)
    expect(noteInput()?.value).toBe('補考')
    await clickEditor('清空')
    // 清空只清文字框、不送出
    expect(noteInput()?.value).toBe('')
    expect(wrapper.emitted('change')).toBeUndefined()
    await clickEditor('確定')
    expect(changes(wrapper)).toEqual([{ score: 90, is_absent: false, note: null }])

    // 內容不變按確定：只關閉、不 emit
    await openEditor(wrapper)
    expect(noteInput()?.value).toBe('補考')
    await clickEditor('確定')
    expect(changes(wrapper)).toHaveLength(1)
    expect(noteInput()).toBeNull()

    // 取消：還原、不 emit
    await openEditor(wrapper)
    await typeNote('改掉了')
    await clickEditor('取消')
    expect(changes(wrapper)).toHaveLength(1)
    expect(noteInput()).toBeNull()
    expect(noteTrigger(wrapper).attributes('aria-label')).toBe('備註：補考')
    await openEditor(wrapper)
    expect(noteInput()?.value).toBe('補考')
  })

  it('ScoreCell note length limit', async () => {
    const wrapper = await mountCell({ score: 90 })

    await openEditor(wrapper)
    await typeNote('字'.repeat(201))
    expect(editorEl().textContent).toContain('備註最多 200 字')
    expect(editorEl().textContent).toContain('201 / 200')
    expect(editorEl().classList.contains('is-over')).toBe(true)
    expect(editorButton('確定')?.disabled).toBe(true)
    await keydownOn(noteInput(), { key: 'Enter' })
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(noteInput()).not.toBeNull()

    // 前後空白不算；code point 計數（emoji 算一個字）
    await typeNote(`  ${'😀'.repeat(200)}  `)
    expect(editorEl().textContent).toContain('200 / 200')
    expect(editorEl().textContent).not.toContain('備註最多 200 字')
    expect(editorButton('確定')?.disabled).toBe(false)
    await clickEditor('確定')
    expect(changes(wrapper)).toEqual([{ score: 90, is_absent: false, note: '😀'.repeat(200) }])
  })

  it('ScoreCell score change keeps note', async () => {
    const wrapper = await mountCell({ score: 90, note: '遲到' })

    await typeAndBlur(wrapper, '88')
    expect(changes(wrapper)).toEqual([{ score: 88, is_absent: false, note: '遲到' }])

    await toggleAbsent(wrapper)
    expect(changes(wrapper)[1]).toEqual({ score: null, is_absent: true, note: '遲到' })

    // 取消缺考也不清備註
    await wrapper.setProps({ score: null, isAbsent: true })
    await toggleAbsent(wrapper)
    expect(changes(wrapper)[2]).toEqual({ score: null, is_absent: false, note: '遲到' })
  })

  it('ScoreCell note indicator and readonly view', async () => {
    const wrapper = await mountCell({ score: 90, note: '遲到' })
    const trigger = noteTrigger(wrapper)
    expect(trigger.exists()).toBe(true)
    expect(trigger.classes()).toContain('has-note')
    expect(trigger.attributes('aria-label')).toBe('備註：遲到')
    expect(trigger.attributes('tabindex')).toBe('-1')
    expect(trigger.find('[data-icon=ChatLineSquare]').exists()).toBe(true)
    // 分數輸入框以 aria-describedby 帶出全文
    const describedBy = wrapper.find('input[inputmode=decimal]').attributes('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(wrapper.find(`#${describedBy}`).text()).toBe('備註：遲到')

    const readonly = await mountCell({ readonly: true, score: 90, note: '遲到' })
    expect(readonly.find('[data-test=note-trigger]').exists()).toBe(false)
    expect(readonly.find('[data-test=note-view]').attributes('aria-label')).toBe('備註：遲到')
    expect(readonly.text()).toBe('90')

    const empty = await mountCell({ score: 90, note: null })
    expect(noteTrigger(empty).classes()).not.toContain('has-note')
    expect(noteTrigger(empty).attributes('aria-label')).toBe('新增備註')
    expect(noteTrigger(empty).find('[data-icon=ChatSquare]').exists()).toBe(true)
    expect(empty.find('input[inputmode=decimal]').attributes('aria-describedby')).toBeUndefined()

    const readonlyEmpty = await mountCell({ readonly: true, score: 90, note: null })
    expect(readonlyEmpty.find('[data-test=note-view]').exists()).toBe(false)
  })

  it('ScoreCell note outside click confirms', async () => {
    const wrapper = await mountAttached({ score: 90 })
    const outside = document.createElement('input')
    document.body.appendChild(outside)

    await openEditor(wrapper)
    await typeNote('補考')
    await pointerdownOn(document.body)

    expect(changes(wrapper).at(-1)).toEqual({ score: 90, is_absent: false, note: '補考' })
    expect(noteInput()).toBeNull()

    // 超過 200 字：點外面不關閉、不送出，焦點回到文字框
    await openEditor(wrapper)
    await typeNote('字'.repeat(201))
    await pointerdownOn(document.body)
    expect(changes(wrapper)).toHaveLength(1)
    expect(noteInput()).not.toBeNull()
    await waitTimers()
    expect(document.activeElement).toBe(noteInput())
    // 瀏覽器會把焦點移到點的地方：焦點跑出編輯框也要拉回文字框
    outside.focus()
    expect(document.activeElement).toBe(outside)
    await waitTimers()
    expect(document.activeElement).toBe(noteInput())

    // 再點同一格的圖示 = 點外面：內容合法時送出並關閉，不會又立刻打開
    await typeNote('病假')
    const trigger = noteTrigger(wrapper).element
    await pointerdownOn(trigger)
    await noteTrigger(wrapper).trigger('click')
    await settle()
    expect(changes(wrapper).at(-1)).toEqual({ score: 90, is_absent: false, note: '病假' })
    expect(noteInput()).toBeNull()
  })

  it('ScoreCell note editor returns focus to the cell', async () => {
    const wrapper = await mountAttached({ score: 90, note: '遲到' })
    const scoreInput = wrapper.find('input[inputmode=decimal]').element as HTMLInputElement

    scoreInput.focus()
    expect(document.activeElement).toBe(scoreInput)
    await keydownOn(scoreInput, { key: 'F2', shiftKey: true })
    expect(noteInput()).not.toBeNull()
    expect(document.activeElement).toBe(noteInput())
    // 游標在結尾
    expect(noteInput()?.selectionStart).toBe('遲到'.length)

    await keydownOn(noteInput(), { key: 'Escape' })
    expect(noteInput()).toBeNull()
    expect(wrapper.emitted('change')).toBeUndefined()
    expect(document.activeElement).toBe(scoreInput)

    // 確定後焦點也回到分數輸入框並全選
    await keydownOn(scoreInput, { key: 'F2', shiftKey: true })
    await typeNote('補考')
    await keydownOn(noteInput(), { key: 'Enter' })
    expect(changes(wrapper).at(-1)).toEqual({ score: 90, is_absent: false, note: '補考' })
    expect(document.activeElement).toBe(scoreInput)
    expect(scoreInput.selectionStart).toBe(0)
    expect(scoreInput.selectionEnd).toBe('90'.length)
    wrapper.unmount()

    // 缺考格：從「缺」勾選開啟，關閉後焦點回到「缺」
    const absent = await mountAttached({ score: null, isAbsent: true, note: '病假' })
    const absentInput = absent.find('.score-cell__absent input[type=checkbox]').element as HTMLInputElement
    absentInput.focus()
    await keydownOn(absentInput, { key: 'F2', shiftKey: true })
    expect(document.activeElement).toBe(noteInput())
    await keydownOn(noteInput(), { key: 'Enter' })
    expect(absent.emitted('change')).toBeUndefined()
    expect(noteInput()).toBeNull()
    expect(document.activeElement).toBe(absentInput)
  })
})
