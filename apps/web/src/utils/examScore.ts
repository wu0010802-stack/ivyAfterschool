// FRONTEND-317：考試滿分輸入的共用判斷（ExamSubjectsEditor / ExamFormDialog）。
// 與後端 FullScore 一致：> 0、≤ 1000、最多兩位小數（numeric(6,2)）。
// 不直接比較 v * 100 是否為整數（1.15 * 100 === 114.99999999999999），以 Math.round 加容差判斷。
export const MAX_FULL_SCORE = 1000

const DECIMAL_TOLERANCE = 1e-6

export function isValidFullScore(v: number | null | undefined): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false
  if (v <= 0 || v > MAX_FULL_SCORE) return false
  return Math.abs(Math.round(v * 100) - v * 100) < DECIMAL_TOLERANCE
}
