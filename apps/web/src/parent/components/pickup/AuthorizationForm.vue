<script setup lang="ts">
/**
 * 建立單日代理接送授權的表單（放在 PickupProxyView 的 ParentBottomSheet 內，按鈕列屬於本元件）。
 * 外觀與互動以 docs/mockups/parent-component-authorization-form.html 為準。
 * 移植 ivy FE:src/parent/views/PickupCreateView.vue::canSubmit 的 saved / manual 兩種模式與日期上限；
 * 去掉一次多個小孩、「同時存成常用接送人」與臨時填寫的照片。
 *
 * - 驗證都在送出時做（按鈕不因未填而 disabled）；修改欄位即清除該欄錯誤。
 * - 切換來源時清除欄位錯誤、保留兩邊已輸入 / 已選的值；送出只送目前來源的欄位。
 * - persons 變動（頁面在 pickup_person_not_found 後重抓）：已選的人不在新清單就清掉；清單變空自動切到臨時填寫。
 * - 建立錯誤與成功後的接送碼卡由 PickupProxyView（PARENT-104）處理。
 */
import { computed, reactive, ref, useId, watch } from 'vue'
import { addDays } from '@/shared/utils/datetime'
import type { AuthorizationCreateInput } from '../../api/pickupAuthorizations'
import type { PickupPerson } from '../../api/pickupPersons'
import M3Button from '../m3/M3Button.vue'
import M3Icon from '../m3/M3Icon.vue'
import M3SegmentedButton, { type SegmentItem } from '../m3/M3SegmentedButton.vue'
import M3TextField from '../m3/M3TextField.vue'

type Source = 'saved' | 'manual'

const props = withDefaults(
  defineProps<{
    persons: PickupPerson[]
    submitting?: boolean
    /** YYYY-MM-DD，台北今天 */
    today: string
    /** PARENT-005 limits.authorization_max_days_ahead */
    maxDaysAhead: number
  }>(),
  { submitting: false },
)

const emit = defineEmits<{ submit: [input: AuthorizationCreateInput]; cancel: [] }>()

const PHONE_PATTERN = /^0\d{8,9}$/

const groupLabelId = useId()

const serviceDate = ref(props.today)
const source = ref<Source>(props.persons.length ? 'saved' : 'manual')
const personId = ref('')
const name = ref('')
const phone = ref('')

const dateError = ref('')
const personError = ref('')
const nameError = ref('')
const phoneError = ref('')

// 照片是短效網址：以「網址」記錄失敗，換到新網址時會重新嘗試載入
const failedPhotos = reactive(new Set<string>())

const maxDate = computed(() => addDays(props.today, props.maxDaysAhead))

/** 'MM/DD' */
function monthDay(date: string): string {
  return `${date.slice(5, 7)}/${date.slice(8, 10)}`
}

const rangeHint = computed(
  () => `可選 ${monthDay(props.today)}～${monthDay(maxDate.value)}（今天起 ${props.maxDaysAhead} 天內）`,
)

const sourceItems = computed<SegmentItem[]>(() => [
  { value: 'saved', label: '常用接送人', icon: 'group', disabled: props.persons.length === 0 },
  { value: 'manual', label: '臨時填寫', icon: 'edit' },
])

/** 姓名首字；用 Array.from 避免把罕用字（兩個 UTF-16 code unit）切成一半 */
function initial(p: PickupPerson): string {
  return Array.from(p.name)[0] ?? ''
}

function showPhoto(p: PickupPerson): boolean {
  return !!p.photo_url && !failedPhotos.has(p.photo_url)
}

function onPhotoError(p: PickupPerson): void {
  if (p.photo_url) failedPhotos.add(p.photo_url)
}

function onSourceChange(value: string): void {
  source.value = value === 'saved' ? 'saved' : 'manual'
}

watch(serviceDate, () => {
  dateError.value = ''
})
watch(personId, () => {
  personError.value = ''
})
watch(name, () => {
  nameError.value = ''
})
watch(phone, () => {
  phoneError.value = ''
})
watch(source, () => {
  personError.value = ''
  nameError.value = ''
  phoneError.value = ''
})

watch(
  () => props.persons,
  (list) => {
    if (!list.some((p) => p.id === personId.value)) personId.value = ''
    if (list.length === 0) source.value = 'manual'
  },
)

function onSubmit(): void {
  if (props.submitting) return
  const date = serviceDate.value
  let ok = true
  if (!date || date < props.today || date > maxDate.value) {
    dateError.value = `日期需在今天起 ${props.maxDaysAhead} 天內`
    ok = false
  }
  if (source.value === 'saved') {
    if (!personId.value) {
      personError.value = '請選擇接送人'
      ok = false
    }
    if (ok) emit('submit', { service_date: date, pickup_person_id: personId.value })
    return
  }
  const trimmedName = name.value.trim()
  const normalizedPhone = phone.value.replace(/[\s-]/g, '')
  if (!trimmedName) {
    nameError.value = '請輸入姓名'
    ok = false
  }
  if (!PHONE_PATTERN.test(normalizedPhone)) {
    phoneError.value = '請輸入正確的電話號碼'
    ok = false
  }
  if (ok) emit('submit', { service_date: date, proxy_name: trimmedName, proxy_phone: normalizedPhone })
}
</script>

