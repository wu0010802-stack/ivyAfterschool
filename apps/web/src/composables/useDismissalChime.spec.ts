import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDismissalChime, type ChimeRequest } from './useDismissalChime'

const MUTE_KEY = 'pickup.chimeMuted'

interface FakeOscillator {
  type: string
  frequency: { value: number }
  connect: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

interface FakeAudioOptions {
  state?: AudioContextState
  resume?: () => Promise<void>
}

function fakeAudio(options: FakeAudioOptions = {}) {
  const oscillators: FakeOscillator[] = []
  const resume = vi.fn(options.resume ?? (() => Promise.resolve()))
  const createOscillator = vi.fn(() => {
    const osc: FakeOscillator = {
      type: '',
      frequency: { value: 0 },
      connect: vi.fn((node: unknown) => node),
      start: vi.fn(),
      stop: vi.fn(),
    }
    oscillators.push(osc)
    return osc
  })
  const createGain = vi.fn(() => ({
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn((node: unknown) => node),
  }))
  const ctx = { state: options.state ?? 'running', currentTime: 0, destination: {}, resume, createOscillator, createGain }
  return { ctx: ctx as unknown as AudioContext, createOscillator, oscillators, resume }
}

function fakeSpeech() {
  return { speak: vi.fn<(text: string) => void>(), unlock: vi.fn<() => void>() }
}

function req(id: string, name = '王小明', className: string | null = '低年級A班'): ChimeRequest {
  return { id, student: { name, class_name: className } }
}

function setup(options: FakeAudioOptions = {}) {
  const audio = fakeAudio(options)
  const speech = fakeSpeech()
  const chime = useDismissalChime({ audioContextFactory: () => audio.ctx, speech })
  return { ...audio, speech, chime }
}

describe('useDismissalChime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T09:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('useDismissalChime arrived plays tones and speech once per request', () => {
    const { chime, createOscillator, oscillators, speech } = setup()

    chime.onArrived(req('r1'))
    chime.onArrived(req('r1'))

    expect(createOscillator).toHaveBeenCalledTimes(2)
    expect(oscillators.map((o) => o.frequency.value)).toEqual([523.25, 783.99])
    expect(oscillators.every((o) => o.start.mock.calls.length === 1)).toBe(true)
    expect(speech.speak).toHaveBeenCalledTimes(1)
    expect(speech.speak).toHaveBeenCalledWith('低年級A班 王小明 家長到了')
  })

  it('useDismissalChime arrived without class name speaks only the student', () => {
    const { chime, speech } = setup()

    chime.onArrived(req('r1', '林小美', null))

    expect(speech.speak).toHaveBeenCalledWith('林小美 家長到了')
  })

  it('useDismissalChime muted suppresses all sounds and persists', () => {
    const { chime, createOscillator, speech } = setup()

    chime.toggleMute()
    chime.onArrived(req('r1'))
    chime.onNewRequest(req('r2'))

    expect(chime.muted.value).toBe(true)
    expect(localStorage.getItem(MUTE_KEY)).toBe('true')
    expect(createOscillator).toHaveBeenCalledTimes(0)
    expect(speech.speak).toHaveBeenCalledTimes(0)

    const again = useDismissalChime({ audioContextFactory: () => fakeAudio().ctx, speech: fakeSpeech() })
    expect(again.muted.value).toBe(true)

    again.toggleMute()
    expect(again.muted.value).toBe(false)
    expect(localStorage.getItem(MUTE_KEY)).toBe('false')
    expect(useDismissalChime().muted.value).toBe(false)
  })

  it('useDismissalChime muted arrival is not replayed after unmute', () => {
    const { chime, createOscillator, speech } = setup()

    chime.toggleMute()
    chime.onArrived(req('r1'))
    chime.toggleMute()
    chime.onArrived(req('r1'))

    expect(createOscillator).toHaveBeenCalledTimes(0)
    expect(speech.speak).toHaveBeenCalledTimes(0)

    chime.onArrived(req('r2'))
    expect(createOscillator).toHaveBeenCalledTimes(2)
    expect(speech.speak).toHaveBeenCalledWith('低年級A班 王小明 家長到了')
  })

  it('useDismissalChime mute state survives unavailable storage', () => {
    const denied = () => {
      throw new Error('SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: denied, setItem: denied, removeItem: denied })
    const { chime, createOscillator } = setup()

    expect(chime.muted.value).toBe(false)
    expect(() => chime.toggleMute()).not.toThrow()
    expect(chime.muted.value).toBe(true)
    chime.onNewRequest(req('r1'))
    expect(createOscillator).toHaveBeenCalledTimes(0)
  })

  it('useDismissalChime new request plays soft tone without speech', () => {
    const { chime, createOscillator, oscillators, speech } = setup()

    chime.onNewRequest(req('r1'))

    expect(createOscillator).toHaveBeenCalledTimes(1)
    expect(oscillators[0]?.frequency.value).toBe(523.25)
    expect(speech.speak).toHaveBeenCalledTimes(0)
  })

  it('useDismissalChime new request plays once per request id', () => {
    const { chime, createOscillator } = setup()

    chime.onNewRequest(req('r1'))
    chime.onNewRequest(req('r1'))
    chime.onNewRequest(req('r2'))

    expect(createOscillator).toHaveBeenCalledTimes(2)
  })

  it('useDismissalChime batches arrivals within two seconds', () => {
    const { chime, createOscillator, speech } = setup()

    chime.onArrived(req('r1', '王小明'))
    vi.advanceTimersByTime(500)
    chime.onArrived(req('r2', '林小美', '中年級B班'))

    expect(createOscillator).toHaveBeenCalledTimes(2)
    expect(speech.speak.mock.calls.map((c) => c[0])).toEqual([
      '低年級A班 王小明 家長到了',
      '中年級B班 林小美 家長到了',
    ])
  })

  it('useDismissalChime plays tones again after the two second window', () => {
    const { chime, createOscillator, speech } = setup()

    chime.onArrived(req('r1'))
    vi.advanceTimersByTime(1999)
    chime.onArrived(req('r2'))
    expect(createOscillator).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(1)
    chime.onArrived(req('r3'))

    expect(createOscillator).toHaveBeenCalledTimes(4)
    expect(speech.speak).toHaveBeenCalledTimes(3)
  })

  it('useDismissalChime survives suspended audio context', async () => {
    const { chime, createOscillator, resume, speech } = setup({
      state: 'suspended',
      resume: () => Promise.reject(new Error('NotAllowedError')),
    })

    expect(() => chime.onArrived(req('r1'))).not.toThrow()
    expect(() => chime.onNewRequest(req('r2'))).not.toThrow()
    await flushPromises()

    expect(resume).toHaveBeenCalled()
    expect(createOscillator).toHaveBeenCalledTimes(0)
    expect(speech.speak).toHaveBeenCalledWith('低年級A班 王小明 家長到了')
  })

  it('useDismissalChime plays after a suspended context resumes', async () => {
    const { chime, createOscillator, resume } = setup({ state: 'suspended' })

    chime.onArrived(req('r1'))
    expect(createOscillator).toHaveBeenCalledTimes(0)
    await flushPromises()

    expect(resume).toHaveBeenCalledTimes(1)
    expect(createOscillator).toHaveBeenCalledTimes(2)
  })

  it('useDismissalChime retries tone after a failed resume', async () => {
    const audio = fakeAudio({ state: 'suspended', resume: () => Promise.reject(new Error('NotAllowedError')) })
    const chime = useDismissalChime({ audioContextFactory: () => audio.ctx, speech: fakeSpeech() })

    chime.onArrived(req('r1'))
    await flushPromises()
    audio.resume.mockImplementation(() => Promise.resolve())
    vi.advanceTimersByTime(500)
    chime.onArrived(req('r2'))
    await flushPromises()

    expect(audio.createOscillator).toHaveBeenCalledTimes(2)
  })

  it('useDismissalChime plays for first-seen arrived request', () => {
    const { chime, createOscillator, speech } = setup()

    chime.onArrived(req('r5'))
    expect(createOscillator).toHaveBeenCalledTimes(2)
    expect(speech.speak).toHaveBeenCalledTimes(1)

    chime.onNewRequest(req('r5'))
    expect(createOscillator).toHaveBeenCalledTimes(2)
  })

  it('useDismissalChime new request then arrival plays both', () => {
    const { chime, createOscillator, speech } = setup()

    chime.onNewRequest(req('r1'))
    chime.onArrived(req('r1'))

    expect(createOscillator).toHaveBeenCalledTimes(3)
    expect(speech.speak).toHaveBeenCalledTimes(1)
  })

  it('useDismissalChime forgets played requests after taipei midnight', () => {
    vi.setSystemTime(new Date('2026-10-02T15:59:00Z'))
    const { chime, createOscillator, speech } = setup()

    chime.onArrived(req('r1'))
    chime.onNewRequest(req('r2'))
    vi.setSystemTime(new Date('2026-10-02T16:01:00Z'))
    chime.onArrived(req('r1'))
    chime.onNewRequest(req('r2'))

    expect(createOscillator).toHaveBeenCalledTimes(6)
    expect(speech.speak).toHaveBeenCalledTimes(2)
  })

  it('useDismissalChime unlock creates the context once, resumes it and warms speech', async () => {
    const audio = fakeAudio({ state: 'suspended' })
    const factory = vi.fn(() => audio.ctx)
    const speech = fakeSpeech()
    const chime = useDismissalChime({ audioContextFactory: factory, speech })

    chime.unlock()
    chime.unlock()
    await flushPromises()

    expect(factory).toHaveBeenCalledTimes(1)
    expect(audio.resume).toHaveBeenCalled()
    expect(speech.unlock).toHaveBeenCalled()
  })

  it('useDismissalChime unlock tolerates a rejected resume and a missing audio context', async () => {
    const rejecting = fakeAudio({ state: 'suspended', resume: () => Promise.reject(new Error('NotAllowedError')) })
    const speech = fakeSpeech()

    const a = useDismissalChime({ audioContextFactory: () => rejecting.ctx, speech })
    expect(() => a.unlock()).not.toThrow()
    await flushPromises()

    const missing = useDismissalChime({
      audioContextFactory: () => {
        throw new Error('AudioContext unsupported')
      },
      speech,
    })
    expect(() => missing.unlock()).not.toThrow()
    expect(() => missing.onArrived(req('r1'))).not.toThrow()
    expect(speech.speak).toHaveBeenCalledWith('低年級A班 王小明 家長到了')
  })

  it('useDismissalChime speaks with the zh-TW voice through the default speech', () => {
    const spoken: Array<{ text: string; lang: string; voice: unknown }> = []
    class FakeUtterance {
      lang = ''
      rate = 1
      pitch = 1
      volume = 1
      voice: unknown = null
      constructor(public text: string) {}
    }
    const zhTw = { lang: 'zh-TW', name: 'Mei-Jia' }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [{ lang: 'en-US', name: 'Alex' }, zhTw],
      speak: (u: FakeUtterance) => spoken.push({ text: u.text, lang: u.lang, voice: u.voice }),
    })
    const chime = useDismissalChime({ audioContextFactory: () => fakeAudio().ctx })

    chime.unlock()
    chime.onArrived(req('r1'))

    expect(spoken).toEqual([
      { text: '', lang: 'zh-TW', voice: null },
      { text: '低年級A班 王小明 家長到了', lang: 'zh-TW', voice: zhTw },
    ])
  })

  it('useDismissalChime default speech stays silent without a chinese voice', () => {
    const speak = vi.fn()
    vi.stubGlobal('SpeechSynthesisUtterance', class {})
    vi.stubGlobal('speechSynthesis', { getVoices: () => [{ lang: 'en-US', name: 'Alex' }], speak })
    const chime = useDismissalChime({ audioContextFactory: () => fakeAudio().ctx })

    chime.onArrived(req('r1'))

    expect(speak).not.toHaveBeenCalled()
  })

  it('useDismissalChime default speech falls back to lang when voices are not loaded', () => {
    const spoken: Array<{ text: string; lang: string; voice: unknown }> = []
    class FakeUtterance {
      lang = ''
      voice: unknown = null
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [],
      speak: (u: FakeUtterance) => spoken.push({ text: u.text, lang: u.lang, voice: u.voice }),
    })
    const chime = useDismissalChime({ audioContextFactory: () => fakeAudio().ctx })

    chime.onArrived(req('r1'))

    expect(spoken).toEqual([{ text: '低年級A班 王小明 家長到了', lang: 'zh-TW', voice: null }])
  })

  it('useDismissalChime default speech tolerates missing speech synthesis', () => {
    vi.stubGlobal('speechSynthesis', undefined)
    const audio = fakeAudio()
    const chime = useDismissalChime({ audioContextFactory: () => audio.ctx })

    expect(() => chime.unlock()).not.toThrow()
    expect(() => chime.onArrived(req('r1'))).not.toThrow()
    expect(audio.createOscillator).toHaveBeenCalledTimes(2)
  })
})
