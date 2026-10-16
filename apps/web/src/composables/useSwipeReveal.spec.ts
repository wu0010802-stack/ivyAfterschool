import { describe, expect, it, vi } from 'vitest'
import { useSwipeReveal } from './useSwipeReveal'

function pointer(type: string, clientX: number, clientY = 100, pointerId = 1): PointerEvent {
  return new PointerEvent(type, { clientX, clientY, pointerId })
}

type Swipe = ReturnType<typeof useSwipeReveal>

function drag(s: Swipe, fromX: number, toX: number, opts: { y?: number; toY?: number; id?: number } = {}) {
  const y = opts.y ?? 100
  const id = opts.id ?? 1
  s.onPointerDown(pointer('pointerdown', fromX, y, id))
  s.onPointerMove(pointer('pointermove', toX, opts.toY ?? y, id))
  s.onPointerUp(pointer('pointerup', toX, opts.toY ?? y, id))
}

/**
 * 會記錄 pointer capture 狀態的替身元素：事件經由它派發，handler 收到的 currentTarget 就是它。
 * capturing = 目前 capture 中的 pointerId；history = 曾經 capture 過的 pointerId（依序）；
 * releases = 呼叫 release 的 pointerId（沒 capture 過就不該 release）。
 */
function captureStub(s: Swipe) {
  const el = document.createElement('div')
  const capturing = new Set<number>()
  const history: number[] = []
  const releases: number[] = []
  el.setPointerCapture = (id: number) => {
    capturing.add(id)
    history.push(id)
  }
  el.releasePointerCapture = (id: number) => {
    releases.push(id)
    capturing.delete(id)
  }
  el.hasPointerCapture = (id: number) => capturing.has(id)
  el.addEventListener('pointerdown', (e) => s.onPointerDown(e as PointerEvent))
  el.addEventListener('pointermove', (e) => s.onPointerMove(e as PointerEvent))
  el.addEventListener('pointerup', (e) => s.onPointerUp(e as PointerEvent))
  el.addEventListener('pointercancel', (e) => s.onPointerCancel(e as PointerEvent))
  const fire = (type: string, clientX: number, pointerId = 7): void => {
    el.dispatchEvent(new PointerEvent(type, { clientX, clientY: 100, pointerId }))
  }
  return { el, capturing, history, releases, fire }
}

function stubReducedMotion(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' && matches })),
  )
}

