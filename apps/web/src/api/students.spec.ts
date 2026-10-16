import type MockAdapter from 'axios-mock-adapter'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '@/shared/types/api'
import { createApiMock } from '@/test/helpers'
import { adminHttp } from './http'
import {
  archiveStudent,
  createStudent,
  downloadImportTemplate,
  executeImport,
  executePromotion,
  getStudent,
  listStudents,
  previewImport,
  previewPromotion,
  purgeStudent,
  updateStudent,
  uploadStudentPhoto,
  type StudentDetail,
} from './students'

const LIST_ITEM = {
  id: 's1',
  student_no: 'S1001',
  name: '王小明',
  gender: 'male',
  grade_level: 3,
  school: { id: 'sc1', name: '光復國小', short_name: '光復' },
  school_class: '3年2班',
  class: { id: 'c1', name: '低年級A班' },
  status: 'active',
  archived_at: null,
}

const DETAIL: StudentDetail = {
  id: 's1',
  student_no: 'S1001',
  name: '王小明',
  gender: 'male',
  grade_level: 3,
  school: { id: 'sc1', name: '光復國小', short_name: '光復' },
  school_class: '3年2班',
  class: { id: 'c1', name: '低年級A班' },
  status: 'active',
  archived_at: null,
  birthday: '2017-05-06',
  enrolled_on: '2025-09-01',
  withdrawn_on: null,
  note: '對花生過敏請注意',
  photo_url: null,
  has_id_number: false,
  has_health_note: false,
  sensitive: null,
  guardians: [],
}

function bodyOf(data: unknown): unknown {
  return JSON.parse(data as string)
}

