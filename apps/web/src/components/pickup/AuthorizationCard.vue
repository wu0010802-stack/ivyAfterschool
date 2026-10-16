<script setup lang="ts">
// FRONTEND-202：代理授權卡片（代理人、末四碼、錯誤次數、鎖定、核驗結果）。
// 設計稿：docs/mockups/page-pickup-authorizations.html（AuthorizationCard 段）。
// 參考 ivy FE:src/views/PickupAuthorizationsView.vue 的 recordSummary 與狀態 tag 對照。
// - 左：64px 照片縮圖；沒有照片或載入失敗顯示 monogram（FRONTEND-184 monogramOf，主色淡底）。
// - 狀態 tag 以 effective_status 查 AUTHORIZATION_STATUS_META；active 時 locked →「已鎖定」danger（取代錯誤次數），
//   否則 code_attempts > 0 →「已錯誤 n 次」warning；completed →「{方式}・{核驗人}・{HH:MM}」。
// - 右：「核驗」（canVerify 且 active，≥ 44px）。非 active 淡灰底、姓名轉次要色；active 且 locked 框線轉淡紅。
import { computed, ref, watch } from 'vue'
import type { StaffAuthorization } from '@/api/pickupAuthorizations'
import { monogramOf } from '@/composables/useDismissalUrgency'
import {
  AUTHORIZATION_STATUS_META,
  PICKUP_COMPLETION_METHOD_LABELS,
  statusMeta,
} from '@/shared/constants/statusLabels'
import { formatTime } from '@/shared/utils/datetime'

const props = defineProps<{
  authorization: StaffAuthorization
  /** pickup:operate 且日期為今天 */
  canVerify: boolean
}>()

const emit = defineEmits<{
  verify: [authorization: StaffAuthorization]
}>()

const photoBroken = ref(false)
// 換成另一張照片（ws 更新）時重新嘗試載入
watch(
  () => props.authorization.photo_url,
  () => {
    photoBroken.value = false
  },
)

const auth = computed(() => props.authorization)
const status = computed(() => statusMeta(AUTHORIZATION_STATUS_META, auth.value.effective_status))
const isActive = computed(() => auth.value.effective_status === 'active')
const showPhoto = computed(() => !!auth.value.photo_url && !photoBroken.value)
const monogram = computed(() => monogramOf(auth.value.proxy_name))

const doneText = computed(() => {
  const a = auth.value
  if (a.effective_status !== 'completed') return ''
  const method = a.verification_method ? PICKUP_COMPLETION_METHOD_LABELS[a.verification_method] : '—'
  return `${method}・${a.verified_by_name ?? '—'}・${formatTime(a.verified_at)}`
})
</script>

<template>
  <article
    class="acard2"
    :class="{ 'is-inactive': !isActive, 'is-locked': isActive && auth.locked }"
  >
    <div class="acard2__photo">
      <img
        v-if="showPhoto"
        :src="auth.photo_url ?? undefined"
        :alt="`${auth.proxy_name} 的照片`"
        @error="photoBroken = true"
      >
      <span
        v-else
        class="acard2__mono"
        data-test="monogram"
        aria-hidden="true"
      >{{ monogram }}</span>
    </div>
    <div class="acard2__body">
      <div class="acard2__head">
        <span class="acard2__name">{{ auth.proxy_name }}</span>
        <el-tag
          :type="status.tone"
          disable-transitions
        >
          {{ status.label }}
        </el-tag>
      </div>
      <div class="acard2__line">
        {{ auth.proxy_phone }}
      </div>
      <div class="acard2__line">
        <span class="acard2__label">學生</span>{{ auth.student.name }}・{{ auth.student.class_name }}
      </div>
      <div class="acard2__code">
        <span>末四碼 {{ auth.code_last4 }}</span>
        <el-tag
          v-if="isActive && auth.locked"
          type="danger"
          size="small"
          disable-transitions
        >
          已鎖定
        </el-tag>
        <el-tag
          v-else-if="isActive && auth.code_attempts > 0"
          type="warning"
          size="small"
          disable-transitions
        >
          已錯誤 {{ auth.code_attempts }} 次
        </el-tag>
      </div>
      <div
        v-if="doneText"
        class="acard2__done"
      >
        {{ doneText }}
      </div>
    </div>
    <el-button
      v-if="canVerify && isActive"
      class="acard2__verify"
      type="primary"
      @click="emit('verify', auth)"
    >
      核驗
    </el-button>
  </article>
</template>

<style scoped>
.acard2 {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.acard2.is-inactive {
  background: var(--el-fill-color-lighter);
}

.acard2.is-inactive .acard2__name {
  color: var(--el-text-color-secondary);
}

.acard2.is-locked {
  border-color: var(--el-color-danger-light-5);
}

.acard2__photo {
  flex-shrink: 0;
  width: 64px;
  height: 64px;
  overflow: hidden;
  background: var(--el-fill-color);
  border-radius: 8px;
}

.acard2__photo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.acard2__mono {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 26px;
  font-weight: 600;
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.acard2__body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.acard2__head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.acard2__name {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
}

.acard2__line {
  font-size: 13px;
  color: var(--el-text-color-regular);
  font-variant-numeric: tabular-nums;
}

.acard2__label {
  margin-right: 6px;
  color: var(--el-text-color-secondary);
}

.acard2__code {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.acard2__done {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  font-variant-numeric: tabular-nums;
}

.acard2__verify {
  align-self: center;
  min-width: 88px;
  min-height: 44px;
  font-size: 15px;
}
</style>
