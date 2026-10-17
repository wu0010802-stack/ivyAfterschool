<script setup lang="ts">
// FRONTEND-065：建立 / 編輯員工帳號（角色單選 + 個別權限調整）。移植 ivy FE:src/components/settings/SettingsAccountsTab.vue
// 的建立 / 編輯表單與角色卡選擇；去掉自訂密碼欄位（臨時密碼由後端產生）與 portal-only 角色。
// 設計稿：docs/mockups/page-settings-accounts.html（StaffUserFormDialog 段）。
// - PermissionPicker 勾選 = 最終有效權限；與所選角色 effective_permissions 的差集推導 extra / revoked。
// - 切換角色時保留仍有意義的 extra（新角色沒有的）與 revoked（新角色有的），其餘回到新角色預設。
// - 無法授出提示：新增的碼（編輯時不計目標原本就有的碼，與後端 BACKEND-089 / 090 相同）不在自己的權限內。
// - 編輯只送有變更的欄位；權限沒有變動時不送 extra / revoked（避免把冗餘的舊值正規化成「變更」）。
import { ArrowDown, ArrowRight, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { computed, reactive, ref, watch } from 'vue'
import type { PermissionCatalog, Role } from '@/api/roles'
import {
  createStaffUser,
  updateStaffUser,
  type StaffUser,
  type StaffUserCreate,
  type StaffUserCreated,
  type StaffUserUpdate,
} from '@/api/staffUsers'
import FormDialog from '@/components/common/FormDialog.vue'
import PermissionPicker from '@/components/settings/PermissionPicker.vue'
import RoleCardsGrid from '@/components/settings/RoleCardsGrid.vue'
import { useFormDirty } from '@/composables/useFormDirty'
import { errorCode, errorMessage, validationFieldErrors } from '@/shared/utils/errorMessage'
import { useAuthStore } from '@/stores/auth'
import { cannotGrantMessage } from '@/utils/cannotGrantMessage'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** 有值 = 編輯 */
    user?: StaffUser | null
    roles: Role[]
    catalog: PermissionCatalog
  }>(),
  { user: null },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [result: StaffUserCreated]
  updated: [user: StaffUser]
}>()

interface StaffForm {
  username: string
  display_name: string
  phone: string
  email: string
  role_id: string | null
  /** 最終有效權限（已排序） */
  picked: string[]
}

type FieldKey = 'username' | 'display_name' | 'phone' | 'email' | 'role_id'

/** 3~30 碼小寫英數與 . _ -；開頭須為英數（後端 USERNAME_PATTERN） */
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/
const USERNAME_FORMAT_ERROR = '3~30 碼，只能使用小寫英文、數字與 . _ -'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const FIELD_KEYS: FieldKey[] = ['username', 'display_name', 'phone', 'email', 'role_id']

const auth = useAuthStore()

const isEdit = computed(() => props.user !== null)
const isSelf = computed(() => props.user !== null && props.user.id === auth.user?.id)

function sorted(codes: Iterable<string>): string[] {
  return [...new Set(codes)].sort()
}

function minus(a: readonly string[], b: readonly string[]): string[] {
  const exclude = new Set(b)
  return a.filter((c) => !exclude.has(c))
}

function initialForm(): StaffForm {
  const u = props.user
  return {
    username: u?.username ?? '',
    display_name: u?.display_name ?? '',
    phone: u?.phone ?? '',
    email: u?.email ?? '',
    role_id: u?.role.id ?? null,
    picked: sorted(u?.effective_permissions ?? []),
  }
}

const form = reactive<StaffForm>(initialForm())
const errors = reactive<Record<FieldKey, string>>({ username: '', display_name: '', phone: '', email: '', role_id: '' })
const grantError = ref('')
const loading = ref(false)
const adjustOpen = ref(false)
const { isDirty, markClean } = useFormDirty(form)

function clearErrors(): void {
  for (const key of FIELD_KEYS) errors[key] = ''
  grantError.value = ''
}

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    Object.assign(form, initialForm())
    clearErrors()
    adjustOpen.value = !!props.user && (props.user.extra_permissions.length > 0 || props.user.revoked_permissions.length > 0)
    markClean()
  },
  { immediate: true },
)

