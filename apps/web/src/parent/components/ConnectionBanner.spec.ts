import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useParentWsStore } from '../stores/parentWs'
import ConnectionBanner from './ConnectionBanner.vue'
import source from './ConnectionBanner.vue?raw'

// 最小假 WebSocket：只做 parentWs 需要的 open / close
class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  close(): void {
    this.readyState = 3
  }

  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverClose(code: number): void {
    this.readyState = 3
    this.onclose?.({ code, reason: '', wasClean: false } as CloseEvent)
  }
}

function lastSocket(): FakeWebSocket {
  const s = FakeWebSocket.instances.at(-1)
  if (!s) throw new Error('尚未建立 socket')
  return s
}

const WS_TEXT = '即時更新中斷，正在重新連線…'
const OFFLINE_TEXT = '目前離線，恢復網路後會自動更新'

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value })
}

function fire(type: 'online' | 'offline'): Promise<void> {
  window.dispatchEvent(new Event(type))
  return nextTick()
}

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await nextTick()
}

describe('ConnectionBanner', () => {
  let pinia: Pinia

  beforeEach(() => {
    // setImmediate 保持真實，只釘住 banner 延遲與 ws 重連 / 輪詢用的計時器
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    FakeWebSocket.instances.length = 0
    vi.stubGlobal('WebSocket', FakeWebSocket)
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    useParentWsStore().disconnect()
    Reflect.deleteProperty(navigator, 'onLine')
    vi.useRealTimers()
  })

  function mountBanner(props: { delayMs?: number } = {}): VueWrapper {
    return mount(ConnectionBanner, { props, global: { plugins: [pinia] } })
  }

  /** 連線成功後非主動斷線：status 變成 reconnecting */
  async function dropWs(): Promise<void> {
    const ws = useParentWsStore()
    ws.connect()
    lastSocket().serverOpen()
    lastSocket().serverClose(1006)
    await nextTick()
  }

  const banner = (wrapper: VueWrapper) => wrapper.find('[role="status"]')

  it('ConnectionBanner delays ws banner', async () => {
    const wrapper = mountBanner()
    expect(banner(wrapper).exists()).toBe(false)

    await dropWs()
    expect(useParentWsStore().status).toBe('reconnecting')
    expect(wrapper.text()).not.toContain(WS_TEXT)

    await advance(2999)
    expect(wrapper.text()).not.toContain(WS_TEXT)
    expect(banner(wrapper).exists()).toBe(false)

    await advance(1)
    const el = banner(wrapper)
    expect(el.exists()).toBe(true)
    expect(el.text()).toContain(WS_TEXT)
    expect(el.classes()).toContain('conn-banner--ws')
    expect(el.get('.m3-icon').text()).toBe('sync_problem')
    const button = el.get('button')
    expect(button.text()).toBe('立即更新')
    expect(button.attributes('type')).toBe('button')
  })

  it('ConnectionBanner honours delayMs prop', async () => {
    const wrapper = mountBanner({ delayMs: 500 })
    await dropWs()

    await advance(499)
    expect(banner(wrapper).exists()).toBe(false)
    await advance(1)
    expect(banner(wrapper).text()).toContain(WS_TEXT)
  })

  it('ConnectionBanner hides on reconnect', async () => {
    const wrapper = mountBanner()
    await dropWs()
    await advance(3000)
    expect(banner(wrapper).text()).toContain(WS_TEXT)

    // 1 秒時 FRONTEND-004 已重連，開啟那條新 socket
    lastSocket().serverOpen()
    await nextTick()

    expect(useParentWsStore().status).toBe('open')
    expect(banner(wrapper).exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('ConnectionBanner short blip never shows', async () => {
    const wrapper = mountBanner()
    await dropWs()
    await advance(1000)
    lastSocket().serverOpen()
    await nextTick()

    await advance(10000)

    expect(banner(wrapper).exists()).toBe(false)
  })

  it('ConnectionBanner offline immediate', async () => {
    const wrapper = mountBanner()
    setOnLine(false)

    await fire('offline')

    const el = banner(wrapper)
    expect(el.text()).toContain(OFFLINE_TEXT)
    expect(el.classes()).toContain('conn-banner--offline')
    expect(el.get('.m3-icon').text()).toBe('wifi_off')
    expect(el.find('button').exists()).toBe(false)

    setOnLine(true)
    await fire('online')

    expect(banner(wrapper).exists()).toBe(false)
  })

  it('ConnectionBanner starts offline when navigator is offline', () => {
    setOnLine(false)
    const wrapper = mountBanner()

    expect(banner(wrapper).text()).toContain(OFFLINE_TEXT)
  })

  it('ConnectionBanner offline wins and restarts ws timer on reconnect', async () => {
    const wrapper = mountBanner()
    await dropWs()
    await advance(3000)
    expect(banner(wrapper).text()).toContain(WS_TEXT)

    setOnLine(false)
    await fire('offline')
    expect(banner(wrapper).text()).toContain(OFFLINE_TEXT)
    expect(banner(wrapper).text()).not.toContain(WS_TEXT)
    expect(banner(wrapper).find('button').exists()).toBe(false)

    // 網路恢復但 ws 仍在重連：從恢復那刻重新計時，不是立刻顯示
    setOnLine(true)
    await fire('online')
    expect(banner(wrapper).exists()).toBe(false)
    await advance(2999)
    expect(banner(wrapper).exists()).toBe(false)
    await advance(1)
    expect(banner(wrapper).text()).toContain(WS_TEXT)
  })

  it('ConnectionBanner manual refresh runs pollers', async () => {
    const wrapper = mountBanner()
    await dropWs()
    await advance(3000)
    const poller = vi.fn()
    useParentWsStore().registerPoller(poller)

    await banner(wrapper).get('button').trigger('click')

    expect(poller).toHaveBeenCalledTimes(1)
    // 不隱藏、不顯示 loading：直到 ws 回到 open
    expect(banner(wrapper).text()).toContain(WS_TEXT)
    expect(banner(wrapper).get('button').attributes('aria-busy')).toBeUndefined()
  })

  it('ConnectionBanner stays hidden when ws is disabled', async () => {
    const wrapper = mountBanner()
    const ws = useParentWsStore()
    ws.connect()
    lastSocket().serverOpen()
    lastSocket().serverClose(4401)
    await nextTick()
    expect(ws.enabled).toBe(false)
    expect(ws.status).toBe('closed')

    await advance(10000)

    expect(banner(wrapper).exists()).toBe(false)
  })

  it('ConnectionBanner cleans up on unmount', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const wrapper = mountBanner()
    await dropWs()
    const timersBefore = vi.getTimerCount()

    wrapper.unmount()

    const removed = removeSpy.mock.calls.map((c) => c[0])
    expect(removed).toContain('online')
    expect(removed).toContain('offline')
    // 延遲計時器被清掉（ws 重連 / 輪詢的計時器不是本元件的）
    expect(vi.getTimerCount()).toBe(timersBefore - 1)
  })

  it('ConnectionBanner style follows design decisions', () => {
    expect(source).toMatch(/\.conn-banner\s*\{[^}]*min-height:\s*48px/)
    expect(source).toMatch(/\.conn-banner\s*\{[^}]*padding:\s*4px 4px 4px 16px/)
    expect(source).toMatch(/\.conn-banner--offline\s*\{[^}]*var\(--m3-warning-container\)/)
    expect(source).toMatch(/\.conn-banner--offline\s*\{[^}]*var\(--m3-on-warning-container\)/)
    expect(source).toMatch(/\.conn-banner--ws\s*\{[^}]*var\(--m3-secondary-container\)/)
    expect(source).toMatch(/\.conn-banner--ws\s*\{[^}]*var\(--m3-on-secondary-container\)/)
    expect(source).toMatch(/\.conn-banner__action\s*\{[^}]*height:\s*40px/)
    expect(source).toMatch(/\.conn-banner__action\s*\{[^}]*font-weight:\s*700/)
    expect(source).toMatch(/\.conn-banner__action::after\s*\{[^}]*height:\s*48px/)
    expect(source).toMatch(/\.conn-banner__action:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor/)
    expect(source).toMatch(/\.conn-banner-enter-active[^{]*\{[^}]*var\(--m3-dur-medium-2\)/)
    expect(source).toMatch(/\.conn-banner-enter-active[^{]*\{[^}]*var\(--m3-easing-standard\)/)
    expect(source).toMatch(/prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.conn-banner-enter-active[^{]*\{[^}]*transition:\s*none/)
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
