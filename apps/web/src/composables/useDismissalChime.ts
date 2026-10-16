// FRONTEND-187：家長到達提示音、新請求提示音、中文語音與靜音（domain_spec M7 流程 4：家長按「我到了」員工端提示音）。
// 移植 ivy FE:src/composables/useDismissalChime.ts 的 drawChimeTones（到達雙音）、drawSoftChime（C5 單音）、
// speakZh / unlockSpeechZh（zh-TW voice 選擇、無中文 voice 時不播）；去掉 reservation chime。
// 音效與語音都是 best-effort：AudioContext 尚未被使用者手勢解鎖、瀏覽器不支援語音時靜默略過，不 throw。
// 由呼叫端（usePickupBoard，FRONTEND-188）在 ws 事件到達時呼叫 onArrived / onNewRequest，並在第一次使用者手勢呼叫 unlock。
import { ref, type Ref } from 'vue'
import type { PickupStudent } from '@/api/pickupRequests'
import { todayTaipei } from '@/shared/utils/datetime'

/** 靜音偏好存在 localStorage（只是個人偏好，讀寫失敗不影響功能） */
const MUTE_STORAGE_KEY = 'pickup.chimeMuted'

/** 這個時間內的多筆 arrived 合併為一次雙音（語音仍每筆各播） */
export const ARRIVED_BATCH_WINDOW_MS = 2000

export const SOFT_CHIME_FREQ = 523.25 // C5 單音
export const SOFT_CHIME_GAIN = 0.06

// 到達雙音：C5 → G5（上行五度），triangle 波形與短包絡，比單音醒目又不尖銳
export const CHIME_TONES = [
  { freq: 523.25, at: 0, dur: 0.28 },
  { freq: 783.99, at: 0.16, dur: 0.38 },
] as const
export const CHIME_PEAK_GAIN = 0.12

/** 在既有 audioCtx 上畫一個音（含包絡）；呼叫端負責 muted 判斷、context 的 resume 與例外捕捉 */
function drawTone(audioCtx: AudioContext, freq: number, start: number, dur: number, gain: number): void {
  const osc = audioCtx.createOscillator()
  const g = audioCtx.createGain()
  osc.type = 'triangle'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.02)
  g.gain.exponentialRampToValueAtTime(0.001, start + dur)
  osc.connect(g).connect(audioCtx.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

/** 柔和單音（新請求） */
export function drawSoftChime(audioCtx: AudioContext, gain = SOFT_CHIME_GAIN): void {
  drawTone(audioCtx, SOFT_CHIME_FREQ, audioCtx.currentTime, 0.3, gain)
}

/** 到達雙音（家長已到） */
export function drawChimeTones(audioCtx: AudioContext, gain = CHIME_PEAK_GAIN): void {
  const t0 = audioCtx.currentTime
  for (const tone of CHIME_TONES) drawTone(audioCtx, tone.freq, t0 + tone.at, tone.dur, gain)
}

// ── 中文語音播報（Web Speech API，best-effort，不依賴 AudioContext）──
// 語速稍慢、音高微亮，讓班級與名字清楚又不顯得生硬
const SPEECH_RATE = 0.9
const SPEECH_PITCH = 1.04
const SPEECH_LANG = 'zh-TW'

/** speechSynthesis 是否可用（LINE in-app WebView 等環境多半不支援） */
function speechSupported(): boolean {
  return typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance === 'function'
}

// 優先精確 zh-TW，其次同語系前綴 zh；hasVoices = false 代表清單尚未載入（部分瀏覽器首次呼叫回空，需等 voiceschanged）
function pickZhVoice(): { hasVoices: boolean; voice: SpeechSynthesisVoice | null } {
  let voices: SpeechSynthesisVoice[] = []
  try {
    voices = globalThis.speechSynthesis.getVoices?.() ?? []
  } catch {
    // 取不到清單視為尚未載入
  }
  if (voices.length === 0) return { hasVoices: false, voice: null }
  const voice =
    voices.find((v) => v.lang === SPEECH_LANG) ??
    voices.find((v) => v.lang?.toLowerCase().startsWith('zh')) ??
    null
  return { hasVoices: true, voice }
}

/** 播放一段中文語音；voice 清單已載入但沒有中文 voice 時寧可不播，不用錯語系 voice 唸；清單尚未載入時帶 lang 退化播報 */
export function speakZh(text: string): void {
  if (!speechSupported()) return
  try {
    const { hasVoices, voice } = pickZhVoice()
    if (hasVoices && !voice) return
    const u = new globalThis.SpeechSynthesisUtterance(text)
    u.lang = SPEECH_LANG
    u.rate = SPEECH_RATE
    u.pitch = SPEECH_PITCH
    if (voice) u.voice = voice
    globalThis.speechSynthesis.speak(u)
  } catch {
    // best-effort
  }
}

/** 首次使用者手勢內預熱 speechSynthesis（部分瀏覽器需手勢才能發聲）：播一段無聲、空字串的 utterance */
export function unlockSpeechZh(): void {
  if (!speechSupported()) return
  try {
    const u = new globalThis.SpeechSynthesisUtterance('')
    u.lang = SPEECH_LANG
    u.volume = 0
    globalThis.speechSynthesis.speak(u)
  } catch {
    // best-effort
  }
}

export interface ChimeSpeech {
  speak(text: string): void
  unlock(): void
}

/** onArrived / onNewRequest 只用到 id 與學生姓名、班級（PickupRequest 符合此形狀） */
export interface ChimeRequest {
  id: string
  student: Pick<PickupStudent, 'name' | 'class_name'>
}

export interface DismissalChimeOptions {
  /** 測試注入；預設 new AudioContext（含 webkit 前綴） */
  audioContextFactory?: () => AudioContext
  /** 測試注入；預設 speakZh / unlockSpeechZh */
  speech?: ChimeSpeech
}

export interface DismissalChime {
  /** localStorage 'pickup.chimeMuted'；讀不到預設 false */
  muted: Ref<boolean>
  toggleMute(): void
  /** 第一次使用者手勢時呼叫：建立 / resume AudioContext 並預熱語音 */
  unlock(): void
  /** 雙音 + 語音「{班級} {學生} 家長到了」 */
  onArrived(req: ChimeRequest): void
  /** 單音（不播語音） */
  onNewRequest(req: ChimeRequest): void
}

function defaultAudioContextFactory(): AudioContext {
  const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) throw new Error('AudioContext unsupported')
  return new Ctor()
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeMuted(value: boolean): void {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, String(value))
  } catch {
    // 偏好存不下來只影響下次開啟
  }
}