const role = computed(() => props.roles.find((r) => r.id === form.role_id) ?? null)
const roleDefaults = computed(() => role.value?.effective_permissions ?? [])
const highlight = computed<ReadonlySet<string>>(() => new Set(roleDefaults.value))
const extra = computed(() => sorted(minus(form.picked, roleDefaults.value)))
const revoked = computed(() => sorted(minus(roleDefaults.value, form.picked)))
const adjusted = computed(() => extra.value.length > 0 || revoked.value.length > 0)
const summary = computed(() =>
  adjusted.value ? `額外授予 ${extra.value.length} 項、移除 ${revoked.value.length} 項` : '與角色預設相同',
)
const isAdjustOpen = computed(() => adjustOpen.value && role.value !== null)

const permissionLabels = computed(
  () => new Map(props.catalog.groups.flatMap((g) => g.permissions.map((p) => [p.code, p.label] as const))),
)

function label(code: string): string {
  return permissionLabels.value.get(code) ?? code
}

/** 送出會被 403 cannot_grant_permissions 擋下的碼：新增的、且自己沒有的 */
const notGrantable = computed(() => {
  const before = new Set(props.user?.effective_permissions ?? [])
  return form.picked.filter((c) => !before.has(c) && !auth.permissions.has(c))
})

function onRole(id: string): void {
  const next = props.roles.find((r) => r.id === id)
  if (!next) return
  const keepExtra = extra.value
  const keepRevoked = revoked.value
  form.role_id = id
  errors.role_id = ''
  const defaults = next.effective_permissions
  form.picked = sorted([...minus(defaults, keepRevoked), ...minus(keepExtra, defaults)])
}

function onPicked(codes: string[]): void {
  form.picked = sorted(codes)
}

function onUsername(value: string): void {
  form.username = value.toLowerCase()
  errors.username = ''
}

function validate(): boolean {
  if (!isEdit.value) {
    const username = form.username.trim()
    errors.username = !username ? '請輸入帳號' : USERNAME_RE.test(username) ? '' : USERNAME_FORMAT_ERROR
  }
  errors.display_name = form.display_name.trim() ? '' : '請輸入姓名'
  const email = form.email.trim()
  errors.email = !email || EMAIL_RE.test(email) ? '' : 'Email 格式不正確'
  errors.role_id = form.role_id ? '' : '請選擇角色'
  return FIELD_KEYS.every((key) => !errors[key])
}

function nullable(value: string): string | null {
  return value.trim() || null
}

function createBody(): StaffUserCreate {
  return {
    username: form.username.trim(),
    display_name: form.display_name.trim(),
    phone: nullable(form.phone),
    email: nullable(form.email),
    role_id: form.role_id!,
    extra_permissions: extra.value,
    revoked_permissions: revoked.value,
  }
}

function updateBody(user: StaffUser): StaffUserUpdate {
  const body: StaffUserUpdate = {}
  const displayName = form.display_name.trim()
  if (displayName !== user.display_name) body.display_name = displayName
  const phone = nullable(form.phone)
  if (phone !== user.phone) body.phone = phone
  const email = nullable(form.email)
  if (email !== user.email) body.email = email
  const roleChanged = form.role_id !== user.role.id
  if (roleChanged) body.role_id = form.role_id!
  const permsChanged = roleChanged || form.picked.join() !== sorted(user.effective_permissions).join()
  if (permsChanged) {
    if (extra.value.join() !== sorted(user.extra_permissions).join()) body.extra_permissions = extra.value
    if (revoked.value.join() !== sorted(user.revoked_permissions).join()) body.revoked_permissions = revoked.value
  }
  return body
}

function handleError(err: unknown): void {
  const code = errorCode(err)
  if (code === 'username_taken') {
    errors.username = '帳號已被使用'
    return
  }
  if (code === 'cannot_grant_permissions') {
    grantError.value = cannotGrantMessage(err, permissionLabels.value)
    adjustOpen.value = true
    return
  }
  const fieldErrors = validationFieldErrors(err)
  const mapped = FIELD_KEYS.filter((key) => fieldErrors[key])
  for (const key of mapped) errors[key] = fieldErrors[key]!
  if (!mapped.length) ElMessage.error(errorMessage(err, '儲存失敗，請稍後再試'))
}

