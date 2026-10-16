<script setup lang="ts">
/**
 * 請假附件磚（3 欄方形磚）：圖片縮圖 / PDF 文件磚 / url 為 null 時不可點的「暫時無法開啟」磚 / 補上傳的新增磚。
 * 每個可開啟的磚都是 <a target="_blank"> 指向後端簽發的短效網址。上傳與失敗提示由宿主處理：
 * 本元件只在選檔通過驗證後 emit upload(file)，宿主把 uploading 設為 true，成功後把新附件放進 attachments。
 * 不提供刪除附件（後端沒有 endpoint）。個數 / 大小上限來自 max、maxMb（PARENT-005 limits）。
 */
import { computed, reactive, ref } from 'vue'
import type { LeaveAttachment } from '../../api/leaves'
import M3Icon from '../m3/M3Icon.vue'
import { ATTACHMENT_ACCEPT, formatFileSize, validateAttachment } from './attachmentRules'

const props = withDefaults(
  defineProps<{
    attachments: LeaveAttachment[]
    editable?: boolean
    uploading?: boolean
    max: number
    maxMb: number
  }>(),
  { editable: false, uploading: false },
)

const emit = defineEmits<{ upload: [file: File] }>()

const error = ref('')
// 縮圖載入失敗以「網址」記錄：短效網址過期後重抓清單拿到新網址，會重新嘗試載入
const failedThumbs = reactive(new Set<string>())

const canAdd = computed(() => props.editable && props.attachments.length < props.max)
const remaining = computed(() => props.max - props.attachments.length)

function isImage(attachment: LeaveAttachment): boolean {
  return attachment.mime_type.startsWith('image/')
}

function tileLabel(attachment: LeaveAttachment, index: number, suffix: string): string {
  const kind = isImage(attachment) ? '圖片' : 'PDF 文件'
  return `附件 ${index + 1}：${kind} ${formatFileSize(attachment.size_bytes)}，${suffix}`
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  // 清空 value，才能再次選同一個檔案
  input.value = ''
  if (!file) return
  error.value = validateAttachment(file, props.maxMb)
  if (error.value === '') emit('upload', file)
}
</script>

<template>
  <div class="att-list">
    <p
      v-if="!attachments.length && !editable"
      class="att-empty m3-body-medium"
    >
      沒有附件
    </p>
    <ul
      v-if="attachments.length || canAdd"
      class="att-grid"
      role="list"
      aria-label="附件"
    >
      <li
        v-for="(a, i) in attachments"
        :key="a.id"
      >
        <span
          v-if="!a.url"
          class="att-tile att-tile--unavailable"
          role="img"
          :aria-label="tileLabel(a, i, '暫時無法開啟')"
        >
          <M3Icon
            :name="isImage(a) ? 'image_not_supported' : 'picture_as_pdf'"
            :size="32"
          />
          <span
            class="att-tile__caption m3-label-small"
            aria-hidden="true"
          >暫時無法開啟</span>
        </span>
        <a
          v-else
          class="att-tile att-tile--link"
          :href="a.url"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="isImage(a) ? tileLabel(a, i, '在新分頁開啟') : undefined"
        >
          <img
            v-if="isImage(a) && !failedThumbs.has(a.url)"
            class="att-tile__img"
            :src="a.url"
            alt=""
            loading="lazy"
            @error="failedThumbs.add(a.url)"
          >
          <template v-else-if="isImage(a)">
            <M3Icon
              name="image_not_supported"
              :size="32"
            />
            <span class="att-tile__caption m3-label-small">無法預覽<br>點開查看</span>
          </template>
          <template v-else>
            <M3Icon
              class="att-tile__pdf-icon"
              name="picture_as_pdf"
              :size="32"
            />
            <span class="att-tile__caption m3-label-small">PDF 文件 · {{ formatFileSize(a.size_bytes) }}</span>
            <span class="visually-hidden">，在新分頁開啟</span>
          </template>
          <span
            class="att-tile__open"
            aria-hidden="true"
          >
            <M3Icon
              name="open_in_new"
              :size="14"
            />
          </span>
        </a>
      </li>
      <li v-if="canAdd">
        <label
          class="att-tile att-tile--add"
          :class="{ 'is-busy': uploading }"
          :aria-busy="uploading ? 'true' : undefined"
        >
          <input
            class="att-tile__input"
            type="file"
            :accept="ATTACHMENT_ACCEPT"
            :disabled="uploading"
            aria-label="新增附件"
            @change="onFileChange"
          >
          <template v-if="uploading">
            <span
              class="att-spinner"
              aria-hidden="true"
            />
            <span class="m3-label-medium">上傳中…</span>
          </template>
          <template v-else>
            <M3Icon
              name="add_photo_alternate"
              :size="28"
            />
            <span class="m3-label-medium">新增附件</span>
          </template>
        </label>
      </li>
    </ul>
    <p
      v-if="error"
      class="att-error m3-body-small"
      role="alert"
    >
      <M3Icon
        name="error"
        filled
        :size="16"
      />{{ error }}
    </p>
    <p
      v-if="canAdd"
      class="att-help m3-body-small"
    >
      還可新增 {{ remaining }} 個，單檔 {{ maxMb }} MB 以內（JPG、PNG、WEBP、HEIC、PDF）
    </p>
    <p
      v-else-if="editable"
      class="att-help m3-body-small"
    >
      已達 {{ max }} 個附件上限
    </p>
  </div>
