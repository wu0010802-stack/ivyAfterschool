<script setup lang="ts">
// FRONTEND-262：儀表板近期請假清單（GET /admin/dashboard/today 的 recent_leaves，BACKEND-490 / 492）。
// 設計稿：docs/mockups/page-dashboard.html（RecentLeavesList 段）。
// - 最多顯示 8 列；後端最多回 10 筆，不顯示剩餘筆數。
// - 回應只有 leave_type_label（沒有假別代碼），假別一律中性 info tag，不依 LEAVE_TYPE_META 上色。
// - 學生姓名在有 students:read 時為連結；「查看全部請假」需 leaves:read（空清單也顯示）。
import { ArrowRight } from '@element-plus/icons-vue'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { DashboardToday } from '@/api/dashboard'
import EmptyState from '@/components/common/EmptyState.vue'
import { formatDateTime, todayTaipei } from '@/shared/utils/datetime'
import { usePermission } from '@/utils/permission'

type RecentLeave = DashboardToday['recent_leaves'][number]

const RECENT_LIMIT = 8

const props = withDefaults(
  defineProps<{
    items: DashboardToday['recent_leaves']
    loading?: boolean
  }>(),
  { loading: false },
)

const router = useRouter()
const { can } = usePermission()

const shown = computed(() => props.items.slice(0, RECENT_LIMIT))

/** 同一天只顯示一天 */
function period(l: RecentLeave): string {
  return l.start_date === l.end_date ? l.start_date : `${l.start_date}~${l.end_date}`
}

/** 每次渲染重新取今天（儀表板定時重抓，跨午夜後要跟著變） */
function includesToday(l: RecentLeave): boolean {
  const today = todayTaipei()
  return l.start_date <= today && today <= l.end_date
}

function creatorLabel(l: RecentLeave): string {
  return l.created_by_type === 'parent' ? '家長申請' : '員工代登記'
}

function openStudent(l: RecentLeave): void {
  void router.push({ path: '/students', query: { student: l.student_id } })
}

function openLeaves(): void {
  void router.push('/leaves')
}
</script>

<template>
  <div class="rl">
    <div
      v-if="loading"
      class="rl__skeleton"
      aria-busy="true"
    >
      <el-skeleton
        :rows="3"
        animated
      />
    </div>
    <EmptyState
      v-else-if="!items.length"
      variant="inline"
      title="近期沒有請假"
    />
    <ul
      v-else
      class="rl__list"
      aria-label="近期請假"
    >
      <li
        v-for="l in shown"
        :key="l.id"
        class="rl__row"
      >
        <span class="rl__student">
          <el-button
            v-if="can('students:read')"
            link
            type="primary"
            @click="openStudent(l)"
          >
            {{ l.student_name }}
          </el-button>
          <span
            v-else
            class="rl__name"
          >{{ l.student_name }}</span>
          <span class="rl__class">{{ l.class_name || '未分班' }}</span>
        </span>
        <span class="rl__type">
          <el-tag
            type="info"
            disable-transitions
          >
            {{ l.leave_type_label }}
          </el-tag>
        </span>
        <span class="rl__period">{{ period(l) }}<el-tag
          v-if="includesToday(l)"
          type="primary"
          effect="plain"
          size="small"
          disable-transitions
        >今天</el-tag></span>
        <span class="rl__meta">{{ creatorLabel(l) }}・{{ formatDateTime(l.created_at) }}</span>
      </li>
    </ul>
    <div
      v-if="can('leaves:read') && !loading"
      class="rl__foot"
    >
      <el-button
        link
        type="primary"
        @click="openLeaves"
      >
        查看全部請假<el-icon class="el-icon--right">
          <ArrowRight />
        </el-icon>
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.rl {
  container-type: inline-size;
  font-size: 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.rl__list {
  padding: 0;
  margin: 0;
  list-style: none;
}

.rl__row {
  display: grid;
  grid-template-columns: minmax(150px, 1.3fr) 76px minmax(190px, 1.4fr) minmax(190px, 1.3fr);
  gap: 12px;
  align-items: center;
  min-height: 48px;
  padding: 6px 16px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.rl__student {
  display: flex;
  gap: 8px;
  align-items: baseline;
  min-width: 0;
}

.rl__student .el-button {
  height: auto;
  padding: 0;
  font-weight: 600;
}

.rl__name {
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.rl__class {
  overflow: hidden;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rl__period {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rl__period .el-tag {
  margin-left: 6px;
}

.rl__meta {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

.rl__foot {
  display: flex;
  justify-content: flex-end;
  padding: 6px 12px;
}

.rl__foot .el-button {
  min-height: 32px;
}

.rl__skeleton {
  padding: 12px 16px;
}

/* 平板（1024 寬）的內容區較窄：欄寬與間距收緊 */
@container (max-width: 820px) {
  .rl__row {
    grid-template-columns: minmax(130px, 1.2fr) 68px minmax(176px, 1.4fr) minmax(176px, 1.3fr);
    gap: 10px;
  }
}

/* 更窄時改兩欄換行，避免橫向溢出 */
@container (max-width: 599.98px) {
  .rl__row {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 10px;
  }
}
</style>
