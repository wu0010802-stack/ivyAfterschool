import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import type { LeaveAttachment } from '../../api/leaves'
import LeaveAttachmentList from './LeaveAttachmentList.vue'

const KB = 1024
const MB = 1024 * 1024
const HELP = '單檔 10 MB 以內（JPG、PNG、WEBP、HEIC、PDF）'

let wrapper: VueWrapper | null = null

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

type Props = {
  attachments: LeaveAttachment[]
  editable?: boolean
  uploading?: boolean
  max?: number
  maxMb?: number
}

function mountList(props: Props): VueWrapper {
  wrapper = mount(LeaveAttachmentList, { props: { max: 3, maxMb: 10, ...props } })
  return wrapper
}

function attachment(overrides: Partial<LeaveAttachment> = {}): LeaveAttachment {
  return {
    id: 'a1',
    mime_type: 'image/jpeg',
    size_bytes: 2 * KB,
    created_at: '2026-10-01T02:00:00Z',
    url: 'https://files.example.test/a1.jpg?sig=1',
    ...overrides,
  }
}

const IMAGE = attachment({ id: 'i1', url: 'https://x/a.jpg' })
const PDF = attachment({ id: 'p1', mime_type: 'application/pdf', size_bytes: 1258291, url: 'https://x/b.pdf' })
const PNG = attachment({ id: 'i2', mime_type: 'image/png', size_bytes: 845000, url: 'https://x/c.png' })