function spokenText(req: ChimeRequest): string {
  const { class_name: className, name } = req.student
  return `${className ? `${className} ` : ''}${name} 家長到了`
}

export function useDismissalChime(opts: DismissalChimeOptions = {}): DismissalChime {
  const createContext = opts.audioContextFactory ?? defaultAudioContextFactory
  const speech: ChimeSpeech = opts.speech ?? { speak: speakZh, unlock: unlockSpeechZh }
  const muted = ref(readMuted())

  // 已播過的請求 id（跨台北日清空）：arrived 只播一次；新請求音也只播一次，且已播過 arrived 的不再補播
  const arrivedIds = new Set<string>()
  const newIds = new Set<string>()
  let dayKey = todayTaipei()
  // 雙音的批次視窗起點；null = 目前沒有進行中的視窗
  let toneWindowStart: number | null = null
  let ctx: AudioContext | null = null

  function rollDay(): void {
    const today = todayTaipei()
    if (today === dayKey) return
    dayKey = today
    arrivedIds.clear()
    newIds.clear()
  }

  function getContext(): AudioContext | null {
    if (ctx) return ctx
    try {
      ctx = createContext()
    } catch {
      ctx = null
    }
    return ctx
  }

  /** 已解鎖（running）直接畫；尚未解鎖先 resume，成功才畫、失敗靜默略過（不排進 suspended 的 context，避免日後解鎖時補播舊音） */
  function playTone(draw: (audioCtx: AudioContext) => void, onSkipped?: () => void): void {
    const audioCtx = getContext()
    if (!audioCtx) {
      onSkipped?.()
      return
    }
    const drawSafely = (): void => {
      try {
        draw(audioCtx)
      } catch {
        onSkipped?.()
      }
    }
    if (audioCtx.state === 'running') {
      drawSafely()
      return
    }
    try {
      Promise.resolve(audioCtx.resume()).then(drawSafely, () => onSkipped?.())
    } catch {
      onSkipped?.()
    }
  }

  function playArrivedTones(): void {
    const now = Date.now()
    if (toneWindowStart !== null && now - toneWindowStart < ARRIVED_BATCH_WINDOW_MS) return
    toneWindowStart = now
    playTone(drawChimeTones, () => {
      toneWindowStart = null
    })
  }

  function speak(text: string): void {
    try {
      speech.speak(text)
    } catch {
      // best-effort
    }
  }

  function toggleMute(): void {
    muted.value = !muted.value
    writeMuted(muted.value)
  }

  function unlock(): void {
    const audioCtx = getContext()
    if (audioCtx && audioCtx.state !== 'running') {
      try {
        Promise.resolve(audioCtx.resume()).catch(() => undefined)
      } catch {
        // 解鎖失敗等下一次手勢再試
      }
    }
    try {
      speech.unlock()
    } catch {
      // best-effort
    }
  }

  function onArrived(req: ChimeRequest): void {
    rollDay()
    if (arrivedIds.has(req.id)) return
    // 靜音時也記下：取消靜音後同一筆到達被補抓重送，不會補響舊的
    arrivedIds.add(req.id)
    if (muted.value) return
    playArrivedTones()
    speak(spokenText(req))
  }

  function onNewRequest(req: ChimeRequest): void {
    rollDay()
    if (arrivedIds.has(req.id) || newIds.has(req.id)) return
    newIds.add(req.id)
    if (muted.value) return
    playTone(drawSoftChime)
  }

  return { muted, toggleMute, unlock, onArrived, onNewRequest }
}
