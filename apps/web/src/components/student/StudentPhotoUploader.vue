<script setup lang="ts">
// FRONTEND-090：學生照片顯示與上傳（POST /admin/students/{id}/photo，BACKEND-154）。
// 設計稿：docs/mockups/page-students.html（StudentPhotoUploader 段）。
// - 96×96 圓角照片；沒有照片或短效網址載入失敗時顯示姓名最後一字的 monogram。
// - editable（父層依 students:write 與未封存決定）：hover 遮罩「更換照片」+ 常駐相機小圓鈕，點擊或 Enter 開檔案選擇。
// - 選檔後先以 checkUpload(PHOTO_RULE) 檢查；通過即本地預覽並上傳，成功換成回傳網址，失敗還原舊照片。
import { Camera, Loading } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { uploadStudentPhoto } from '@/api/students'
import { checkUpload, PHOTO_RULE } from '@/shared/http/upload'
import { errorMessage } from '@/shared/utils/errorMessage'

const props = defineProps<{
  studentId: string
  photoUrl: string | null
  name: string
  editable: boolean
}>()

const emit = defineEmits<{
  uploaded: [photoUrl: string]
}>()

const ACCEPT = PHOTO_RULE.mimeTypes.join(',')

const shown = ref<string | null>(props.photoUrl)
const broken = ref(false)
const uploading = ref(false)
const input = ref<HTMLInputElement | null>(null)
let previewUrl: string | null = null

watch(
  () => props.photoUrl,
  (url) => {
    if (uploading.value) return
    shown.value = url
    broken.value = false
  },
)

const monogram = computed(() => props.name.trim().slice(-1))

function releasePreview(): void {
  if (previewUrl) URL.revokeObjectURL(previewUrl)
  previewUrl = null
}

onBeforeUnmount(releasePreview)

function pick(): void {
  if (!props.editable || uploading.value) return
  input.value?.click()
}

async function onFileChange(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  // 清空讓同一個檔案可以再選一次
  el.value = ''
  if (!file) return
  const check = checkUpload(file, PHOTO_RULE)
  if (!check.ok) {
    ElMessage.error(check.message)
    return
  }
  const previous = shown.value
  const previousBroken = broken.value
  releasePreview()
  previewUrl = URL.createObjectURL(file)
  shown.value = previewUrl
  broken.value = false
  uploading.value = true
  try {
    const { photo_url: url } = await uploadStudentPhoto(props.studentId, file)
    shown.value = url
    emit('uploaded', url)
    ElMessage.success('已更新照片')
  } catch (err) {
    shown.value = previous
    broken.value = previousBroken
    ElMessage.error(errorMessage(err, '照片上傳失敗，請稍後再試'))
  } finally {
    uploading.value = false
    releasePreview()
  }
}
</script>

<template>
  <div
    class="photo"
    :class="{ 'is-editable': editable }"
    :role="editable ? 'button' : undefined"
    :tabindex="editable ? 0 : undefined"
    :aria-label="editable ? '更換照片' : `${name} 的照片`"
    :aria-busy="uploading ? 'true' : undefined"
    @click="pick"
    @keydown.enter.prevent="pick"
  >
    <img
      v-if="shown && !broken"
      :src="shown"
      :alt="name"
      @error="broken = true"
    >
    <div
      v-else
      class="photo__mono"
      data-test="monogram"
    >
      {{ monogram }}
    </div>
    <template v-if="editable">
      <div
        class="photo__hover"
        aria-hidden="true"
      >
        更換照片
      </div>
      <span
        class="photo__badge"
        aria-hidden="true"
      >
        <el-icon><Camera /></el-icon>
      </span>
      <input
        ref="input"
        type="file"
        :accept="ACCEPT"
        hidden
        @click.stop
        @change="onFileChange"
      >
    </template>
    <div
      v-if="uploading"
      class="photo__loading"
    >
      <el-icon class="is-loading">
        <Loading />
      </el-icon>
    </div>
  </div>
</template>

<style scoped>
.photo {
  position: relative;
  flex-shrink: 0;
  width: 96px;
  height: 96px;
  overflow: hidden;
  background: var(--el-color-primary-light-8);
  border-radius: 12px;
}

.photo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.photo__mono {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 36px;
  font-weight: 600;
  color: var(--el-color-primary-dark-2);
}

.photo.is-editable {
  cursor: pointer;
}

.photo.is-editable:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.photo__hover {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--el-color-white);
  background: var(--el-mask-color-extra-light);
  opacity: 0;
  transition: opacity 0.15s;
}

.photo.is-editable:hover .photo__hover,
.photo.is-editable:focus-visible .photo__hover {
  background: var(--el-overlay-color-light);
  opacity: 1;
}

.photo__badge {
  position: absolute;
  right: 4px;
  bottom: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 14px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
  border-radius: 50%;
  box-shadow: var(--el-box-shadow-lighter);
}

.photo__loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: var(--el-color-primary);
  background: var(--el-mask-color);
}

@media (prefers-reduced-motion: reduce) {
  .photo__hover {
    transition: none;
  }
}
</style>
