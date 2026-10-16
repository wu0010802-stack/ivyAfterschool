// PARENT-071：各小孩今日作業快取與 ws 即時套用（新寫功能）。
// - load 已有資料且非 force 直接回；同一 childId 進行中的請求共用（force 也共用）；失敗保留舊資料、設 errorByChild。
// - ws homework.progress_updated 只套用 date 為台北今日的事件（FRONTEND-003），updated_at 取信封 sent_at；
//   尚未載入的小孩也直接寫入（之後 load 非 force 會沿用）。
// - 斷線 / 重連由 parentWs poller 對已載入的小孩 force 重抓。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { todayTaipei } from '@/shared/utils/datetime'
import { getChildHomework, type HomeworkToday } from '../api/homework'
import { useParentWsStore } from './parentWs'

const LOAD_ERROR = '作業進度載入失敗'

/** `/api/ws/parent` 的 homework.progress_updated data（沒有 updated_at） */
export type HomeworkProgressEvent = Omit<HomeworkToday, 'updated_at'>

function isProgressEvent(value: unknown): value is HomeworkProgressEvent {
  if (value === null || typeof value !== 'object') return false
  const v = value as Partial<HomeworkProgressEvent>
  return typeof v.student_id === 'string' && typeof v.date === 'string' && Array.isArray(v.items)
}

export const useHomeworkTodayStore = defineStore('parentHomeworkToday', () => {
  const parentWs = useParentWsStore()

  const byChild = ref<Record<string, HomeworkToday>>({})
  const loadingByChild = ref<Record<string, boolean>>({})
  const errorByChild = ref<Record<string, string | null>>({})

  const pending = new Map<string, Promise<void>>()
  // clear() 遞增：進行中的回應回來時世代不同就丟棄
  let generation = 0

  function get(childId: string): HomeworkToday | null {
    return byChild.value[childId] ?? null
  }

  function load(childId: string, { force = false }: { force?: boolean } = {}): Promise<void> {
    if (!force && byChild.value[childId]) return Promise.resolve()
    const inFlight = pending.get(childId)
    if (inFlight) return inFlight
    const gen = generation
    loadingByChild.value[childId] = true
    errorByChild.value[childId] = null
    const request: Promise<void> = getChildHomework(childId)
      .then(
        (data) => {
          if (gen !== generation) return
          byChild.value[childId] = data
        },
        () => {
          if (gen !== generation) return
          errorByChild.value[childId] = LOAD_ERROR
        },
      )
      .finally(() => {
        if (pending.get(childId) === request) pending.delete(childId)
        if (gen === generation) loadingByChild.value[childId] = false
      })
    pending.set(childId, request)
    return request
  }

  function clear(): void {
    generation += 1
    pending.clear()
    byChild.value = {}
    loadingByChild.value = {}
    errorByChild.value = {}
  }

  parentWs.on('homework.progress_updated', (data, envelope) => {
    if (!isProgressEvent(data)) return
    if (data.date !== todayTaipei()) return
    byChild.value[data.student_id] = {
      student_id: data.student_id,
      date: data.date,
      items: data.items,
      overall_status: data.overall_status,
      ready_eta: data.ready_eta,
      note: data.note,
      updated_at: envelope.sent_at,
    }
  })

  parentWs.registerPoller(() =>
    Promise.all(Object.keys(byChild.value).map((childId) => load(childId, { force: true }))),
  )

  return {
    byChild,
    loadingByChild,
    errorByChild,
    get,
    load,
    clear,
  }
})
