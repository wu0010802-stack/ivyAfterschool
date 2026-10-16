<script setup lang="ts">
/**
 * 代理接送授權一列（<li>，由頁面放進 <ul>）：姓名 + 狀態膠囊、「MM/DD（X） · 電話」、接送碼末四碼、交接時間。
 * 只有 effective_status 為 active 顯示「重新產生接送碼」與「取消授權」；本元件只 emit，
 * 確認對話框與接送碼卡（完整碼只在建立 / 重新產生當下顯示一次）由 PickupProxyView（PARENT-104）負責。
 * 參考 ivy FE:src/parent/views/PickupView.vue::askRegenerate / askCancel 的列操作；去掉 batch_key 多孩合併顯示與完整取件碼。
 * 已完成的授權只顯示交接時間，不顯示核驗方式。
 */
import { computed } from 'vue'
import { AUTHORIZATION_STATUS_META, statusMeta } from '@/shared/constants/statusLabels'
import { formatDateWithWeekday, formatTime } from '@/shared/utils/datetime'
import type { ParentAuthorization } from '../../api/pickupAuthorizations'
import M3Button from '../m3/M3Button.vue'
import M3Icon from '../m3/M3Icon.vue'
import StatusPill from '../StatusPill.vue'

const props = defineProps<{ authorization: ParentAuthorization }>()

const emit = defineEmits<{ cancel: [a: ParentAuthorization]; regenerate: [a: ParentAuthorization] }>()

const meta = computed(() => statusMeta(AUTHORIZATION_STATUS_META, props.authorization.effective_status))
const active = computed(() => props.authorization.effective_status === 'active')
const dateText = computed(() => formatDateWithWeekday(props.authorization.service_date))
const verifiedAt = computed(() => (props.authorization.verified_at ? formatTime(props.authorization.verified_at) : ''))
</script>

<template>
  <li
    class="auth"
    :class="{ 'is-active': active }"
  >
    <div class="auth__head">
      <span class="auth__name m3-title-medium">{{ authorization.proxy_name }}</span>
      <StatusPill
        class="auth__pill"
        :label="meta.label"
        :tone="meta.tone"
      />
    </div>
    <p class="auth__meta m3-body-medium">
      {{ dateText }} · {{ authorization.proxy_phone }}
    </p>
    <p class="auth__line m3-body-medium">
      <M3Icon
        name="pin"
        :size="18"
      />
      <span>接送碼末四碼 <span class="auth__code">{{ authorization.code_last4 }}</span></span>
    </p>
    <p
      v-if="verifiedAt"
      class="auth__line m3-body-medium"
    >
      <M3Icon
        name="how_to_reg"
        :size="18"
      />
      <span class="auth__verified">{{ verifiedAt }} 已完成交接</span>
    </p>
    <div
      v-if="active"
      class="auth__actions"
    >
      <M3Button
        variant="text"
        icon="autorenew"
        @click="emit('regenerate', authorization)"
      >
        重新產生接送碼
      </M3Button>
      <M3Button
        variant="text"
        icon="block"
        class="auth__cancel"
        @click="emit('cancel', authorization)"
      >
        取消授權
      </M3Button>
    </div>
  </li>
</template>

<style scoped>
.auth {
  padding: 16px 16px 12px;
  list-style: none;
}

/* 列間分隔線由列自己畫 */
.auth + .auth {
  border-top: 1px solid var(--m3-outline-variant);
}

.auth__head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.auth__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--m3-on-surface);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 非 active 的姓名改 on-surface-variant，讓有效授權在混合清單裡比較醒目 */
.auth:not(.is-active) .auth__name {
  color: var(--m3-on-surface-variant);
}

.auth__pill {
  flex: none;
}

.auth__meta {
  margin: 2px 0 0;
  overflow: hidden;
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.auth__line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  color: var(--m3-on-surface-variant);
}

.auth__code {
  color: var(--m3-on-surface);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  letter-spacing: 1px;
}

.auth__verified {
  color: var(--m3-on-surface);
}

.auth__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0 4px;
  margin: 4px -12px 0 0;
}

/* 取消授權用 error 色，與重新產生（primary）區分 */
.auth__cancel {
  color: var(--m3-error);
}
</style>