describe('studentsApi', () => {
  let mock: MockAdapter

  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
  })

  it('studentsApi lists with filters', async () => {
    const params = { q: '王', class_id: 'c1', status: 'active' as const, page: 1, page_size: 20 }
    mock.onGet('/admin/students').reply(200, { items: [LIST_ITEM], total: 1 })

    const page = await listStudents(params)

    expect(page.items[0]?.student_no).toBe('S1001')
    expect(page.total).toBe(1)
    expect(mock.history.get[0]?.params).toEqual(params)
  })

  it('studentsApi gets creates and archives', async () => {
    const create = { student_no: 'S1001', name: '王小明', grade_level: 3, class_id: 'c1' }
    mock.onGet('/admin/students/s1').reply(200, DETAIL)
    mock.onPost('/admin/students').reply(201, DETAIL)
    mock.onPost('/admin/students/s1/archive').reply(200, { ...DETAIL, archived_at: '2026-10-02T08:00:00Z' })

    expect((await getStudent('s1')).note).toBe('對花生過敏請注意')
    expect((await createStudent(create)).id).toBe('s1')
    expect((await archiveStudent('s1')).archived_at).toBe('2026-10-02T08:00:00Z')
    expect(bodyOf(mock.history.post[0]?.data)).toEqual(create)
  })

  it('studentsApi encodes student id in path', async () => {
    mock.onGet('/admin/students/a%2Fb').reply(200, DETAIL)
    mock.onPatch('/admin/students/a%2Fb').reply(200, DETAIL)
    mock.onPost('/admin/students/a%2Fb/archive').reply(200, DETAIL)
    mock.onPost('/admin/students/a%2Fb/photo').reply(200, { photo_url: 'https://storage/x.jpg' })
    mock.onPost('/admin/students/a%2Fb/purge').reply(200, {
      student_id: 'a/b',
      purged_at: '2026-10-02T08:00:00Z',
      anonymized_student_no: 'PURGED-7F3A',
    })

    await getStudent('a/b')
    await updateStudent('a/b', { name: '王小明' })
    await archiveStudent('a/b')
    await uploadStudentPhoto('a/b', new File(['x'], 'me.jpg', { type: 'image/jpeg' }))
    await purgeStudent('a/b', 'S1001')

    expect(mock.history.get).toHaveLength(1)
    expect(mock.history.patch).toHaveLength(1)
    expect(mock.history.post).toHaveLength(3)
  })

  it('studentsApi update keeps null to clear sensitive field', async () => {
    const body = { health_note: null, note: '對花生過敏請注意' }
    mock.onPatch('/admin/students/s1').reply(200, DETAIL)

    const detail = await updateStudent('s1', body)

    expect(detail.id).toBe('s1')
    expect(bodyOf(mock.history.patch[0]?.data)).toEqual({ health_note: null, note: '對花生過敏請注意' })
  })

  it('studentsApi uploads photo as multipart', async () => {
    mock.onPost('/admin/students/s1/photo').reply(200, { photo_url: 'https://storage/x.jpg' })

    const res = await uploadStudentPhoto('s1', new File(['abc'], 'me.jpg', { type: 'image/jpeg' }))

    const sent = mock.history.post[0]?.data as FormData
    expect(sent).toBeInstanceOf(FormData)
    expect((sent.get('file') as File).name).toBe('me.jpg')
    expect(res.photo_url).toBe('https://storage/x.jpg')
  })

  it('studentsApi promotion preview and execute bodies', async () => {
    const preview = {
      from_academic_year: 114,
      to_academic_year: 115,
      promote: [{ id: 's1', student_no: 'S1001', name: '王小明', grade_from: 3, grade_to: 4, class_name: '低年級A班' }],
      graduate: [{ id: 's9', student_no: 'S1009', name: '林小美', grade_from: 6, grade_to: null, class_name: null }],
      total: 2,
      already_promoted: false,
    }
    mock.onPost('/admin/students/promote-grade').replyOnce(200, preview)
    mock.onPost('/admin/students/promote-grade').replyOnce(200, { promoted: 1, graduated: 1 })

    const got = await previewPromotion(114)
    const result = await executePromotion({ from_academic_year: 114, expected_total: 96, withdrawn_on: '2026-08-01' })

    expect(got.graduate[0]?.grade_to).toBeNull()
    expect(result).toEqual({ promoted: 1, graduated: 1 })
    expect(bodyOf(mock.history.post[0]?.data)).toEqual({ from_academic_year: 114, dry_run: true })
    expect(bodyOf(mock.history.post[1]?.data)).toEqual({
      from_academic_year: 114,
      dry_run: false,
      expected_total: 96,
      withdrawn_on: '2026-08-01',
    })
  })

  it('studentsApi promotion execute surfaces preview_stale', async () => {
    mock.onPost('/admin/students/promote-grade').reply(409, {
      error: { code: 'preview_stale', message: '名單已變動，請重新預覽', details: { expected_total: 96, total: 97 } },
    })

    const err = await executePromotion({ from_academic_year: 114, expected_total: 96 }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('preview_stale')
    expect((err as ApiError).details).toEqual({ expected_total: 96, total: 97 })
    expect(bodyOf(mock.history.post[0]?.data)).toEqual({
      from_academic_year: 114,
      dry_run: false,
      expected_total: 96,
    })
  })

  it('studentsApi import sends multipart fields', async () => {
    const file = new File(['xlsx'], 'students.xlsx')
    mock.onPost('/admin/students/import').replyOnce(200, {
      rows: [{ row_number: 2, display: { 學號: 'S2001' }, errors: [] }],
      total: 1,
      valid: 1,
      invalid: 0,
    })
    mock.onPost('/admin/students/import').replyOnce(200, { created: 1, student_ids: ['s2'] })
    mock.onPost('/admin/students/import').replyOnce(409, {
      error: { code: 'import_has_errors', message: '匯入檔有錯誤列', details: { total: 1, valid: 0, invalid: 1, rows: [] } },
    })

    const preview = await previewImport(file, 115)
    const created = await executeImport(file, 115)
    const err = await executeImport(file, 115).catch((e: unknown) => e)

    const previewForm = mock.history.post[0]?.data as FormData
    expect(previewForm).toBeInstanceOf(FormData)
    expect((previewForm.get('file') as File).name).toBe('students.xlsx')
    expect(previewForm.get('academic_year')).toBe('115')
    expect(previewForm.get('dry_run')).toBe('true')
    expect((mock.history.post[1]?.data as FormData).get('dry_run')).toBe('false')
    expect(preview.valid).toBe(1)
    expect(created.student_ids).toEqual(['s2'])
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('import_has_errors')
  })

  it('studentsApi purge posts confirmation', async () => {
    mock.onPost('/admin/students/s1/purge').replyOnce(200, {
      student_id: 's1',
      purged_at: '2026-10-02T08:00:00Z',
      anonymized_student_no: 'PURGED-7F3A',
    })
    mock.onPost('/admin/students/s1/purge').replyOnce(422, {
      error: { code: 'purge_confirmation_mismatch', message: '確認學號不符' },
    })

    const result = await purgeStudent('s1', 'S1001')
    const err = await purgeStudent('s1', 'S9999').catch((e: unknown) => e)

    expect(bodyOf(mock.history.post[0]?.data)).toEqual({ confirm_student_no: 'S1001' })
    expect(result.anonymized_student_no).toBe('PURGED-7F3A')
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(422)
    expect((err as ApiError).code).toBe('purge_confirmation_mismatch')
  })

  it('studentsApi downloads import template as blob', async () => {
    const disposition = "attachment; filename*=UTF-8''%E5%AD%B8%E7%94%9F%E5%8C%AF%E5%85%A5%E7%AF%84%E6%9C%AC.xlsx"
    mock.onGet('/admin/students/import-template').reply(200, new Blob(['xlsx']), {
      'content-disposition': disposition,
    })

    const res = await downloadImportTemplate()

    expect(mock.history.get[0]?.responseType).toBe('blob')
    expect(res.data).toBeInstanceOf(Blob)
    expect(res.headers['content-disposition']).toBe(disposition)
  })
})