</template>

<style scoped>
.att-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.att-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  aspect-ratio: 1 / 1;
  min-height: 88px;
  overflow: hidden;
  border-radius: var(--m3-shape-small);
  background: var(--m3-surface-container-high);
  color: var(--m3-on-surface-variant);
  text-align: center;
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
}

/* 可點的磚與新增磚才有 state layer；蓋在縮圖之上 */
.att-tile--link::before,
.att-tile--add::before {
  content: '';
  position: absolute;
  z-index: 1;
  inset: 0;
  background: var(--m3-on-surface);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--m3-dur-short-2) var(--m3-easing-standard);
}

.att-tile--link:hover::before,
.att-tile--add:hover::before {
  opacity: var(--m3-state-hover);
}

.att-tile--link:focus-visible::before,
.att-tile--add:focus-within::before {
  opacity: var(--m3-state-focus);
}

.att-tile--link:active::before,
.att-tile--add:active::before {
  opacity: var(--m3-state-pressed);
}

.att-tile--link:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: 2px;
}

.att-tile__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.att-tile__pdf-icon {
  color: var(--m3-error);
}

.att-tile__caption {
  padding: 0 6px;
  color: var(--m3-on-surface);
  overflow-wrap: anywhere;
}

.att-tile__open {
  position: absolute;
  z-index: 2;
  right: 4px;
  bottom: 4px;
  display: inline-flex;
  padding: 2px;
  border-radius: var(--m3-shape-full);
  background: var(--m3-inverse-surface);
  color: var(--m3-inverse-on-surface);
  opacity: 0.85;
}

/* url 為 null：不可點，沒有連結、state layer 與 open_in_new 徽章 */
.att-tile--unavailable {
  cursor: default;
}

.att-tile--add {
  border: 1px dashed var(--m3-outline);
  background: transparent;
  color: var(--m3-primary);
  cursor: pointer;
}

.att-tile--add:focus-within {
  outline: 2px solid var(--m3-primary);
  outline-offset: 2px;
}

.att-tile--add.is-busy {
  color: var(--m3-on-surface-variant);
  cursor: progress;
}

.att-tile--add.is-busy::before {
  display: none;
}

.att-tile--add .att-spinner {
  color: var(--m3-primary);
}

.att-tile__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
}

.att-spinner {
  flex: none;
  width: 18px;
  height: 18px;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: att-spin 0.8s linear infinite;
}

@keyframes att-spin {
  to {
    transform: rotate(360deg);
  }
}

.att-help {
  margin: 8px 0 0;
  color: var(--m3-on-surface-variant);
}

.att-error {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 8px 0 0;
  color: var(--m3-error);
}

.att-empty {
  margin: 0;
  color: var(--m3-on-surface-variant);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  border: 0;
  white-space: nowrap;
  clip: rect(0 0 0 0);
}
</style>
