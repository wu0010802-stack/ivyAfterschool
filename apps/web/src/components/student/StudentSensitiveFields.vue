<script setup lang="ts">
// FRONTEND-088：學生敏感欄位（身分證字號、健康備註）。domain_spec M3：只有 students:sensitive 能檢視與寫入，
// 後端對無權限者回 sensitive = null，只給 has_id_number / has_health_note。
// 設計稿：docs/mockups/page-students.html（StudentSensitiveFields 段）。
// - 有權限：身分證預設遮罩（第 1 碼 + 末 3 碼），「顯示 / 隱藏」切換；切換學生時恢復遮罩。健康備註保留換行。
// - 無權限：鎖頭 +「已填寫（需敏感資料權限才能檢視）」或灰字「未填寫」。
// - 敏感值只在畫面上呈現，不寫進 log、storage 或網址。
import { Hide, Lock, View } from '@element-plus/icons-vue'
import { computed, ref, watch } from 'vue'
import type { StudentDetail } from '@/api/students'

const props = defineProps<{
  detail: Pick<StudentDetail, 'has_id_number' | 'has_health_note' | 'sensitive'>
}>()

const LOCKED_TEXT = '已填寫（需敏感資料權限才能檢視）'

const revealed = ref(false)

// 換學生（父層換掉 detail）或身分證值改變時一律恢復遮罩
watch(
  () => [props.detail, props.detail.sensitive?.id_number] as const,
  () => {
    revealed.value = false
  },
)

/** 保留第 1 碼與末 3 碼；長度不足 4 時全遮 */
function maskIdNumber(value: string): string {
  if (value.length < 4) return '*'.repeat(value.length)
  return `${value[0]}${'*'.repeat(value.length - 4)}${value.slice(-3)}`
}

const idNumber = computed(() => props.detail.sensitive?.id_number ?? null)
const shownIdNumber = computed(() => {
  const value = idNumber.value
  if (value === null) return ''
  return revealed.value ? value : maskIdNumber(value)
})
const healthNote = computed(() => props.detail.sensitive?.health_note || null)
</script>

<template>
  <el-descriptions
    class="sensitive-fields"
    :column="1"
    border
  >
    <el-descriptions-item label="身分證字號">
      <template v-if="detail.sensitive">
        <span
          v-if="idNumber"
          class="sensitive-id"
        >
          <span class="sensitive-id__value">{{ shownIdNumber }}</span>
          <el-button
            link
            type="primary"
            :aria-label="revealed ? '隱藏身分證字號' : '顯示身分證字號'"
            @click="revealed = !revealed"
          >
            <el-icon class="sensitive-id__icon">
              <Hide v-if="revealed" />
              <View v-else />
            </el-icon>{{ revealed ? '隱藏' : '顯示' }}
          </el-button>
        </span>
        <span
          v-else
          class="sensitive-empty"
        >未填寫</span>
      </template>
      <span
        v-else-if="detail.has_id_number"
        class="sensitive-locked"
      ><el-icon><Lock /></el-icon>{{ LOCKED_TEXT }}</span>
      <span
        v-else
        class="sensitive-empty"
      >未填寫</span>
    </el-descriptions-item>
    <el-descriptions-item label="健康備註">
      <template v-if="detail.sensitive">
        <span
          v-if="healthNote"
          class="sensitive-note"
        >{{ healthNote }}</span>
        <span
          v-else
          class="sensitive-empty"
        >未填寫</span>
      </template>
      <span
        v-else-if="detail.has_health_note"
        class="sensitive-locked"
      ><el-icon><Lock /></el-icon>{{ LOCKED_TEXT }}</span>
      <span
        v-else
        class="sensitive-empty"
      >未填寫</span>
    </el-descriptions-item>
  </el-descriptions>
</template>

<style scoped>
.sensitive-locked {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  color: var(--el-text-color-secondary);
}

.sensitive-empty {
  color: var(--el-text-color-placeholder);
}

.sensitive-id {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.sensitive-id__value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.sensitive-id__icon {
  margin-right: 2px;
}

.sensitive-note {
  white-space: pre-line;
}
</style>