describe('useSwipeReveal', () => {
  it('useSwipeReveal opens past threshold', () => {
    const s = useSwipeReveal({ revealWidth: 84 })

    drag(s, 300, 250)

    expect(s.isOpen.value).toBe(true)
    expect(s.dragX.value).toBe(-84)
    expect(s.dragging.value).toBe(false)
  })

  it('useSwipeReveal rebounds below threshold', () => {
    const s = useSwipeReveal({ revealWidth: 84 })

    drag(s, 300, 270)
    expect(s.isOpen.value).toBe(false)
    expect(s.dragX.value).toBe(0)

    s.onPointerDown(pointer('pointerdown', 300))
    s.onPointerMove(pointer('pointermove', 280))
    expect(s.dragging.value).toBe(true)
    expect(s.dragX.value).toBe(-20)
    s.onPointerMove(pointer('pointermove', 100))
    expect(s.dragX.value).toBe(-84)
    s.onPointerMove(pointer('pointermove', 400))
    expect(s.dragX.value).toBe(0)
  })

  it('useSwipeReveal closes by dragging right when open', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    drag(s, 300, 250)
    expect(s.isOpen.value).toBe(true)

    s.onPointerDown(pointer('pointerdown', 200))
    s.onPointerMove(pointer('pointermove', 260))
    expect(s.dragX.value).toBe(-24)
    s.onPointerUp(pointer('pointerup', 260))

    expect(s.isOpen.value).toBe(false)
    expect(s.dragX.value).toBe(0)
  })

  it('useSwipeReveal ignores vertical scroll and disabled state', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    s.onPointerDown(pointer('pointerdown', 300, 100))
    s.onPointerMove(pointer('pointermove', 295, 140))

    expect(s.dragging.value).toBe(false)
    expect(s.dragX.value).toBe(0)
    // 放棄後的後續 move / up 不再作用
    s.onPointerMove(pointer('pointermove', 200, 140))
    s.onPointerUp(pointer('pointerup', 200, 140))
    expect(s.dragX.value).toBe(0)
    expect(s.isOpen.value).toBe(false)

    let disabled = true
    const d = useSwipeReveal({ revealWidth: 84, disabled: () => disabled })
    drag(d, 300, 200)
    expect(d.isOpen.value).toBe(false)
    expect(d.dragX.value).toBe(0)
    expect(d.dragging.value).toBe(false)

    disabled = false
    drag(d, 300, 200)
    expect(d.isOpen.value).toBe(true)
  })

  it('useSwipeReveal uses getter width', () => {
    let w = 84
    const s = useSwipeReveal({ revealWidth: () => w })

    w = 168
    drag(s, 300, 100)

    expect(s.isOpen.value).toBe(true)
    expect(s.dragX.value).toBe(-168)
  })

  it('useSwipeReveal ignores a second pointer while dragging', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    s.onPointerDown(pointer('pointerdown', 300, 100, 1))
    s.onPointerMove(pointer('pointermove', 290, 100, 1))

    s.onPointerDown(pointer('pointerdown', 50, 100, 2))
    s.onPointerMove(pointer('pointermove', 0, 100, 2))
    s.onPointerUp(pointer('pointerup', 0, 100, 2))
    expect(s.dragging.value).toBe(true)
    expect(s.dragX.value).toBe(-10)

    s.onPointerMove(pointer('pointermove', 240, 100, 1))
    s.onPointerUp(pointer('pointerup', 240, 100, 1))
    expect(s.isOpen.value).toBe(true)
    expect(s.dragX.value).toBe(-84)
  })

  it('useSwipeReveal pointercancel restores resting position without toggling', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    s.onPointerDown(pointer('pointerdown', 300))
    s.onPointerMove(pointer('pointermove', 220))
    s.onPointerCancel(pointer('pointercancel', 220))

    expect(s.dragging.value).toBe(false)
    expect(s.isOpen.value).toBe(false)
    expect(s.dragX.value).toBe(0)

    drag(s, 300, 250)
    s.onPointerDown(pointer('pointerdown', 200))
    s.onPointerMove(pointer('pointermove', 280))
    s.onPointerCancel(pointer('pointercancel', 280))
    expect(s.isOpen.value).toBe(true)
    expect(s.dragX.value).toBe(-84)
  })

  it('useSwipeReveal captures pointer only after horizontal lock', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    const stub = captureStub(s)

    stub.fire('pointerdown', 300)
    expect([...stub.capturing]).toEqual([])

    stub.fire('pointermove', 295)
    expect([...stub.capturing]).toEqual([])

    stub.fire('pointermove', 280)
    expect([...stub.capturing]).toEqual([7])

    stub.fire('pointermove', 260)
    expect([...stub.capturing]).toEqual([7])
    expect(stub.history).toEqual([7])
  })

  it('useSwipeReveal tap without horizontal drag never captures', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    const stub = captureStub(s)

    stub.fire('pointerdown', 300)
    stub.fire('pointerup', 302)
    expect(stub.history).toEqual([])
    expect(stub.releases).toEqual([])
    expect([...stub.capturing]).toEqual([])
    expect(s.isOpen.value).toBe(false)
    expect(s.dragX.value).toBe(0)

    // 開啟狀態下點一下：不 capture、維持開啟
    drag(s, 300, 250)
    expect(s.isOpen.value).toBe(true)
    const openStub = captureStub(s)
    openStub.fire('pointerdown', 200)
    openStub.fire('pointerup', 203)
    expect(openStub.history).toEqual([])
    expect(openStub.releases).toEqual([])
    expect(s.isOpen.value).toBe(true)
    expect(s.dragX.value).toBe(-84)
  })

  it('useSwipeReveal releases capture when the drag ends', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    const stub = captureStub(s)
    stub.fire('pointerdown', 300)
    stub.fire('pointermove', 250)
    expect([...stub.capturing]).toEqual([7])
    stub.fire('pointerup', 250)
    expect([...stub.capturing]).toEqual([])
    expect(stub.releases).toEqual([7])
    expect(s.isOpen.value).toBe(true)

    const c = useSwipeReveal({ revealWidth: 84 })
    const cancelStub = captureStub(c)
    cancelStub.fire('pointerdown', 300)
    cancelStub.fire('pointermove', 280)
    expect([...cancelStub.capturing]).toEqual([7])
    cancelStub.fire('pointercancel', 280)
    expect([...cancelStub.capturing]).toEqual([])
    expect(c.isOpen.value).toBe(false)

    // 判定為垂直捲動而放棄：從未 capture，也就不需要 release
    const v = useSwipeReveal({ revealWidth: 84 })
    const scrollStub = captureStub(v)
    scrollStub.fire('pointerdown', 300)
    scrollStub.el.dispatchEvent(new PointerEvent('pointermove', { clientX: 298, clientY: 140, pointerId: 7 }))
    expect(scrollStub.history).toEqual([])
    expect(scrollStub.releases).toEqual([])
    expect(v.dragging.value).toBe(false)
  })

  it('useSwipeReveal close resets open state', () => {
    const s = useSwipeReveal({ revealWidth: 84 })
    drag(s, 300, 250)

    s.close()

    expect(s.isOpen.value).toBe(false)
    expect(s.dragX.value).toBe(0)
  })

  it('useSwipeReveal sets reboundInstant from reduced motion preference', () => {
    stubReducedMotion(true)
    const s = useSwipeReveal()
    s.onPointerDown(pointer('pointerdown', 300))
    expect(s.reboundInstant.value).toBe(true)
    s.onPointerUp(pointer('pointerup', 300))

    stubReducedMotion(false)
    s.onPointerDown(pointer('pointerdown', 300))
    expect(s.reboundInstant.value).toBe(false)
  })
})
