import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import type { LeaveAttachment } from '@/api/leaves'
import { createApiMock, mountWithApp } from '@/test/helpers'
import LeaveAttachmentList from './LeaveAttachmentList.vue'

const JPG: LeaveAttachment = {
  id: 'a1',
  mime_type: 'image/jpeg',
  size_bytes: 524288,
  created_at: '2026-10-05T23:46:00Z',
}
const PDF: LeaveAttachment = {
  id: 'a2',
  mime_type: 'application/pdf',
  size_bytes: 2621440,
  created_at: '2026-10-05T23:47:00Z',
}
const HEIC: LeaveAttachment = {
  id: 'a3',
  mime_type: 'image/heic',
  size_bytes: 3565158,
  created_at: '2026-10-06T23:03:00Z',
}

const url = (id: string) => `/admin/leaves/l1/attachments/${id}`

let mock: MockAdapter

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountList(attachments: LeaveAttachment[]): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(LeaveAttachmentList, { props: { leaveId: 'l1', attachments } })
  await settle()
  return wrapper as VueWrapper
}

function items(wrapper: VueWrapper): DOMWrapper<HTMLButtonElement>[] {
  return wrapper.findAll<HTMLButtonElement>('button.la__item')
}

function item(wrapper: VueWrapper, index: number): DOMWrapper<HTMLButtonElement> {
  const it = items(wrapper)[index]
  if (!it) throw new Error(`找不到第 ${index + 1} 個附件`)
  return it
}

function getCount(id: string): number {
  return mock.history.get.filter((r) => r.url === url(id)).length
}

