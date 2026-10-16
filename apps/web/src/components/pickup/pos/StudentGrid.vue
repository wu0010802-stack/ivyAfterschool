<script setup lang="ts">
// FRONTEND-192：接送 POS 中欄學生卡 grid。設計稿：docs/mockups/page-pickup-pos.html（中欄學生卡段）。
// 移植 ivy FE:src/components/dismissal/pos/DismissalPosStudentGrid.vue 的「useStudentPosStatus 算狀態 → sortWeight 排序 →
// auto-fill grid（卡片最小寬 148px）」；學生來源改為 FRONTEND-182 studentsForRail 的扁平結果（搜尋已過濾）。
// - 每位學生 useStudentPosStatus（FRONTEND-183）→ 依 sortWeight、再依學號排序。
// - groupByClass（全部班級）時依班級分組：RosterStudent 沒有班級欄位，以 rosterClasses（roster.classes）查所屬班級與組順序；
//   組標題「{班級}（{該組顯示人數}）」，沒有學生的組不顯示，班級為 null 或查不到的學生歸「未分班」。
// - 空清單：有搜尋「找不到符合的學生」；沒有搜尋時選了班級「此班級今天沒有學生」、全部班級「目前沒有在學學生」。
// - 標題列、搜尋框與載入骨架由頁面（FRONTEND-190）負責。
import { computed } from 'vue'
import type { RosterClass, RosterStudent } from '@/api/pickupRequests'
import EmptyState from '@/components/common/EmptyState.vue'
import { useStudentPosStatus, type PosStudentStatusResult } from '@/composables/useStudentPosStatus'
import StudentCard from './StudentCard.vue'

const props = defineProps<{
  /** studentsForRail(roster, selected, query) 的結果 */
  students: RosterStudent[]
  /** roster.classes：分組時查班級與組順序 */
  rosterClasses: RosterClass[]
  /** 倒數中的 student_id */
  stagingIds: ReadonlySet<string>
  canOperate: boolean
  /** 全部班級時 true */
  groupByClass: boolean
  /** 中欄搜尋字：只用來決定空狀態文字 */
  query: string
}>()

const emit = defineEmits<{
  'quick-dispatch': [student: RosterStudent]
  'focus-request': [requestId: string]
  'create-request': [student: RosterStudent]
}>()

interface GridEntry {
  student: RosterStudent
  status: PosStudentStatusResult
}

interface GridGroup {
  key: string
  label: string
  entries: GridEntry[]
}

const UNASSIGNED_KEY = 'unassigned'
const UNASSIGNED_LABEL = '未分班'

const classKey = (classId: string | null): string => classId ?? UNASSIGNED_KEY

function compareStudentNo(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortEntries(students: RosterStudent[]): GridEntry[] {
  return students
    .map((student) => ({ student, status: useStudentPosStatus(student) }))
    .sort(
      (a, b) =>
        a.status.sortWeight - b.status.sortWeight || compareStudentNo(a.student.student_no, b.student.student_no),
    )
}

function groupByRosterClass(students: RosterStudent[], rosterClasses: RosterClass[]): GridGroup[] {
  const keyOfStudent = new Map<string, string>()
  for (const c of rosterClasses) {
    for (const s of c.students) keyOfStudent.set(s.student_id, classKey(c.class_id))
  }
  const buckets = new Map<string, RosterStudent[]>()
  for (const s of students) {
    const key = keyOfStudent.get(s.student_id) ?? UNASSIGNED_KEY
    const bucket = buckets.get(key)
    if (bucket) bucket.push(s)
    else buckets.set(key, [s])
  }
  const groups: GridGroup[] = rosterClasses.map((c) => ({
    key: classKey(c.class_id),
    label: c.class_name ?? UNASSIGNED_LABEL,
    entries: sortEntries(buckets.get(classKey(c.class_id)) ?? []),
  }))
  // 查不到班級的學生：rosterClasses 沒有未分班組時另起一組
  const orphans = buckets.get(UNASSIGNED_KEY)
  if (orphans?.length && !groups.some((g) => g.key === UNASSIGNED_KEY)) {
    groups.push({ key: UNASSIGNED_KEY, label: UNASSIGNED_LABEL, entries: sortEntries(orphans) })
  }
  return groups.filter((g) => g.entries.length > 0)
}

const groups = computed<GridGroup[]>(() => {
  if (props.students.length === 0) return []
  if (!props.groupByClass) return [{ key: 'all', label: '', entries: sortEntries(props.students) }]
  return groupByRosterClass(props.students, props.rosterClasses)
})

const emptyText = computed(() => {
  if (props.query.trim()) return '找不到符合的學生'
  return props.groupByClass ? '目前沒有在學學生' : '此班級今天沒有學生'
})
</script>

<template>
  <div class="student-grid">
    <EmptyState
      v-if="groups.length === 0"
      variant="inline"
      :title="emptyText"
    />
    <template v-else>
      <section
        v-for="g in groups"
        :key="g.key"
        :aria-label="groupByClass ? g.label : undefined"
      >
        <h3
          v-if="groupByClass"
          class="student-grid__group"
        >
          {{ g.label }}（{{ g.entries.length }}）
        </h3>
        <div class="student-grid__cards">
          <StudentCard
            v-for="e in g.entries"
            :key="e.student.student_id"
            :student="e.student"
            :status="e.status"
            :staging="stagingIds.has(e.student.student_id)"
            :can-operate="canOperate"
            @quick-dispatch="emit('quick-dispatch', $event)"
            @focus-request="emit('focus-request', $event)"
            @create-request="emit('create-request', $event)"
          />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.student-grid__group {
  margin: 4px 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-regular);
}

.student-grid__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}
</style>