async function submit(): Promise<void> {
  if (loading.value || !validate()) return
  grantError.value = ''
  loading.value = true
  try {
    const user = props.user
    if (user) {
      const updated = await updateStaffUser(user.id, updateBody(user))
      ElMessage.success('已更新')
      emit('updated', updated)
    } else {
      emit('created', await createStaffUser(createBody()))
    }
    emit('update:modelValue', false)
  } catch (err) {
    handleError(err)
  } finally {
    loading.value = false
  }
}

const title = computed(() => (props.user ? `編輯員工：${props.user.display_name}` : '新增員工'))
</script>

<template>
  <FormDialog
    :model-value="modelValue"
    :title="title"
    size="lg"
    :submit-text="isEdit ? '儲存' : '建立'"
    :loading="loading"
    :dirty="isDirty"
    :submit-disabled="isEdit && !isDirty"
    @update:model-value="emit('update:modelValue', $event)"
    @submit="submit"
  >
    <el-form
      label-position="top"
      :disabled="loading"
      @submit.prevent
    >
      <div class="staff-form__grid">
        <el-form-item
          label="帳號"
          :required="!isEdit"
          :error="errors.username"
        >
          <template v-if="!isEdit">
            <el-input
              class="staff-form__mono"
              :model-value="form.username"
              maxlength="30"
              placeholder="例如 tutor02"
              autocomplete="off"
              @update:model-value="onUsername"
            />
            <div
              v-if="!errors.username"
              class="staff-form__hint"
            >
              3~30 碼小寫英文、數字與 . _ -（輸入時自動轉小寫），建立後不可修改
            </div>
          </template>
          <span
            v-else
            class="staff-form__readonly staff-form__mono"
          >{{ form.username }}</span>
        </el-form-item>
        <el-form-item
          label="姓名"
          required
          :error="errors.display_name"
        >
          <el-input
            v-model="form.display_name"
            maxlength="30"
            show-word-limit
            placeholder="例如 陳老師"
            @input="errors.display_name = ''"
          />
        </el-form-item>
        <el-form-item
          label="電話"
          :error="errors.phone"
        >
          <el-input
            v-model="form.phone"
            maxlength="20"
            placeholder="例如 0912-000-123"
            @input="errors.phone = ''"
          />
        </el-form-item>
        <el-form-item
          label="Email"
          :error="errors.email"
        >
          <el-input
            v-model="form.email"
            maxlength="100"
            placeholder="選填"
            @input="errors.email = ''"
          />
        </el-form-item>
      </div>

      <div class="staff-form__section-title">
        角色<span
          v-if="!isSelf"
          class="staff-form__required"
        >*</span>
      </div>
      <el-alert
        v-if="isSelf"
        class="staff-form__self-alert"
        type="info"
        :closable="false"
        show-icon
        title="不可修改自己的權限"
        description="角色與個別權限需由其他有「管理員工帳號」權限的人調整；姓名、電話、Email 可以修改。"
      />
      <RoleCardsGrid
        :roles="roles"
        :model-value="form.role_id"
        :disabled="isSelf || loading"
        @update:model-value="onRole"
      />
      <div
        v-if="errors.role_id"
        class="staff-form__error"
        data-test="role-error"
      >
        {{ errors.role_id }}
      </div>
      <div
        v-if="!isSelf && notGrantable.length"
        class="staff-form__warn"
        role="status"
        data-test="ungrantable-warning"
      >
        <el-icon><WarningFilled /></el-icon>
        <span>包含你沒有的 {{ notGrantable.length }} 項權限（{{ notGrantable.map(label).join('、') }}），送出時會被拒絕。請改選其他角色，或在「個別權限調整」取消勾選這些權限。</span>
      </div>

      <div
        class="staff-form__adjust"
        :class="{ 'is-open': isAdjustOpen }"
      >
        <button
          type="button"
          class="staff-form__adjust-head"
          data-test="adjust-head"
          :disabled="!role"
          :aria-expanded="isAdjustOpen"
          @click="adjustOpen = !adjustOpen"
        >
          <el-icon>
            <ArrowDown v-if="isAdjustOpen" />
            <ArrowRight v-else />
          </el-icon>
          <span class="staff-form__adjust-title">個別權限調整</span>
          <span
            class="staff-form__adjust-summary"
            :class="{ 'is-changed': role && adjusted }"
          >{{ role ? summary : '請先選擇角色' }}</span>
        </button>
        <div
          v-if="isAdjustOpen"
          class="staff-form__adjust-body"
        >
          <p class="staff-form__hint staff-form__adjust-hint">
            勾選結果就是這位員工最後擁有的權限。標「角色預設」的是所選角色本來就有的；取消勾選 = 移除，勾選角色以外的 = 額外授予。
          </p>
          <el-alert
            v-if="grantError"
            class="staff-form__grant-alert"
            data-test="grant-error"
            type="error"
            show-icon
            :title="grantError"
            @close="grantError = ''"
          />
          <PermissionPicker
            :model-value="form.picked"
            :catalog="catalog"
            :grantable="auth.permissions"
            :highlight="highlight"
            :disabled="isSelf || loading"
            @update:model-value="onPicked"
          />
          <div
            v-if="adjusted"
            class="staff-form__diff"
            data-test="adjust-diff"
            aria-label="與角色預設的差異"
          >
            <el-tag
              v-for="c in extra"
              :key="`+${c}`"
              size="small"
              type="success"
              disable-transitions
            >
              ＋ {{ label(c) }}
            </el-tag>
            <el-tag
              v-for="c in revoked"
              :key="`-${c}`"
              size="small"
              type="danger"
              class="is-revoked"
              disable-transitions
            >
              － {{ label(c) }}
            </el-tag>
          </div>
        </div>
      </div>
      <el-alert
        v-if="grantError && !isAdjustOpen"
        class="staff-form__grant-alert staff-form__grant-alert--below"
        data-test="grant-error"
        type="error"
        show-icon
        :title="grantError"
        @close="grantError = ''"
      />
    </el-form>
  </FormDialog>
