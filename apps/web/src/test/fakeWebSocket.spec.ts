import { afterEach, describe, expect, it } from 'vitest'
import { FakeWebSocket, installFakeWebSocket } from './fakeWebSocket'

describe('fakeWebSocket', () => {
  let restore: (() => void) | null = null

  afterEach(() => {
    restore?.()
    restore = null
  })

  it('fakeWebSocket records sent frames', () => {
    const installed = installFakeWebSocket()
    restore = installed.restore

    const ws = new WebSocket('ws://x/ws')
    expect(installed.instances).toHaveLength(1)
    const fake = installed.instances[0]!
    expect(fake).toBe(ws as unknown as FakeWebSocket)
    expect(fake.url).toBe('ws://x/ws')
    expect(fake.readyState).toBe(0)

    const opened: string[] = []
    ws.onopen = (ev) => opened.push(ev.type)
    fake.open()
    expect(fake.readyState).toBe(1)
    expect(opened).toEqual(['open'])

    ws.send('a')
    expect(fake.sent).toEqual(['a'])
  })

  it('fakeWebSocket dispatches message and close', () => {
    const original = globalThis.WebSocket
    const installed = installFakeWebSocket()
    restore = installed.restore

    const ws = new WebSocket('ws://x/ws')
    const fake = installed.instances[0]!
    const data: unknown[] = []
    const closes: [number, string][] = []
    const errors: string[] = []
    ws.onmessage = (ev) => data.push(ev.data)
    ws.onclose = (ev) => closes.push([ev.code, ev.reason])
    ws.onerror = (ev) => errors.push(ev.type)

    fake.message({ type: 't' })
    fake.message('raw-text')
    expect(data).toEqual(['{"type":"t"}', 'raw-text'])

    fake.error()
    expect(errors).toEqual(['error'])

    fake.close(4401, 'x')
    expect(closes).toEqual([[4401, 'x']])
    expect(fake.readyState).toBe(3)
    expect(fake.closeCalls).toBe(1)

    installed.restore()
    restore = null
    expect(globalThis.WebSocket).toBe(original)
  })

  it('fakeWebSocket install clears previous instances', () => {
    const first = installFakeWebSocket()
    new WebSocket('ws://x/1')
    first.restore()

    const second = installFakeWebSocket()
    restore = second.restore
    expect(second.instances).toEqual([])
    new WebSocket('ws://x/2')
    expect(second.instances.map((s) => s.url)).toEqual(['ws://x/2'])
  })
})