<template>
  <form
    class="af"
    novalidate
    @submit.prevent="onSubmit"
  >
    <fieldset
      class="af-lock"
      :disabled="submitting"
    >
      <div class="af-group">
        <M3TextField
          v-model="serviceDate"
          label="接送日期"
          type="date"
          :min="today"
          :max="maxDate"
          :supporting-text="rangeHint"
          :error-text="dateError"
        />
      </div>

      <div class="af-group">
        <p
          :id="groupLabelId"
          class="af-label m3-title-small"
        >
          接送人
        </p>
        <M3SegmentedButton
          :model-value="source"
          :items="sourceItems"
          aria-label="接送人來源"
          @update:model-value="onSourceChange"
        />

        <template v-if="source === 'saved'">
          <div
            class="af-persons"
            :class="{ 'is-error': !!personError }"
            role="radiogroup"
            :aria-labelledby="groupLabelId"
          >
            <button
              v-for="p in persons"
              :key="p.id"
              type="button"
              role="radio"
              class="af-person m3-state"
              :class="{ 'is-checked': personId === p.id }"
              :aria-checked="personId === p.id ? 'true' : 'false'"
              @click="personId = p.id"
            >
              <M3Icon
                class="af-person__radio"
                :name="personId === p.id ? 'radio_button_checked' : 'radio_button_unchecked'"
                :filled="personId === p.id"
              />
              <span
                class="af-person__avatar m3-title-small"
                aria-hidden="true"
              >
                <img
                  v-if="showPhoto(p)"
                  :src="p.photo_url ?? undefined"
                  alt=""
                  loading="lazy"
                  @error="onPhotoError(p)"
                >
                <template v-else>{{ initial(p) }}</template>
              </span>
              <span class="af-person__text">
                <span class="af-person__name m3-body-large">{{ p.name }}</span>
                <span class="af-person__meta m3-body-medium">{{ p.relation }} · {{ p.phone }}</span>
              </span>
            </button>
          </div>
          <p
            v-if="personError"
            class="af-error m3-body-small"
            role="alert"
          >
            <M3Icon
              name="error"
              filled
              :size="16"
            />
            {{ personError }}
          </p>
        </template>

        <template v-else>
          <M3TextField
            v-model="name"
            label="姓名"
            :maxlength="50"
            autocomplete="off"
            :error-text="nameError"
          />
          <M3TextField
            v-model="phone"
            label="電話"
            type="tel"
            inputmode="tel"
            autocomplete="off"
            supporting-text="手機或市話，例如 0912-000-123"
            :error-text="phoneError"
          />
          <p
            v-if="persons.length === 0"
            class="af-help m3-body-small"
          >
            還沒有常用接送人；在「常用接送人」新增後，下次可直接從清單選擇。
          </p>
        </template>
      </div>

      <p class="af-note m3-body-medium">
        <M3Icon
          name="info"
          :size="18"
        />
        <span>代理人到場時出示接送碼，或由老師核對身分後交付。</span>
      </p>
    </fieldset>

    <div class="af-actions">
      <M3Button
        variant="outlined"
        :disabled="submitting"
        @click="emit('cancel')"
      >
        取消
      </M3Button>
      <M3Button
        type="submit"
        :loading="submitting"
      >
        建立代理接送
      </M3Button>
    </div>
  </form>
</template>

<style scoped>
.af {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* submitting 時 fieldset disabled 鎖定全部欄位；display: contents 讓子區塊直接參與 .af 的間距 */
.af-lock {
  display: contents;
}

.af-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.af-label {
  margin: 0;
  color: var(--m3-on-surface);
}

.af-persons {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--m3-outline-variant);
  border-radius: var(--m3-shape-medium);
}

.af-persons.is-error {
  border-color: var(--m3-error);
}

.af-person {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 64px;
  padding: 8px 16px 8px 12px;
  border: none;
  background: transparent;
  color: var(--m3-on-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.af-person + .af-person {
  border-top: 1px solid var(--m3-outline-variant);
}

.af-person::before {
  background: var(--m3-on-surface);
}

.af-person:focus-visible {
  outline: 2px solid var(--m3-primary);
  outline-offset: -2px;
}

.af-person.is-checked {
  background: var(--m3-secondary-container);
  color: var(--m3-on-secondary-container);
}

.af-person__radio {
  color: var(--m3-on-surface-variant);
}

.af-person.is-checked .af-person__radio {
  color: var(--m3-primary);
}

.af-person__avatar {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  overflow: hidden;
  border-radius: var(--m3-shape-full);
  background: var(--m3-tertiary-container);
  color: var(--m3-on-tertiary-container);
}

.af-person__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.af-person__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.af-person__name,
.af-person__meta {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.af-person__meta {
  color: var(--m3-on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.af-person.is-checked .af-person__meta {
  color: var(--m3-on-secondary-container);
}

.af-error {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 0 4px;
  color: var(--m3-error);
}

.af-help {
  margin: 0;
  padding: 0 4px;
  color: var(--m3-on-surface-variant);
}

.af-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 12px 16px;
  border-radius: var(--m3-shape-medium);
  background: var(--m3-surface-container);
  color: var(--m3-on-surface-variant);
}

.af-note .m3-icon {
  margin-top: 1px;
}

/* 等寬並排：用 grid 而非 flex 1 1 0（flex 的基準寬會被左右 padding 撐開，送出中的按鈕少 8px 左內距就變窄） */
.af-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding-top: 4px;
}
</style>
