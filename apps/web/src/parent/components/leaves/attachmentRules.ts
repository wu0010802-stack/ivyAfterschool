// 請假附件的格式與大小規則（PARENT-134 LeaveForm 與 PARENT-135 LeaveAttachmentList 共用）。
// 數字上限一律由呼叫端以 PARENT-005 limits 傳入；後端仍會驗證，這裡只做選檔當下的提示。

export const ATTACHMENT_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,application/pdf'

const ACCEPTED_TYPES: readonly string[] = ATTACHMENT_ACCEPT.split(',')
const KB = 1024
const MB = 1024 * 1024

/** 通過回空字串；格式不支援優先於過大 */
export function validateAttachment(file: File, maxMb: number): string {
  if (!ACCEPTED_TYPES.includes(file.type)) return `${file.name} 格式不支援`
  if (file.size > maxMb * MB) return `${file.name} 超過 ${maxMb} MB`
  return ''
}

/** < 1 MB 以 KB 取整數（最小 1 KB），其餘以 MB 取一位小數；以 1024 為底 */
export function formatFileSize(bytes: number): string {
  if (bytes < MB) {
    const kb = Math.max(1, Math.round(bytes / KB))
    if (kb < KB) return `${kb} KB`
  }
  return `${(bytes / MB).toFixed(1)} MB`
}
