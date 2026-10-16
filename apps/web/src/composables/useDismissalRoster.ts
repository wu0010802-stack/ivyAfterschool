// FRONTEND-182：接送 POS 名單分組、班級欄計數與搜尋（純函式）。
// 移植 ivy FE:src/composables/useDismissalRoster.ts 的純函式設計（ACTIVE_STATUSES、activeCallStudentIds、matchStudent、
// buildRoster）；資料來源改為後端 GET /admin/pickup/roster 已分好組的結果（FRONTEND-180），去掉前端依 classroom 清單分組、
// 學期標籤、unknown 群組。
import type { PickupRequest, PickupRoster, PickupStudent, RosterStudent } from '@/api/pickupRequests'
import { PICKUP_OPEN_STATUSES } from '@/shared/types/api'

/** 進行中（佔用學生、不可重複建立請求）的接送狀態：pending / acknowledged / arrived */
export const OPEN_PICKUP_STATUSES: ReadonlySet<string> = new Set(PICKUP_OPEN_STATUSES)

/** 班級欄第一項：全部班級（加總） */
const ALL_KEY = 'all'
/** class_id 為 null 的未分班群組 */
const UNASSIGNED_KEY = 'unassigned'
const ALL_LABEL = '全部班級'
const UNASSIGNED_LABEL = '未分班'

export interface RailItem {
  /** 'all' / class_id / 'unassigned' */
  key: string
  classId: string | null
  label: string
  /** 該班學生數（請假 / 缺席者也計入） */
  total: number
  /** open_request 不為 null 的人數 */
  openCount: number
  /** open_request.status 為 arrived 的人數 */
  arrivedCount: number
}

/** 目前有進行中請求的 student_id 集合（用於避免對同一學生重複發起，後端會回 409 pickup_request_exists） */
export function openRequestStudentIds(
  requests: ReadonlyArray<Pick<PickupRequest, 'status'> & { student: Pick<PickupStudent, 'id'> }>,
): Set<string> {
  const ids = new Set<string>()
  for (const r of requests) {
    if (OPEN_PICKUP_STATUSES.has(r.status)) ids.add(r.student.id)
  }
  return ids
}

const normalize = (text: string): string => text.replace(/\s/g, '').toLowerCase()

/** 去空白、不分大小寫，比對姓名或學號子字串；空 query 視為全中 */
export function matchStudent(s: Pick<RosterStudent, 'name' | 'student_no'>, query: string): boolean {
  const q = normalize(query)
  if (!q) return true
  return normalize(s.name).includes(q) || normalize(s.student_no).includes(q)
}

function railItemOf(
  key: string,
  classId: string | null,
  label: string,
  students: readonly RosterStudent[],
): RailItem {
  let openCount = 0
  let arrivedCount = 0
  for (const s of students) {
    if (!s.open_request) continue
    openCount += 1
    if (s.open_request.status === 'arrived') arrivedCount += 1
  }
  return { key, classId, label, total: students.length, openCount, arrivedCount }
}

const classKey = (classId: string | null): string => classId ?? UNASSIGNED_KEY

/** 第一項 'all'（全部班級，加總）；其後依 roster 順序每班一項，未分班的 key 為 'unassigned' */
export function buildClassRail(roster: PickupRoster): RailItem[] {
  const all = roster.classes.flatMap((c) => c.students)
  return [
    railItemOf(ALL_KEY, null, ALL_LABEL, all),
    ...roster.classes.map((c) =>
      railItemOf(classKey(c.class_id), c.class_id, c.class_name ?? UNASSIGNED_LABEL, c.students),
    ),
  ]
}

/** 班級欄選取項（'all' 為全部班級）過濾後的學生，保留 roster 的順序；key 找不到回空陣列 */
export function studentsForRail(roster: PickupRoster, key: string, query: string): RosterStudent[] {
  return roster.classes
    .filter((c) => key === ALL_KEY || classKey(c.class_id) === key)
    .flatMap((c) => c.students)
    .filter((s) => matchStudent(s, query))
}

/** 不可變更新單一學生（ws 事件 / 操作後就地更新名單）；回新物件，找不到學生回原物件 */
export function patchRosterStudent(
  roster: PickupRoster,
  studentId: string,
  patch: Partial<RosterStudent>,
): PickupRoster {
  if (!roster.classes.some((c) => c.students.some((s) => s.student_id === studentId))) return roster
  return {
    ...roster,
    classes: roster.classes.map((c) =>
      c.students.some((s) => s.student_id === studentId)
        ? { ...c, students: c.students.map((s) => (s.student_id === studentId ? { ...s, ...patch } : s)) }
        : c,
    ),
  }
}
