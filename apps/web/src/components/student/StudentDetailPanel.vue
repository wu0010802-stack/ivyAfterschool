<script setup lang="ts">
// FRONTEND-087：學生詳情（摘要 header + 基本資料 / 監護人 / 成績紀錄分頁 + 編輯 / 封存 / 永久刪除）。
// 移植 ivy FE:src/components/student/StudentDetailPanel.vue 的骨架；去掉 lifecycle、費用、活動、健康成長、溝通紀錄、IEP、
// 在學證明等分頁。設計稿：docs/mockups/page-students.html（詳情段）。
// - 切換學生時以序號防護，慢回應不覆蓋新學生。404 顯示「找不到此學生」；其他錯誤顯示重試。
// - 編輯 / 封存 / 照片更新 / 永久刪除後 emit changed，讓列表（FRONTEND-085 / 086）重新載入目前頁。
// - 監護人異動後靜默重抓詳情（更新分頁標題的人數，不顯示骨架）。分頁存在 ?tab=（basic / guardians / exams）。
import { Box, Delete, Edit, Lock, MoreFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { archiveStudent, getStudent, type StudentDetail } from '@/api/students'
import EmptyState from '@/components/common/EmptyState.vue'
import GuardianManager from '@/components/student/GuardianManager.vue'
import StudentExamHistoryTab from '@/components/student/StudentExamHistoryTab.vue'
import StudentFormDialog from '@/components/student/StudentFormDialog.vue'
import StudentPhotoUploader from '@/components/student/StudentPhotoUploader.vue'
import StudentPurgeDialog from '@/components/student/StudentPurgeDialog.vue'
import StudentSensitiveFields from '@/components/student/StudentSensitiveFields.vue'
import { PERMISSIONS } from '@/constants/permissions'
import { GENDER_LABELS, STUDENT_STATUS_META } from '@/shared/constants/statusLabels'
import { isApiError } from '@/shared/types/api'
import { formatDate } from '@/shared/utils/datetime'
import { errorMessage } from '@/shared/utils/errorMessage'
import { gradeLabel } from '@/utils/academicYear'
import { usePermission } from '@/utils/permission'

const props = defineProps<{ studentId: string }>()

const emit = defineEmits<{ changed: [] }>()

type DetailTab = 'basic' | 'guardians' | 'exams'

const route = useRoute()
const router = useRouter()
const { can } = usePermission()
const canWrite = computed(() => can(PERMISSIONS.STUDENTS_WRITE))
const canExams = computed(() => can(PERMISSIONS.EXAMS_READ))

// ---- 載入 ----
const detail = ref<StudentDetail | null>(null)
const state = ref<'loading' | 'ready' | 'not_found' | 'error'>('loading')
const loadError = ref('')
let loadSeq = 0

/** silent：已有畫面時重抓（不顯示骨架；失敗只提示） */
async function load(silent = false): Promise<void> {
  const seq = ++loadSeq
  const id = props.studentId
  if (!silent) {
    state.value = 'loading'
    detail.value = null
  }
  try {
    const result = await getStudent(id)
    if (seq !== loadSeq) return
    detail.value = result
    state.value = 'ready'
  } catch (err) {
    if (seq !== loadSeq) return
    if (isApiError(err) && err.status === 404) {
      detail.value = null
      state.value = 'not_found'
    } else if (silent && detail.value) {
      ElMessage.error(errorMessage(err, '無法重新載入學生資料，請稍後再試'))
    } else {
      loadError.value = errorMessage(err, '請稍後再試一次')
      state.value = 'error'
    }
  }
}

watch(
  () => props.studentId,
  () => void load(),
  { immediate: true },
)

const isArchived = computed(() => !!detail.value?.archived_at)
const editable = computed(() => canWrite.value && !isArchived.value)
const canPurge = computed(
  () => can(PERMISSIONS.STUDENTS_PURGE) && isArchived.value && detail.value?.status === 'withdrawn',
)

const schoolLine = computed(() => {
  const d = detail.value
  if (!d) return ''
  const school = d.school ? d.school.short_name || d.school.name : '未填就讀國小'
  return [school, d.school_class].filter(Boolean).join(' ')
})

// ---- 分頁（?tab=） ----
const activeTab = computed<DetailTab>(() => {
  const tab = route.query.tab
  if (tab === 'guardians') return 'guardians'
  if (tab === 'exams' && canExams.value) return 'exams'
  return 'basic'
})

function onTabChange(name: string | number): void {
  void router.replace({ query: { ...route.query, tab: String(name) } })
}

// ---- 編輯 / 照片 / 監護人 ----
const formOpen = ref(false)

function onSaved(saved: StudentDetail): void {
  detail.value = saved
  emit('changed')
}

function onPhotoUploaded(photoUrl: string): void {
  if (detail.value) detail.value = { ...detail.value, photo_url: photoUrl }
  emit('changed')
}

function onGuardiansChanged(): void {
  void load(true)
}

// ---- 封存 ----
const archiving = ref(false)

async function archive(): Promise<void> {
  const d = detail.value
  if (!d || archiving.value) return
  try {
    await ElMessageBox.confirm(`封存後此學生不會出現在出勤、接送等名單，確定要封存 ${d.name} 嗎？`, '封存學生', {
      type: 'warning',
      confirmButtonText: '封存',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return
  }
  archiving.value = true
  try {
    const archived = await archiveStudent(d.id)
    if (props.studentId === d.id) detail.value = archived
    ElMessage.success('已封存')
    emit('changed')
  } catch (err) {
    ElMessage.error(errorMessage(err, '封存失敗，請稍後再試'))
  } finally {
    archiving.value = false
  }
}

// ---- 永久刪除 ----
const purgeOpen = ref(false)

function onMoreCommand(command: string | number | object): void {
  if (command === 'purge') purgeOpen.value = true
}

async function onPurged(): Promise<void> {
  emit('changed')
  await load(true)
}
</script>

<template>
  <div class="student-detail">
    <div
      v-if="state === 'loading'"
      class="student-detail__skeleton"
    >
      <el-skeleton
        :rows="8"
        animated
      />
    </div>
    <EmptyState
      v-else-if="state === 'not_found'"
      title="找不到此學生，可能已被刪除"
    />
    <EmptyState
      v-else-if="state === 'error'"
      variant="error"
      title="無法載入學生資料"
      :description="loadError"
    >
      <template #action>
        <el-button @click="load()">
          重試
        </el-button>
      </template>
    </EmptyState>
    <template v-else-if="detail">
      <div class="detail-head">
        <StudentPhotoUploader
          :key="detail.id"
          :student-id="detail.id"
          :photo-url="detail.photo_url"
          :name="detail.name"
          :editable="editable"
          @uploaded="onPhotoUploaded"
        />
        <div class="detail-head__info">
          <h2 class="detail-head__name">
            {{ detail.name }}
            <el-tag
              :type="STUDENT_STATUS_META[detail.status].tone"
              disable-transitions
            >
              {{ STUDENT_STATUS_META[detail.status].label }}
            </el-tag>
          </h2>
          <div class="detail-head__meta">
            <span class="detail-head__no">{{ detail.student_no }}</span>・{{ gradeLabel(detail.grade_level) }}・{{
              detail.class?.name ?? '未分班'
            }}<br>{{ schoolLine }}
          </div>
          <div
            v-if="detail.archived_at"
            class="detail-head__archived"
          >
            <el-icon><Box /></el-icon> 已封存（{{ formatDate(detail.archived_at) }}）
          </div>
        </div>
        <div class="detail-head__actions">
          <template v-if="editable">
            <el-button
              :icon="Edit"
              @click="formOpen = true"
            >
              編輯
            </el-button>
            <el-button
              type="danger"
              plain
              :loading="archiving"
              @click="archive"
            >
              封存
            </el-button>
          </template>
          <el-dropdown
            v-if="canPurge"
            trigger="click"
            @command="onMoreCommand"
          >
            <el-button
              class="detail-head__more"
              text
              aria-label="更多操作"
            >
              <el-icon><MoreFilled /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="purge">
                  <span class="detail-danger-text"><el-icon><Delete /></el-icon>永久刪除</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>

      <el-tabs
        class="detail-tabs"
        :model-value="activeTab"
        @update:model-value="onTabChange"
      >
        <el-tab-pane
          label="基本資料"
          name="basic"
        >
          <el-descriptions
            :column="2"
            border
          >
            <el-descriptions-item label="性別">
              {{ detail.gender ? GENDER_LABELS[detail.gender] : '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="生日">
              {{ formatDate(detail.birthday) }}
            </el-descriptions-item>
            <el-descriptions-item label="入學日">
              {{ formatDate(detail.enrolled_on) }}
            </el-descriptions-item>
            <el-descriptions-item label="退班日">
              {{ formatDate(detail.withdrawn_on) }}
            </el-descriptions-item>
            <el-descriptions-item
              label="備註"
              :span="2"
            >
              <span class="detail-pre-line">{{ detail.note || '—' }}</span>
            </el-descriptions-item>
          </el-descriptions>
          <div class="detail-section-heading">
            <el-icon><Lock /></el-icon> 敏感資料
          </div>
          <StudentSensitiveFields :detail="detail" />
        </el-tab-pane>

        <el-tab-pane
          :label="`監護人（${detail.guardians.length}）`"
          name="guardians"
        >
          <GuardianManager
            :student-id="detail.id"
            :student-name="detail.name"
            :initial="detail.guardians"
            :readonly="isArchived"
            @change="onGuardiansChanged"
          />
        </el-tab-pane>

        <el-tab-pane
          v-if="canExams"
          label="成績紀錄"
          name="exams"
          lazy
        >
          <StudentExamHistoryTab :student-id="detail.id" />
        </el-tab-pane>
      </el-tabs>

      <template v-if="canWrite">
        <StudentFormDialog
          v-model="formOpen"
          :student="detail"
          @saved="onSaved"
        />
      </template>
      <StudentPurgeDialog
        v-if="canPurge"
        v-model="purgeOpen"
        :student="detail"
        @purged="onPurged"
      />
    </template>
  </div>
</template>

<style scoped>
.student-detail__skeleton {
  padding: 4px 0;
}

.detail-head {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.detail-head__info {
  flex: 1;
  min-width: 0;
}

.detail-head__name {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.detail-head__meta {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-regular);
}

.detail-head__no {
  font-family: var(--el-font-family-mono, ui-monospace, monospace);
}

.detail-head__archived {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: 4px;
  font-size: 13px;
  color: var(--el-color-warning-dark-2);
}

.detail-head__actions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
}

.detail-head__actions .el-button + .el-button {
  margin-left: 0;
}

.detail-head__more {
  width: 36px;
}

.detail-tabs {
  margin-top: 16px;
}

.detail-section-heading {
  display: flex;
  gap: 4px;
  align-items: center;
  margin: 20px 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.detail-pre-line {
  white-space: pre-line;
}
</style>

<style>
/* 下拉選單 teleport 到 body，scoped 樣式碰不到 */
.detail-danger-text {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  color: var(--el-color-danger);
}
</style>
