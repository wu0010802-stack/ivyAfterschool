<script setup lang="ts">
// FRONTEND-132：請假附件檢視（GET /admin/leaves/{id}/attachments/{aid} 簽發短效 URL，BACKEND-354）。
// 設計稿：docs/mockups/page-leaves.html（LeaveAttachmentList 段）。
// - 附件存私有 bucket，每次點擊都重新取網址（不快取，短效網址可能已過期）。
// - JPG / PNG / WEBP 以 el-image-viewer 預覽；PDF、HEIC（多數瀏覽器無法在頁內顯示）與其他類型另開分頁。
// - 取得中該列轉圈、aria-busy，重複點擊忽略，其他列仍可點；失敗以 ElMessage.error 顯示後端訊息。
import { Document, Loading, Picture, TopRight, ZoomIn } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { onBeforeUnmount, reactive, ref } from 'vue'
import { fetchLeaveAttachmentUrl, type LeaveAttachment } from '@/api/leaves'
import { formatDateTime } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  leaveId: string
  attachments: LeaveAttachment[]
}>()

const PDF = 'application/pdf'
/** 瀏覽器可在頁內顯示的圖片 */
const PREVIEWABLE: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp'])
const TYPE_LABELS: Readonly<Record<string, string>> = {
  'image/jpeg': '圖片（JPG）',
  'image/png': '圖片（PNG）',
  'image/webp': '圖片（WEBP）',
  'image/heic': '圖片（HEIC）',
  [PDF]: 'PDF 文件',
}
const KB = 1024
const MB = 1024 * 1024

const busy = reactive<Record<string, boolean>>({})
const viewerUrl = ref('')
let disposed = false
onBeforeUnmount(() => {
  disposed = true
})

function typeLabel(a: LeaveAttachment): string {
  return TYPE_LABELS[a.mime_type] ?? '檔案'
}

function sizeLabel(bytes: number): string {
  return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${(bytes / KB).toFixed(1)} KB`
}

function isPreviewable(a: LeaveAttachment): boolean {
  return PREVIEWABLE.has(a.mime_type)
}

async function open(a: LeaveAttachment): Promise<void> {
  if (busy[a.id]) return
  busy[a.id] = true
  try {
    const { url } = await fetchLeaveAttachmentUrl(props.leaveId, a.id)
    if (disposed) return
    if (isPreviewable(a)) viewerUrl.value = url
    else window.open(url, '_blank', 'noopener')
  } catch (err) {
    if (!disposed) ElMessage.error(errorMessage(err, '無法開啟附件'))
  } finally {
    delete busy[a.id]
  }
}
</script>

<template>
  <div class="la">
    <p
      v-if="!attachments.length"
      class="la__empty"
    >
      沒有附件
    </p>
    <ul
      v-else
      class="la__list"
      aria-label="請假附件"
    >
      <li
        v-for="(a, i) in attachments"
        :key="a.id"
      >
        <button
          type="button"
          class="la__item"
          :class="{ 'is-loading': busy[a.id] }"
          :aria-busy="busy[a.id] ? 'true' : undefined"
          @click="open(a)"
        >
          <el-icon
            class="la__icon"
            :class="{ 'is-pdf': a.mime_type === PDF, 'is-loading': busy[a.id] }"
          >
            <Loading v-if="busy[a.id]" />
            <Document v-else-if="a.mime_type === PDF" />
            <Picture v-else />
          </el-icon>
          <span class="la__body">
            <span class="la__name">附件 {{ i + 1 }}・{{ typeLabel(a) }}</span>
            <span class="la__meta">{{ sizeLabel(a.size_bytes) }}・{{ formatDateTime(a.created_at) }} 上傳</span>
          </span>
          <span class="la__action">
            <template v-if="busy[a.id]">取得中…</template>
            <template v-else-if="isPreviewable(a)">
              <el-icon><ZoomIn /></el-icon>預覽
            </template>
            <template v-else>
              <el-icon><TopRight /></el-icon>另開
            </template>
          </span>
        </button>
      </li>
    </ul>
    <el-image-viewer
      v-if="viewerUrl"
      :url-list="[viewerUrl]"
      teleported
      hide-on-click-modal
      @close="viewerUrl = ''"
    />
  </div>
</template>

<style scoped>
.la__list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.la__item {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 300px;
  max-width: 100%;
  min-height: 52px;
  padding: 8px 12px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  transition:
    border-color 0.15s,
    background-color 0.15s;
}

.la__item:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
}

.la__item:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.la__item.is-loading {
  cursor: progress;
}

.la__icon {
  flex-shrink: 0;
  font-size: 22px;
  color: var(--el-color-primary);
}

.la__icon.is-pdf {
  color: var(--el-color-danger);
}

.la__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.la__name {
  font-size: 14px;
  color: var(--el-text-color-primary);
}

.la__meta {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

.la__action {
  display: inline-flex;
  flex-shrink: 0;
  gap: 2px;
  align-items: center;
  font-size: 13px;
  color: var(--el-color-primary);
  white-space: nowrap;
}

.la__empty {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .la__item {
    transition: none;
  }
}
</style>
