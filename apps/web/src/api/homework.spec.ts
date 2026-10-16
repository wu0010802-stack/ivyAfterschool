import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/shared/types/api'
import { createApiMock } from '@/test/helpers'
import {
  batchCreateHomeworkItems,
  createHomeworkItem,
  deleteHomeworkItem,
  fetchHomeworkBoard,
  updateHomeworkItem,
  updateHomeworkProgress,
  type HomeworkBoard,
} from './homework'
import { adminHttp } from './http'

const PROGRESS_IN_PROGRESS = {
  student_id: 's1',
  service_date: '2026-10-02',
  overall_status: 'in_progress',
  ready_eta: '17:30',
  note: null,
  eta_updated_at: '2026-10-02T08:00:00Z',
  eta_updated_by_name: '林老師',
}

const ITEM = {
  id: 'h1',
  student_id: 's1',
  service_date: '2026-10-02',
  subject_id: 'sub1',
  subject_name: '數學',
  title: '數學習作 p.12-13',
  status: 'doing',
  sort_order: 0,
  updated_at: '2026-10-02T08:00:00Z',
}

const BOARD: HomeworkBoard = {
  date: '2026-10-02',
  window: { past_days: 30, future_days: 7 },
  summary: { total: 1, done: 0, in_progress: 1, not_started: 0 },
  students: [
    {
      student_id: 's1',
      student_no: 'S1001',
      name: '王小明',
      class_id: 'c1',
      class_name: '低年級A班',
      attendance_status: 'present',
      items: [{ ...ITEM, status: 'doing' }],
      progress: { ...PROGRESS_IN_PROGRESS, overall_status: 'in_progress' },
    },
  ],
}

function bodyOf(data: unknown): unknown {
  return JSON.parse(data as string)
}

describe('homeworkApi', () => {
  let mock: MockAdapter

  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
  })

  it('homeworkApi board with filters', async () => {
    const params = { date: '2026-10-02', class_id: 'c1' }
    mock.onGet('/admin/homework/board').reply(200, BOARD)

    const board = await fetchHomeworkBoard(params)

    expect(board.students[0]?.progress.ready_eta).toBe('17:30')
    expect(board.students[0]?.items[0]?.title).toBe('數學習作 p.12-13')
    expect(board.window).toEqual({ past_days: 30, future_days: 7 })
    expect(mock.history.get[0]?.params).toEqual(params)
  })

  it('homeworkApi creates item and returns progress', async () => {
    const body = { student_id: 's1', service_date: '2026-10-02', subject_id: 'sub1', title: '數學習作 p.12-13' }
    mock.onPost('/admin/homework/items').reply(201, { item: ITEM, progress: PROGRESS_IN_PROGRESS })

    const res = await createHomeworkItem(body)

    expect(res.item.id).toBe('h1')
    expect(res.progress.overall_status).toBe('in_progress')
    expect(bodyOf(mock.history.post[0]?.data)).toEqual(body)
  })

  it('homeworkApi item mutations return progress', async () => {
    mock.onPatch('/admin/homework/items/h1').reply(200, {
      item: { ...ITEM, status: 'done' },
      progress: { ...PROGRESS_IN_PROGRESS, overall_status: 'done' },
    })
    mock.onDelete('/admin/homework/items/h1').reply(200, {
      item: null,
      progress: { ...PROGRESS_IN_PROGRESS, overall_status: 'not_started' },
    })

    const updated = await updateHomeworkItem('h1', { status: 'done' })
    const deleted = await deleteHomeworkItem('h1')

    expect(bodyOf(mock.history.patch[0]?.data)).toEqual({ status: 'done' })
    expect(updated.item.status).toBe('done')
    expect(updated.progress.overall_status).toBe('done')
    expect(deleted.item).toBeNull()
    expect(deleted.progress.overall_status).toBe('not_started')
  })

  it('homeworkApi update keeps null subject to clear', async () => {
    mock.onPatch('/admin/homework/items/h1').reply(200, { item: { ...ITEM, subject_id: null }, progress: PROGRESS_IN_PROGRESS })

    await updateHomeworkItem('h1', { subject_id: null, title: '國語第 5 課生字' })

    expect(bodyOf(mock.history.patch[0]?.data)).toEqual({ subject_id: null, title: '國語第 5 課生字' })
  })

  it('homeworkApi encodes ids in path', async () => {
    mock.onPatch('/admin/homework/items/a%2Fb').reply(200, { item: ITEM, progress: PROGRESS_IN_PROGRESS })
    mock.onDelete('/admin/homework/items/a%2Fb').reply(200, { item: null, progress: PROGRESS_IN_PROGRESS })
    mock.onPut('/admin/homework/progress/a%2Fb').reply(200, PROGRESS_IN_PROGRESS)

    await updateHomeworkItem('a/b', { title: 'x' })
    await deleteHomeworkItem('a/b')
    await updateHomeworkProgress('a/b', { overall: 'done' })

    expect(mock.history.patch).toHaveLength(1)
    expect(mock.history.delete).toHaveLength(1)
    expect(mock.history.put).toHaveLength(1)
  })

  it('homeworkApi progress keeps null eta', async () => {
    mock.onPut('/admin/homework/progress/s1').reply(200, { ...PROGRESS_IN_PROGRESS, ready_eta: null })

    const progress = await updateHomeworkProgress('s1', { service_date: '2026-10-02', ready_eta: null, note: null })

    expect(bodyOf(mock.history.put[0]?.data)).toEqual({ service_date: '2026-10-02', ready_eta: null, note: null })
    expect(progress.ready_eta).toBeNull()
    expect(progress.student_id).toBe('s1')
  })

  it('homeworkApi batch surfaces class errors', async () => {
    const body = { class_id: 'c1', service_date: '2026-10-02', subject_id: 'sub1', title: '國語第 5 課生字' }
    mock.onPost('/admin/homework/items/batch').replyOnce(201, { created: 1, items: [ITEM] })
    mock.onPost('/admin/homework/items/batch').replyOnce(422, {
      error: { code: 'no_students', message: '此班級沒有可新增作業的學生' },
    })

    const ok = await batchCreateHomeworkItems(body)
    const err = await batchCreateHomeworkItems(body).catch((e: unknown) => e)

    expect(ok.created).toBe(1)
    expect(bodyOf(mock.history.post[0]?.data)).toEqual(body)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
    expect((err as ApiError).code).toBe('no_students')
  })

  it('homeworkApi surfaces invalid service date on create', async () => {
    mock.onPost('/admin/homework/items').reply(422, {
      error: { code: 'invalid_service_date', message: '日期超出可登記範圍', details: { past_days: 30, future_days: 7 } },
    })

    const err = await createHomeworkItem({ student_id: 's1', service_date: '2025-01-01', title: '數學' }).catch(
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('invalid_service_date')
    expect((err as ApiError).details).toEqual({ past_days: 30, future_days: 7 })
  })
})
