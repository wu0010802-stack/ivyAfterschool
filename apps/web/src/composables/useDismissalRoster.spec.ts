import { describe, expect, it } from 'vitest'
import type { PickupRoster, RosterStudent } from '@/api/pickupRequests'
import {
  OPEN_PICKUP_STATUSES,
  buildClassRail,
  matchStudent,
  openRequestStudentIds,
  patchRosterStudent,
  studentsForRail,
} from './useDismissalRoster'

function student(id: string, name: string, no: string, extra: Partial<RosterStudent> = {}): RosterStudent {
  return {
    student_id: id,
    student_no: no,
    name,
    grade_level: 2,
    attendance_status: 'present',
    check_in_at: null,
    check_out_at: null,
    leave_type: null,
    homework_status: null,
    ready_eta: null,
    open_request: null,
    active_authorization_count: 0,
    ...extra,
  }
}

function makeRoster(): PickupRoster {
  return {
    date: '2026-10-02',
    classes: [
      {
        class_id: 'c1',
        class_name: '低年級A班',
        students: [
          student('s1', '王小明', 'S1001', {
            open_request: { id: 'r1', status: 'arrived', expected_arrival_at: '17:30', needs_reply: false },
          }),
          student('s2', '林小美', 'S1002', {
            open_request: { id: 'r2', status: 'pending', expected_arrival_at: null, needs_reply: true },
          }),
          student('s3', '王大同', 'S1003', { attendance_status: 'leave', leave_type: 'sick' }),
        ],
      },
      { class_id: null, class_name: '未分班', students: [student('s4', '陳小安', 'S3001')] },
    ],
  }
}

describe('useDismissalRoster', () => {
  it('useDismissalRoster builds rail with all item and counts', () => {
    const rail = buildClassRail(makeRoster())

    expect(rail.map((r) => r.key)).toEqual(['all', 'c1', 'unassigned'])
    expect(rail[0]).toEqual({ key: 'all', classId: null, label: '全部班級', total: 4, openCount: 2, arrivedCount: 1 })
    expect(rail[1]).toEqual({ key: 'c1', classId: 'c1', label: '低年級A班', total: 3, openCount: 2, arrivedCount: 1 })
    expect(rail[2]).toEqual({ key: 'unassigned', classId: null, label: '未分班', total: 1, openCount: 0, arrivedCount: 0 })
  })

  it('useDismissalRoster rail counts leave students in total and falls back to unassigned label', () => {
    const roster: PickupRoster = {
      date: '2026-10-02',
      classes: [{ class_id: null, class_name: null, students: [student('s9', '王小明', 'S9', { attendance_status: 'absent' })] }],
    }

    const rail = buildClassRail(roster)

    expect(rail.map((r) => [r.key, r.label, r.total])).toEqual([
      ['all', '全部班級', 1],
      ['unassigned', '未分班', 1],
    ])
  })

  it('useDismissalRoster builds only the all item for an empty roster', () => {
    const rail = buildClassRail({ date: '2026-10-02', classes: [] })

    expect(rail).toEqual([{ key: 'all', classId: null, label: '全部班級', total: 0, openCount: 0, arrivedCount: 0 }])
  })

  it('useDismissalRoster matches name or student number', () => {
    const s = { name: '王小明', student_no: 'S1001' }

    expect(matchStudent(s, ' s100 ')).toBe(true)
    expect(matchStudent(s, '小明')).toBe(true)
    expect(matchStudent(s, '林')).toBe(false)
    expect(matchStudent(s, '')).toBe(true)
    expect(matchStudent(s, '   ')).toBe(true)
    expect(matchStudent(s, '王 小 明')).toBe(true)
    expect(matchStudent({ name: 'Mary Ann', student_no: 'S2' }, 'MARY ANN')).toBe(true)
  })

  it('useDismissalRoster studentsForRail filters by class and query', () => {
    const roster = makeRoster()

    expect(studentsForRail(roster, 'c1', '王').map((s) => s.student_id)).toEqual(['s1', 's3'])
    expect(studentsForRail(roster, 'c1', '').map((s) => s.student_id)).toEqual(['s1', 's2', 's3'])
    expect(studentsForRail(roster, 'all', '').map((s) => s.student_id)).toEqual(['s1', 's2', 's3', 's4'])
    expect(studentsForRail(roster, 'all', 's300').map((s) => s.student_id)).toEqual(['s4'])
    expect(studentsForRail(roster, 'unassigned', '').map((s) => s.student_id)).toEqual(['s4'])
    expect(studentsForRail(roster, 'unassigned', '王')).toEqual([])
    expect(studentsForRail(roster, 'missing', '')).toEqual([])
  })

  it('useDismissalRoster patches student immutably', () => {
    const roster = makeRoster()

    const patched = patchRosterStudent(roster, 's1', { attendance_status: 'left' })

    expect(patched).not.toBe(roster)
    expect(patched.classes[0]?.students[0]?.attendance_status).toBe('left')
    expect(roster.classes[0]?.students[0]?.attendance_status).toBe('present')
    expect(patched.classes[0]?.students[1]).toBe(roster.classes[0]?.students[1])
    expect(patched.classes[1]).toBe(roster.classes[1])
    expect(patchRosterStudent(roster, 'nope', { attendance_status: 'left' })).toBe(roster)
  })

  it('useDismissalRoster patch can clear open request', () => {
    const roster = makeRoster()

    const patched = patchRosterStudent(roster, 's1', { open_request: null })

    expect(patched.classes[0]?.students[0]?.open_request).toBeNull()
    expect(buildClassRail(patched)[0]).toMatchObject({ openCount: 1, arrivedCount: 0 })
  })

  it('useDismissalRoster open request student ids', () => {
    const ids = openRequestStudentIds([
      { status: 'pending', student: { id: 's1' } },
      { status: 'completed', student: { id: 's2' } },
      { status: 'arrived', student: { id: 's3' } },
      { status: 'cancelled', student: { id: 's4' } },
      { status: 'acknowledged', student: { id: 's5' } },
    ])

    expect([...ids].sort()).toEqual(['s1', 's3', 's5'])
    expect([...OPEN_PICKUP_STATUSES].sort()).toEqual(['acknowledged', 'arrived', 'pending'])
  })
})
