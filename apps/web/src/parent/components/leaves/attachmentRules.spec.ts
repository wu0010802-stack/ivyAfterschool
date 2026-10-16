import { describe, expect, it } from 'vitest'
import { ATTACHMENT_ACCEPT, formatFileSize, validateAttachment } from './attachmentRules'

const KB = 1024
const MB = 1024 * 1024

function makeFile(name: string, type: string, size: number): File {
  const file = new File([''], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('attachmentRules', () => {
  it('attachmentRules accept list names the five supported mime types', () => {
    expect(ATTACHMENT_ACCEPT.split(',')).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic',
      'application/pdf',
    ])
  })

  it('attachmentRules validate returns an empty string for supported files within the limit', () => {
    expect(validateAttachment(makeFile('a.jpg', 'image/jpeg', 500 * KB), 10)).toBe('')
    expect(validateAttachment(makeFile('b.pdf', 'application/pdf', 10 * MB), 10)).toBe('')
    expect(validateAttachment(makeFile('c.heic', 'image/heic', 1), 10)).toBe('')
  })

  it('attachmentRules validate rejects unsupported types before checking size', () => {
    expect(validateAttachment(makeFile('說明.txt', 'text/plain', KB), 10)).toBe('說明.txt 格式不支援')
    expect(validateAttachment(makeFile('big.gif', 'image/gif', 50 * MB), 10)).toBe('big.gif 格式不支援')
    expect(validateAttachment(makeFile('noext', '', KB), 10)).toBe('noext 格式不支援')
  })

  it('attachmentRules validate rejects files over the configured limit', () => {
    expect(validateAttachment(makeFile('photo.jpg', 'image/jpeg', 10 * MB + 1), 10)).toBe('photo.jpg 超過 10 MB')
    expect(validateAttachment(makeFile('photo.jpg', 'image/jpeg', 3 * MB), 2)).toBe('photo.jpg 超過 2 MB')
  })

  it('attachmentRules formats sizes as whole KB below 1 MB and one-decimal MB above', () => {
    expect(formatFileSize(0)).toBe('1 KB')
    expect(formatFileSize(90)).toBe('1 KB')
    expect(formatFileSize(2048)).toBe('2 KB')
    expect(formatFileSize(245760)).toBe('240 KB')
    expect(formatFileSize(1258291)).toBe('1.2 MB')
    expect(formatFileSize(10 * MB)).toBe('10.0 MB')
    // 四捨五入後會變成 1024 KB 的大小改以 MB 顯示
    expect(formatFileSize(MB - 1)).toBe('1.0 MB')
  })
})
