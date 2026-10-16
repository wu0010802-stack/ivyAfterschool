import { flushPromises, type VueWrapper } from '@vue/test-utils'
import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { adminHttp } from '@/api/http'
import { createApiMock, mountWithApp } from '@/test/helpers'
import StudentPhotoUploader from './StudentPhotoUploader.vue'

const UPLOAD_URL = '/admin/students/s1/photo'
const MiB = 1024 * 1024

let mock: MockAdapter
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
const originalObjectUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }

async function settle(): Promise<void> {
  await nextTick()
  await flushPromises()
}

async function mountUploader(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const { wrapper } = await mountWithApp(StudentPhotoUploader, {
    props: { studentId: 's1', photoUrl: null, name: '王小明', editable: true, ...props },
  })
  await settle()
  return wrapper as VueWrapper
}

function fileOf(type: string, size: number, name = 'photo.png'): File {
  return new File([new Uint8Array(size)], name, { type })
}

async function pick(wrapper: VueWrapper, file: File): Promise<void> {
  const input = wrapper.find<HTMLInputElement>('input[type=file]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await settle()
}

function imgSrc(wrapper: VueWrapper): string | undefined {
  const img = wrapper.find('img')
  return img.exists() ? img.attributes('src') : undefined
}

describe('StudentPhotoUploader', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
    createObjectURL = vi.fn(() => 'blob:preview-1')
    revokeObjectURL = vi.fn()
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL
  })

  afterEach(() => {
    URL.createObjectURL = originalObjectUrl.create
    URL.revokeObjectURL = originalObjectUrl.revoke
    mock.restore()
    document.body.innerHTML = ''
  })

  it('StudentPhotoUploader shows monogram without photo', async () => {
    const wrapper = await mountUploader({ photoUrl: null })

    expect(wrapper.find('[data-test=monogram]').text()).toBe('明')
    expect(wrapper.find('img').exists()).toBe(false)

    const withPhoto = await mountUploader({ photoUrl: 'https://storage/old.png' })
    expect(imgSrc(withPhoto)).toBe('https://storage/old.png')
    expect(withPhoto.find('img').attributes('alt')).toBe('王小明')
    expect(withPhoto.find('[data-test=monogram]').exists()).toBe(false)

    await withPhoto.find('img').trigger('error')
    expect(withPhoto.find('img').exists()).toBe(false)
    expect(withPhoto.find('[data-test=monogram]').text()).toBe('明')

    // 父層換新網址（例如重新取得簽名 URL）後再試一次
    await withPhoto.setProps({ photoUrl: 'https://storage/refreshed.png' })
    expect(imgSrc(withPhoto)).toBe('https://storage/refreshed.png')
  })

  it('StudentPhotoUploader rejects invalid file before upload', async () => {
    const wrapper = await mountUploader()

    await pick(wrapper, fileOf('application/pdf', 1000, 'report.pdf'))

    expect(document.body.textContent).toContain('只接受 JPG / PNG / WEBP')
    expect(mock.history.post).toHaveLength(0)
    expect(wrapper.emitted('uploaded')).toBeUndefined()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('StudentPhotoUploader rejects invalid file before upload: too large', async () => {
    const wrapper = await mountUploader()

    await pick(wrapper, fileOf('image/jpeg', 5 * MiB + 1, 'big.jpg'))

    expect(document.body.textContent).toContain('檔案超過 5 MB')
    expect(mock.history.post).toHaveLength(0)
  })

  it('StudentPhotoUploader uploads and emits new url', async () => {
    let release: () => void = () => {}
    mock.onPost(UPLOAD_URL).reply(
      () =>
        new Promise((resolve) => {
          release = () => resolve([200, { photo_url: 'https://storage/new.png' }])
        }),
    )
    const wrapper = await mountUploader({ photoUrl: 'https://storage/old.png' })
    const file = fileOf('image/png', MiB)

    await pick(wrapper, file)

    // 上傳中：本地預覽 + loading 遮罩
    expect(imgSrc(wrapper)).toBe('blob:preview-1')
    expect(wrapper.find('.photo__loading').exists()).toBe(true)
    const sent = mock.history.post[0]?.data as FormData
    expect((sent.get('file') as File).name).toBe(file.name)

    release()
    await settle()

    expect(imgSrc(wrapper)).toBe('https://storage/new.png')
    expect(wrapper.find('.photo__loading').exists()).toBe(false)
    expect(wrapper.emitted('uploaded')?.[0]).toEqual(['https://storage/new.png'])
    expect(document.body.textContent).toContain('已更新照片')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  it('StudentPhotoUploader restores old photo on failure', async () => {
    mock.onPost(UPLOAD_URL).reply(502, {
      error: { code: 'storage_unavailable', message: '照片儲存服務暫時無法使用', details: null },
    })
    const wrapper = await mountUploader({ photoUrl: 'https://storage/old.png' })

    await pick(wrapper, fileOf('image/jpeg', 2048, 'a.jpg'))

    expect(imgSrc(wrapper)).toBe('https://storage/old.png')
    expect(document.body.textContent).toContain('照片儲存服務暫時無法使用')
    expect(document.body.textContent).not.toContain('已更新照片')
    expect(wrapper.find('.photo__loading').exists()).toBe(false)
    expect(wrapper.emitted('uploaded')).toBeUndefined()
  })

  it('StudentPhotoUploader restores old photo on failure: monogram stays when there was no photo', async () => {
    mock.onPost(UPLOAD_URL).reply(415, {
      error: { code: 'unsupported_file_type', message: '不支援的檔案格式', details: null },
    })
    const wrapper = await mountUploader({ photoUrl: null })

    await pick(wrapper, fileOf('image/webp', 2048, 'a.webp'))

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[data-test=monogram]').text()).toBe('明')
    expect(document.body.textContent).toContain('不支援的檔案格式')
  })

  it('StudentPhotoUploader readonly when not editable', async () => {
    const wrapper = await mountUploader({ editable: false, photoUrl: 'https://storage/old.png' })

    expect(wrapper.find('input[type=file]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('更換照片')
    expect(wrapper.find('[role=button]').exists()).toBe(false)
    expect(wrapper.find('.photo').attributes('aria-label')).toBe('王小明 的照片')
  })

  it('StudentPhotoUploader readonly when not editable: editable opens file chooser', async () => {
    const wrapper = await mountUploader()

    const box = wrapper.find('.photo')
    expect(box.attributes('role')).toBe('button')
    expect(box.attributes('aria-label')).toBe('更換照片')
    expect(wrapper.text()).toContain('更換照片')
    const input = wrapper.find<HTMLInputElement>('input[type=file]')
    expect(input.attributes('accept')).toBe('image/jpeg,image/png,image/webp')
    const click = vi.spyOn(input.element, 'click').mockImplementation(() => {})

    await box.trigger('click')
    await box.trigger('keydown', { key: 'Enter' })

    expect(click).toHaveBeenCalledTimes(2)
  })
})
