import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import type { StudentDetail } from '@/api/students'
import StudentSensitiveFields from './StudentSensitiveFields.vue'
import source from './StudentSensitiveFields.vue?raw'

type Detail = Pick<StudentDetail, 'has_id_number' | 'has_health_note' | 'sensitive'>

function mountFields(detail: Detail): VueWrapper {
  return mount(StudentSensitiveFields, { props: { detail } }) as VueWrapper
}

/** el-descriptions 中某個標籤對應的內容格 */
function cell(wrapper: VueWrapper, label: string): string {
  const labels = wrapper.findAll('.el-descriptions__label')
  const index = labels.findIndex((l) => l.text() === label)
  if (index < 0) throw new Error(`找不到欄位 ${label}`)
  const content = wrapper.findAll('.el-descriptions__content')[index]
  if (!content) throw new Error(`找不到欄位內容 ${label}`)
  return content.text()
}

const WITH_SECRET: Detail = {
  has_id_number: true,
  has_health_note: true,
  sensitive: { id_number: 'A123456789', health_note: '氣喘，需隨身攜帶吸入器' },
}

describe('StudentSensitiveFields', () => {
  it('StudentSensitiveFields without permission shows filled status only', () => {
    const wrapper = mountFields({ has_id_number: true, has_health_note: false, sensitive: null })

    expect(cell(wrapper, '身分證字號')).toBe('已填寫（需敏感資料權限才能檢視）')
    expect(cell(wrapper, '健康備註')).toBe('未填寫')
    expect(wrapper.text()).not.toMatch(/[A-Z]\d/)
    expect(wrapper.find('[aria-label=顯示身分證字號]').exists()).toBe(false)
  })

  it('StudentSensitiveFields without permission shows filled status only: health note filled, id empty', () => {
    const wrapper = mountFields({ has_id_number: false, has_health_note: true, sensitive: null })

    expect(cell(wrapper, '身分證字號')).toBe('未填寫')
    expect(cell(wrapper, '健康備註')).toBe('已填寫（需敏感資料權限才能檢視）')
  })

  it('StudentSensitiveFields masks id number until revealed', async () => {
    const wrapper = mountFields(WITH_SECRET)

    expect(cell(wrapper, '身分證字號')).toContain('A******789')
    expect(wrapper.text()).not.toContain('A123456789')
    expect(cell(wrapper, '健康備註')).toBe('氣喘，需隨身攜帶吸入器')

    await wrapper.find('[aria-label=顯示身分證字號]').trigger('click')

    expect(cell(wrapper, '身分證字號')).toContain('A123456789')
    const hide = wrapper.find('[aria-label=隱藏身分證字號]')
    expect(hide.text()).toBe('隱藏')
    await hide.trigger('click')
    expect(wrapper.text()).not.toContain('A123456789')
    expect(cell(wrapper, '身分證字號')).toContain('A******789')
  })

  it('StudentSensitiveFields masks id number until revealed: short values fully masked and empty values', () => {
    const short = mountFields({ has_id_number: true, has_health_note: false, sensitive: { id_number: 'A12', health_note: null } })
    expect(cell(short, '身分證字號')).toContain('***')
    expect(short.text()).not.toContain('A12')
    expect(cell(short, '健康備註')).toBe('未填寫')

    const empty = mountFields({ has_id_number: false, has_health_note: false, sensitive: { id_number: null, health_note: null } })
    expect(cell(empty, '身分證字號')).toBe('未填寫')
    expect(cell(empty, '健康備註')).toBe('未填寫')
    expect(empty.find('[aria-label=顯示身分證字號]').exists()).toBe(false)
  })

  it('StudentSensitiveFields remasks when detail changes', async () => {
    const wrapper = mountFields(WITH_SECRET)
    await wrapper.find('[aria-label=顯示身分證字號]').trigger('click')
    expect(wrapper.text()).toContain('A123456789')

    await wrapper.setProps({
      detail: { has_id_number: true, has_health_note: false, sensitive: { id_number: 'B223456780', health_note: null } },
    })
    await flushPromises()

    expect(cell(wrapper, '身分證字號')).toContain('B******780')
    expect(wrapper.text()).not.toContain('B223456780')
    expect(wrapper.find('[aria-label=顯示身分證字號]').exists()).toBe(true)
  })

  it('StudentSensitiveFields shows health note with line breaks', () => {
    const wrapper = mountFields({
      has_id_number: false,
      has_health_note: true,
      sensitive: { id_number: null, health_note: '氣喘\n需隨身攜帶吸入器' },
    })

    const note = wrapper.find('.sensitive-note')
    expect(note.element.innerHTML).toContain('氣喘\n需隨身攜帶吸入器')
    expect(note.text()).toContain('需隨身攜帶吸入器')
    expect(source).toMatch(/\.sensitive-note\s*\{[^}]*white-space:\s*pre-line/)
  })

  it('StudentSensitiveFields shows health note with line breaks: never persists or logs sensitive values', () => {
    expect(source).not.toMatch(/console\.|localStorage|sessionStorage|router\.|location\./)
  })
})
