/**
 * The virtual-time init script (plan N17). Playwright serialises this function and runs it before any
 * page script, so nothing in the page reads real time: Date, performance.now, timers and rAF all follow
 * a clock that only `__virtualTime.advanceTo(ms)` moves, and Math.random is seeded.
 *
 * It must stay self-contained: no imports, no closures over module scope.
 */
export function installVirtualTime(): void {
  const EPOCH_MS = Date.UTC(2026, 0, 1)
  const MAX_FIRES_PER_ADVANCE = 100_000
  type Task = { at: number; seq: number; fn: (...args: unknown[]) => void; args: unknown[]; everyMs?: number }

  let nowMs = 0
  let nextId = 1
  let seq = 0
  const timers = new Map<number, Task>()
  let rafs = new Map<number, FrameRequestCallback>()

  let seed = 0x2f6b9d31
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }

  const RealDate = Date
  class VirtualDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(EPOCH_MS + nowMs)
      else super(...(args as [string]))
    }
    static override now() {
      return EPOCH_MS + nowMs
    }
  }
  window.Date = VirtualDate as DateConstructor
  performance.now = () => nowMs

  function schedule(fn: unknown, delay: unknown, args: unknown[], repeat: boolean): number {
    const id = nextId++
    if (typeof fn !== 'function') return id
    const ms = Math.max(0, Number(delay) || 0)
    timers.set(id, { at: nowMs + ms, seq: seq++, fn: fn as Task['fn'], args, everyMs: repeat ? Math.max(1, ms) : undefined })
    return id
  }
  const clear = (id?: number) => void (id !== undefined && timers.delete(id))
  window.setTimeout = ((fn: unknown, delay?: number, ...args: unknown[]) => schedule(fn, delay, args, false)) as typeof setTimeout
  window.setInterval = ((fn: unknown, delay?: number, ...args: unknown[]) => schedule(fn, delay, args, true)) as typeof setInterval
  window.clearTimeout = clear as typeof clearTimeout
  window.clearInterval = clear as typeof clearInterval
  window.requestAnimationFrame = (cb) => {
    const id = nextId++
    rafs.set(id, cb)
    return id
  }
  window.cancelAnimationFrame = (id) => void rafs.delete(id)

  function nextDue(untilMs: number): [number, Task] | undefined {
    let best: [number, Task] | undefined
    for (const entry of timers) {
      const task = entry[1]
      if (task.at > untilMs) continue
      if (!best || task.at < best[1].at || (task.at === best[1].at && task.seq < best[1].seq)) best = entry
    }
    return best
  }

  function fireTimers(untilMs: number) {
    for (let fired = 0; fired < MAX_FIRES_PER_ADVANCE; fired++) {
      const due = nextDue(untilMs)
      if (!due) return
      const [id, task] = due
      nowMs = Math.max(nowMs, task.at)
      if (task.everyMs === undefined) timers.delete(id)
      else Object.assign(task, { at: task.at + task.everyMs, seq: seq++ })
      task.fn(...task.args)
    }
    throw new Error(`virtual time: more than ${MAX_FIRES_PER_ADVANCE} timers due by ${untilMs} ms`)
  }

  function runFrame() {
    const callbacks = rafs
    rafs = new Map()
    for (const cb of callbacks.values()) cb(nowMs)
  }

  Object.defineProperty(window, '__virtualTime', {
    value: {
      now: () => nowMs,
      pending: () => ({ timers: timers.size, rafs: rafs.size }),
      /** Fires every timer due by `ms` in order, sets the clock to `ms`, then runs one rAF frame. */
      advanceTo(ms: number) {
        if (ms < nowMs) throw new Error(`virtual time cannot go back from ${nowMs} to ${ms} ms`)
        fireTimers(ms)
        nowMs = ms
        runFrame()
      },
    },
  })
}

export interface VirtualTimeApi {
  now(): number
  pending(): { timers: number; rafs: number }
  advanceTo(ms: number): void
}