describe('LeaveAttachmentList', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    document.body.innerHTML = ''
  })

  it('LeaveAttachmentList formats size and type', async () => {
    const wrapper = await mountList([JPG, PDF])

    const first = item(wrapper, 0)
    const second = item(wrapper, 1)
    expect(first.find('.la__name').text()).toBe('附件 1・圖片（JPG）')
    expect(first.find('.la__meta').text()).toBe('512.0 KB・2026/10/06 07:46 上傳')
    expect(first.find('.la__action').text()).toBe('預覽')
    expect(second.find('.la__name').text()).toBe('附件 2・PDF 文件')
    expect(second.find('.la__meta').text()).toBe('2.5 MB・2026/10/06 07:47 上傳')
    expect(second.find('.la__action').text()).toBe('另開')
    expect(second.find('.la__icon').classes()).toContain('is-pdf')
    expect(first.find('.la__icon').classes()).not.toContain('is-pdf')
  })

  it('LeaveAttachmentList formats size and type: other mime types', async () => {
    const wrapper = await mountList([
      { id: 'b1', mime_type: 'image/png', size_bytes: 1048576, created_at: '2026-10-05T23:46:00Z' },
      { id: 'b2', mime_type: 'image/webp', size_bytes: 1536, created_at: '2026-10-05T23:46:00Z' },
      HEIC,
      { id: 'b4', mime_type: 'application/zip', size_bytes: 2048, created_at: '2026-10-05T23:46:00Z' },
    ])

    expect(items(wrapper).map((b) => b.find('.la__name').text())).toEqual([
      '附件 1・圖片（PNG）',
      '附件 2・圖片（WEBP）',
      '附件 3・圖片（HEIC）',
      '附件 4・檔案',
    ])
    expect(items(wrapper).map((b) => b.find('.la__meta').text().split('・')[0])).toEqual([
      '1.0 MB',
      '1.5 KB',
      '3.4 MB',
      '2.0 KB',
    ])
    expect(items(wrapper).map((b) => b.find('.la__action').text())).toEqual(['預覽', '預覽', '另開', '另開'])
  })

  it('LeaveAttachmentList opens pdf in new tab with fresh url each time', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    mock
      .onGet(url('a2'))
      .replyOnce(200, { url: 'https://storage/a2.pdf?sig=1', expires_in: 300 })
      .onGet(url('a2'))
      .replyOnce(200, { url: 'https://storage/a2.pdf?sig=2', expires_in: 300 })
    const wrapper = await mountList([JPG, PDF])

    await item(wrapper, 1).trigger('click')
    await settle()
    await item(wrapper, 1).trigger('click')
    await settle()

    expect(getCount('a2')).toBe(2)
    expect(open.mock.calls).toEqual([
      ['https://storage/a2.pdf?sig=1', '_blank', 'noopener'],
      ['https://storage/a2.pdf?sig=2', '_blank', 'noopener'],
    ])
    expect(document.body.querySelector('.el-image-viewer__wrapper')).toBeNull()
  })

  it('LeaveAttachmentList previews image', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    mock.onGet(url('a1')).reply(200, { url: 'https://storage/a1.jpg', expires_in: 300 })
    const wrapper = await mountList([JPG, PDF])

    await item(wrapper, 0).trigger('click')
    await settle()

    const viewer = document.body.querySelector('.el-image-viewer__wrapper')
    expect(viewer).not.toBeNull()
    expect(viewer?.querySelector('img')?.getAttribute('src')).toBe('https://storage/a1.jpg')
    expect(open).not.toHaveBeenCalled()
  })

  it('LeaveAttachmentList shows error and empty state', async () => {
    mock.onGet(url('a1')).reply(404, {
      error: { code: 'attachment_not_found', message: '找不到附件', details: null },
    })
    const wrapper = await mountList([JPG])

    await item(wrapper, 0).trigger('click')
    await settle()

    expect(document.body.textContent).toContain('找不到附件')
    expect(document.body.querySelector('.el-image-viewer__wrapper')).toBeNull()
    expect(item(wrapper, 0).attributes('aria-busy')).toBeUndefined()
  })

  it('LeaveAttachmentList shows error and empty state: fallback message and empty list', async () => {
    // 沒有後端訊息時退回預設文字
    mock.onGet(url('a1')).reply(502, { error: { code: 'storage_unavailable', message: '', details: null } })
    const wrapper = await mountList([JPG])

    await item(wrapper, 0).trigger('click')
    await settle()
    expect(document.body.textContent).toContain('無法開啟附件')

    const empty = await mountList([])
    expect(empty.text()).toBe('沒有附件')
    expect(items(empty)).toHaveLength(0)
  })

  it('LeaveAttachmentList opens heic in new tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    mock.onGet(url('a3')).reply(200, { url: 'https://storage/a3.heic', expires_in: 300 })
    const wrapper = await mountList([HEIC])

    await item(wrapper, 0).trigger('click')
    await settle()

    expect(open.mock.calls[0]?.[0]).toBe('https://storage/a3.heic')
    expect(document.body.querySelector('.el-image-viewer__wrapper')).toBeNull()
  })

  it('LeaveAttachmentList shows busy row and ignores repeated clicks', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    let release: () => void = () => {}
    mock.onGet(url('a1')).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, { url: 'https://storage/a1.jpg', expires_in: 300 }])
        }),
    )
    mock.onGet(url('a2')).reply(200, { url: 'https://storage/a2.pdf', expires_in: 300 })
    const wrapper = await mountList([JPG, PDF])

    await item(wrapper, 0).trigger('click')
    await settle()
    expect(item(wrapper, 0).attributes('aria-busy')).toBe('true')
    expect(item(wrapper, 0).find('.la__action').text()).toBe('取得中…')
    expect(item(wrapper, 0).find('.la__icon').classes()).toContain('is-loading')
    expect(item(wrapper, 1).attributes('aria-busy')).toBeUndefined()

    await item(wrapper, 0).trigger('click')
    await settle()
    expect(getCount('a1')).toBe(1)

    // 其他列仍可點
    await item(wrapper, 1).trigger('click')
    await settle()
    expect(open.mock.calls[0]?.[0]).toBe('https://storage/a2.pdf')

    release()
    await settle()
    expect(item(wrapper, 0).attributes('aria-busy')).toBeUndefined()
    expect(item(wrapper, 0).find('.la__action').text()).toBe('預覽')
  })
})