function makeFile(name: string, type: string, size = KB): File {
  const file = new File([''], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

async function pickFile(w: VueWrapper, file: File): Promise<void> {
  const input = w.get<HTMLInputElement>('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
}

function uploads(w: VueWrapper): File[] {
  return (w.emitted('upload') ?? []).map((args) => args[0] as File)
}

describe('LeaveAttachmentList', () => {
  it('LeaveAttachmentList renders image and pdf', () => {
    const w = mountList({ attachments: [IMAGE, PDF] })

    const img = w.get('img')
    expect(img.attributes('src')).toBe('https://x/a.jpg')
    expect(img.attributes('loading')).toBe('lazy')
    expect(img.attributes('alt')).toBe('')
    expect(w.text()).toContain('PDF 文件 · 1.2 MB')

    const links = w.findAll('a')
    expect(links).toHaveLength(2)
    expect(links.map((a) => a.attributes('href'))).toEqual(['https://x/a.jpg', 'https://x/b.pdf'])
    for (const a of links) {
      expect(a.attributes('target')).toBe('_blank')
      expect(a.attributes('rel')).toContain('noopener')
      expect(a.attributes('rel')).toContain('noreferrer')
    }
  })

  it('LeaveAttachmentList names each link and shows an open-in-new badge', () => {
    const w = mountList({ attachments: [IMAGE, PDF, PNG] })

    const links = w.findAll('a')
    // 圖片的可及名稱放在連結上；PDF 的名稱由磚內文字組成
    expect(links[0]!.attributes('aria-label')).toBe('附件 1：圖片 2 KB，在新分頁開啟')
    expect(links[1]!.attributes('aria-label')).toBeUndefined()
    expect(links[1]!.text()).toContain('PDF 文件 · 1.2 MB')
    expect(links[1]!.text()).toContain('，在新分頁開啟')
    expect(links[2]!.attributes('aria-label')).toBe('附件 3：圖片 825 KB，在新分頁開啟')
    for (const a of links) {
      const badge = a.get('.att-tile__open')
      expect(badge.attributes('aria-hidden')).toBe('true')
      expect(badge.text()).toBe('open_in_new')
    }
    expect(links[1]!.get('.att-tile__pdf-icon').text()).toBe('picture_as_pdf')
  })

  it('LeaveAttachmentList shows a placeholder when the thumbnail fails to load', async () => {
    const w = mountList({ attachments: [IMAGE, PNG] })
    expect(w.findAll('img')).toHaveLength(2)

    await w.get('img').trigger('error')

    expect(w.findAll('img')).toHaveLength(1)
    const first = w.findAll('a')[0]!
    expect(first.text()).toContain('無法預覽')
    expect(first.text()).toContain('點開查看')
    expect(first.get('.m3-icon').text()).toBe('image_not_supported')
    // 連結照常可點
    expect(first.attributes('href')).toBe('https://x/a.jpg')
    expect(first.attributes('target')).toBe('_blank')
  })

  it('LeaveAttachmentList retries the thumbnail when the url is refreshed', async () => {
    const w = mountList({ attachments: [IMAGE] })
    await w.get('img').trigger('error')
    expect(w.find('img').exists()).toBe(false)

    await w.setProps({ attachments: [{ ...IMAGE, url: 'https://x/a.jpg?sig=2' }] })

    expect(w.get('img').attributes('src')).toBe('https://x/a.jpg?sig=2')
  })

  it('LeaveAttachmentList renders unavailable tile for null url', () => {
    const w = mountList({
      attachments: [
        attachment({ id: 'a1', mime_type: 'image/jpeg', url: null, size_bytes: 2048 }),
        attachment({ id: 'a2', mime_type: 'application/pdf', url: null, size_bytes: 1258291 }),
      ],
    })

    expect(w.find('a').exists()).toBe(false)
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('.att-tile__open').exists()).toBe(false)
    const tiles = w.findAll('.att-tile--unavailable')
    expect(tiles).toHaveLength(2)
    expect(tiles.map((t) => t.attributes('role'))).toEqual(['img', 'img'])
    expect(tiles.map((t) => t.attributes('aria-label'))).toEqual([
      '附件 1：圖片 2 KB，暫時無法開啟',
      '附件 2：PDF 文件 1.2 MB，暫時無法開啟',
    ])
    expect(tiles.map((t) => t.text())).toEqual(['image_not_supported暫時無法開啟', 'picture_as_pdf暫時無法開啟'])
  })

  it('LeaveAttachmentList mixes openable and unavailable tiles keeping their order', () => {
    const w = mountList({
      attachments: [IMAGE, attachment({ id: 'p2', mime_type: 'application/pdf', url: null }), PDF],
    })

    const tiles = w.findAll('.att-tile')
    expect(tiles.map((t) => t.element.tagName)).toEqual(['A', 'SPAN', 'A'])
    expect(tiles[1]!.attributes('aria-label')).toBe('附件 2：PDF 文件 2 KB，暫時無法開啟')
    expect(tiles[2]!.attributes('href')).toBe('https://x/b.pdf')
  })

  it('LeaveAttachmentList emits valid upload', async () => {
    const w = mountList({ attachments: [IMAGE], editable: true })
    const png = makeFile('藥袋.png', 'image/png', 500 * KB)

    await pickFile(w, png)

    expect(uploads(w)).toHaveLength(1)
    expect(uploads(w)[0]!.name).toBe('藥袋.png')
    expect(uploads(w)[0]).toBe(png)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('LeaveAttachmentList shows the add tile and remaining count when editable', () => {
    const w = mountList({ attachments: [PDF], editable: true })

    const input = w.get<HTMLInputElement>('input[type="file"]')
    expect(input.attributes('accept')).toBe('image/jpeg,image/png,image/webp,image/heic,application/pdf')
    expect(input.attributes('aria-label')).toBe('新增附件')
    expect(w.get('.att-tile--add').text()).toContain('add_photo_alternate')
    expect(w.get('.att-tile--add').text()).toContain('新增附件')
    expect(w.text()).toContain(`還可新增 2 個，${HELP}`)
  })

  it('LeaveAttachmentList rejects oversized and unsupported files without emitting', async () => {
    const w = mountList({ attachments: [IMAGE], editable: true })

    await pickFile(w, makeFile('IMG_2031.jpg', 'image/jpeg', 11 * MB))
    expect(w.get('[role="alert"]').text()).toContain('IMG_2031.jpg 超過 10 MB')

    await pickFile(w, makeFile('假單.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
    expect(w.get('[role="alert"]').text()).toContain('假單.docx 格式不支援')
    expect(w.get('[role="alert"]').text()).not.toContain('IMG_2031.jpg')
    expect(uploads(w)).toEqual([])

    // 下一次選到合格的檔就清除錯誤並 emit
    await pickFile(w, makeFile('ok.pdf', 'application/pdf', 100 * KB))
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(uploads(w).map((f) => f.name)).toEqual(['ok.pdf'])
  })

  it('LeaveAttachmentList resets the input so the same file can be chosen again', async () => {
    const w = mountList({ attachments: [], editable: true })
    const input = w.get<HTMLInputElement>('input[type="file"]')
    const written: string[] = []
    Object.defineProperty(input.element, 'value', { get: () => '', set: (v: string) => written.push(v), configurable: true })

    await pickFile(w, makeFile('a.jpg', 'image/jpeg'))

    expect(written).toEqual([''])
  })

  it('LeaveAttachmentList hides add when full or readonly', () => {
    const full = mountList({ attachments: [IMAGE, PDF, PNG], editable: true, max: 3 })

    expect(full.find('input[type="file"]').exists()).toBe(false)
    expect(full.text()).toContain('已達 3 個附件上限')
    expect(full.text()).not.toContain('還可新增')
    expect(full.findAll('.att-tile')).toHaveLength(3)
    full.unmount()

    const empty = mountList({ attachments: [], editable: false })
    expect(empty.text()).toContain('沒有附件')
    expect(empty.find('input[type="file"]').exists()).toBe(false)
    expect(empty.find('ul').exists()).toBe(false)
  })

  it('LeaveAttachmentList readonly with attachments shows no add tile and no help text', () => {
    const w = mountList({ attachments: [IMAGE, PDF], editable: false })

    expect(w.findAll('.att-tile')).toHaveLength(2)
    expect(w.find('input[type="file"]').exists()).toBe(false)
    expect(w.text()).not.toContain('還可新增')
    expect(w.text()).not.toContain('已達')
    expect(w.text()).not.toContain('沒有附件')
  })

  it('LeaveAttachmentList editable without attachments shows only the add tile and help', () => {
    const w = mountList({ attachments: [], editable: true })

    expect(w.findAll('.att-tile')).toHaveLength(1)
    expect(w.text()).not.toContain('沒有附件')
    expect(w.text()).toContain(`還可新增 3 個，${HELP}`)
  })

  it('LeaveAttachmentList follows max props', async () => {
    const w = mountList({ attachments: [IMAGE, PDF, PNG], editable: true, max: 5, maxMb: 2 })

    expect(w.find('input[type="file"]').exists()).toBe(true)
    expect(w.text()).toContain('還可新增 2 個，單檔 2 MB 以內（JPG、PNG、WEBP、HEIC、PDF）')

    await pickFile(w, makeFile('big.jpg', 'image/jpeg', 3 * MB))

    expect(w.get('[role="alert"]').text()).toContain('big.jpg 超過 2 MB')
    expect(uploads(w)).toEqual([])
  })

  it('LeaveAttachmentList uploading disables the add tile and shows progress', () => {
    const w = mountList({ attachments: [IMAGE], editable: true, uploading: true })

    const add = w.get('.att-tile--add')
    expect(add.attributes('aria-busy')).toBe('true')
    expect(add.text()).toContain('上傳中…')
    expect(add.find('.att-spinner').exists()).toBe(true)
    expect(add.text()).not.toContain('新增附件')
    expect(w.get<HTMLInputElement>('input[type="file"]').attributes('disabled')).toBeDefined()
    // 其他磚不受影響
    expect(w.get('a').attributes('href')).toBe('https://x/a.jpg')
  })

  it('LeaveAttachmentList idle add tile is not busy', () => {
    const w = mountList({ attachments: [], editable: true })

    expect(w.get('.att-tile--add').attributes('aria-busy')).toBeUndefined()
    expect(w.get<HTMLInputElement>('input[type="file"]').attributes('disabled')).toBeUndefined()
    expect(w.find('.att-spinner').exists()).toBe(false)
  })
})
