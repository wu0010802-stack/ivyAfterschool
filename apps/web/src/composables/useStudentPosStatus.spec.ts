import { describe, expect, it } from 'vitest'
import type { RosterOpenRequest, RosterStudent } from '@/api/pickupRequests'
import { POS_STATUS_META, useStudentPosStatus, type PosStudentStatus } from './useStudentPosStatus'

function student(extra: Partial<RosterStudent> = {}): RosterStudent {
  return {
    student_id: 's1',
    student_no: 'S1001',
    name: '王小明',
    grade_level: 3,
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

function request(extra: Partial<RosterOpenRequest> = {}): RosterOpenRequest {
  return { id: 'r1', status: 'pending', expected_arrival_at: '17:30', needs_reply: false, ...extra }
}

describe('useStudentPosStatus', () => {
  it('useStudentPosStatus open request beats attendance', () => {
    const requested = useStudentPosStatus(
      student({ attendance_status: 'left', open_request: request({ status: 'pending', needs_reply: true }) }),
    )
    const arrived = useStudentPosStatus(student({ open_request: request({ status: 'arrived' }) }))
    const acknowledged = useStudentPosStatus(student({ open_request: request({ status: 'acknowledged' }) }))

    expect(requested.status).toBe('requested')
    expect(requested.sortWeight).toBe(1)
    expect(requested.detail.needsReply).toBe(true)
    expect(requested.detail.requestId).toBe('r1')
    expect(requested.detail.requestStatus).toBe('pending')
    expect(arrived.status).toBe('arrived')
    expect(arrived.sortWeight).toBe(0)
    expect(acknowledged.status).toBe('requested')
  })

  it('useStudentPosStatus maps attendance states', () => {
    const of = (extra: Partial<RosterStudent>) => useStudentPosStatus(student(extra))

    const waiting = of({ attendance_status: 'present' })
    const notArrived = of({ attendance_status: 'expected' })
    const unknown = of({ attendance_status: null })
    const onLeave = of({ attendance_status: 'leave', leave_type: 'sick' })
    const absent = of({ attendance_status: 'absent' })
    const pickedUp = of({ attendance_status: 'left' })

    expect([waiting.status, waiting.sortWeight]).toEqual(['waiting', 2])
    expect([notArrived.status, notArrived.sortWeight]).toEqual(['not_arrived', 3])
    expect([unknown.status, unknown.sortWeight]).toEqual(['not_arrived', 3])
    expect([onLeave.status, onLeave.sortWeight]).toEqual(['on_leave', 5])
    expect(onLeave.detail.leaveType).toBe('sick')
    expect([absent.status, absent.sortWeight]).toEqual(['absent', 5])
    expect([pickedUp.status, pickedUp.sortWeight]).toEqual(['picked_up', 4])
  })

  it('useStudentPosStatus detail carries homework and authorization', () => {
    const { detail } = useStudentPosStatus(
      student({
        homework_status: 'in_progress',
        ready_eta: '17:30',
        active_authorization_count: 2,
        open_request: request({ expected_arrival_at: '17:40' }),
      }),
    )

    expect(detail.homeworkStatus).toBe('in_progress')
    expect(detail.readyEta).toBe('17:30')
    expect(detail.authorizationCount).toBe(2)
    expect(detail.expectedArrival).toBe('17:40')
  })

  it('useStudentPosStatus detail without request has no request fields', () => {
    const { detail } = useStudentPosStatus(student())

    expect(detail.requestId).toBeUndefined()
    expect(detail.requestStatus).toBeUndefined()
    expect(detail.needsReply).toBeUndefined()
    expect(detail.expectedArrival).toBeNull()
    expect(detail.authorizationCount).toBe(0)
  })

  it('useStudentPosStatus keeps request without expected arrival', () => {
    const { status, detail } = useStudentPosStatus(
      student({ open_request: request({ status: 'arrived', expected_arrival_at: null }) }),
    )

    expect(status).toBe('arrived')
    expect(detail.expectedArrival).toBeNull()
  })

  it('useStudentPosStatus meta covers all statuses', () => {
    expect(Object.keys(POS_STATUS_META).sort()).toEqual([
      'absent',
      'arrived',
      'not_arrived',
      'on_leave',
      'picked_up',
      'requested',
      'waiting',
    ])
    expect(POS_STATUS_META.arrived.label).toBe('家長已到')
    const tones = Object.fromEntries(
      (Object.keys(POS_STATUS_META) as PosStudentStatus[]).map((k) => [k, POS_STATUS_META[k].tone]),
    )
    expect(tones).toEqual({
      arrived: 'danger',
      requested: 'warning',
      waiting: 'success',
      not_arrived: 'info',
      picked_up: 'info',
      on_leave: 'info',
      absent: 'info',
    })
    expect(POS_STATUS_META.requested.label).toBe('接送中')
    expect(POS_STATUS_META.waiting.label).toBe('在班等待')
    expect(POS_STATUS_META.not_arrived.label).toBe('尚未到班')
    expect(POS_STATUS_META.picked_up.label).toBe('已離班')
    expect(POS_STATUS_META.on_leave.label).toBe('請假')
    expect(POS_STATUS_META.absent.label).toBe('缺席')
  })
})
