// FRONTEND-312：測試共用的假 WebSocket（取代各 spec 自行定義的 class FakeWebSocket）。
// installFakeWebSocket() 以 vi.stubGlobal 安裝，之後程式 new WebSocket(...) 都會建立 FakeWebSocket 並記進 instances。
// 測試端以 open() / message() / close() / error() 模擬伺服器事件；個別 spec 特有的訊息封裝留在該 spec。
import { vi } from 'vitest'

export class FakeWebSocket {
  /** 目前安裝期間建立的所有連線（installFakeWebSocket 時清空；同一個陣列，可在 module 層先取參照） */
  static readonly instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  /** send 過的字串 */
  sent: string[] = []
  /** close() 被呼叫的次數 */
  closeCalls = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  /** 伺服器接受連線 */
  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  /** 伺服器送訊息：字串原樣送出，其他值 JSON.stringify */
  message(data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    this.onmessage?.({ data: text } as MessageEvent)
  }

  /** 連線關閉（程式呼叫 ws.close() 或測試模擬伺服器斷線）：readyState 變 3 並觸發 onclose */
  close(code = 1000, reason = ''): void {
    this.closeCalls += 1
    this.readyState = 3
    this.onclose?.({ code, reason, wasClean: false } as CloseEvent)
  }

  error(): void {
    this.onerror?.(new Event('error'))
  }
}

export interface InstalledFakeWebSocket {
  instances: FakeWebSocket[]
  /** 把 globalThis.WebSocket 還原成安裝前的值 */
  restore: () => void
}

export function installFakeWebSocket(): InstalledFakeWebSocket {
  const original = globalThis.WebSocket
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  return {
    instances: FakeWebSocket.instances,
    restore: () => {
      vi.stubGlobal('WebSocket', original)
    },
  }
}