</template>

<style scoped>
.staff-form__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}

.staff-form__mono,
.staff-form__mono :deep(.el-input__inner) {
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
}

.staff-form__readonly {
  font-size: 14px;
  line-height: 32px;
  color: var(--el-text-color-regular);
}

.staff-form__hint {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.staff-form__section-title {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 4px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.staff-form__required {
  color: var(--el-color-danger);
}

.staff-form__self-alert {
  margin-bottom: 10px;
}

.staff-form__error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-color-danger);
}

.staff-form__warn {
  display: flex;
  gap: 4px;
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--el-color-warning-dark-2);
}

.staff-form__warn .el-icon {
  flex-shrink: 0;
  margin-top: 3px;
}

.staff-form__adjust {
  margin-top: 16px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.staff-form__adjust-head {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 10px 12px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--el-fill-color-lighter);
  border: none;
  border-radius: 8px;
}

.staff-form__adjust.is-open .staff-form__adjust-head {
  border-bottom: 1px solid var(--el-border-color-lighter);
  border-radius: 8px 8px 0 0;
}

.staff-form__adjust-head:disabled {
  color: var(--el-text-color-placeholder);
  cursor: not-allowed;
}

.staff-form__adjust-head:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 2px;
}

.staff-form__adjust-title {
  font-size: 14px;
  font-weight: 600;
}

.staff-form__adjust-summary {
  margin-left: auto;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.staff-form__adjust-summary.is-changed {
  color: var(--el-color-primary);
}

.staff-form__adjust-body {
  padding: 12px;
}

.staff-form__adjust-hint {
  margin: 0 0 10px;
}

.staff-form__grant-alert {
  margin-bottom: 10px;
}

.staff-form__grant-alert--below {
  margin-top: 10px;
  margin-bottom: 0;
}

.staff-form__diff {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 12px;
  margin-top: 12px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.staff-form__diff .is-revoked {
  text-decoration: line-through;
}
</style>
