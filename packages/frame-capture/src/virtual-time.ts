/**
 * The virtual-time init script. Playwright runs it before any page script, so nothing in
 * the page reads real time: Date, performance.now, timers and rAF all follow a clock that only
 * `__virtualTime.advanceTo(ms)` moves, and Math.random is seeded.
 *
 * Each step below is serialised on its own, so it must stay self-contained: no imports, no closures over
 * module scope, and no calls to another step except through the `steps` it is handed. Passing the steps
 * in, rather than calling them by name, keeps the script working if a bundler renames a function.
 */

type Task = { at: number; seq: number; fn: (...args: unknown[]) => void; args: unknown[]; everyMs?: number }

interface ClockState {
  nowMs: number
  nextId: number
  seq: number
  timers: Map<number, Task>
  rafs: Map<number, FrameRequestCallback>
}

function seedMathRandom(): void {
  let seed = 0x2f6b9d31
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function patchDate(state: ClockState): void {
  const EPOCH_MS = Date.UTC(2026, 0, 1)
  const RealDate = Date
  type DateParts = [year: number, monthIndex: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number]
  type DateArgs = [] | [value: number | string | Date] | DateParts
  class VirtualDate extends RealDate {
    constructor(...args: DateArgs) {
      if (args.length === 0) super(EPOCH_MS + state.nowMs)
      else if (args.length === 1) super(args[0])
      else super(...args)
    }
    static override now() {
      return EPOCH_MS + state.nowMs
    }
  }
  // defineProperty, not assignment: the class has no call signature, so it is not a DateConstructor.
  Object.defineProperty(window, 'Date', { value: VirtualDate, writable: true, configurable: true })
  performance.now = () => state.nowMs
}

function patchTimers(state: ClockState): void {
  const isCallback = (fn: unknown): fn is Task['fn'] => typeof fn === 'function'
  function schedule(fn: unknown, delay: unknown, args: unknown[], repeat: boolean): number {
    const id = state.nextId++
    if (!isCallback(fn)) return id
    const ms = Math.max(0, Number(delay) || 0)
    state.timers.set(id, { at: state.nowMs + ms, seq: state.seq++, fn, args, everyMs: repeat ? Math.max(1, ms) : undefined })
    return id
  }
  const clear = (id?: number) => void (id !== undefined && state.timers.delete(id))
  // defineProperty, not assignment: the global timer types merge Node's overloads, which these do not implement.
  const overrides = {
    setTimeout: (fn: unknown, delay?: number, ...args: unknown[]) => schedule(fn, delay, args, false),
    setInterval: (fn: unknown, delay?: number, ...args: unknown[]) => schedule(fn, delay, args, true),
    clearTimeout: clear,
    clearInterval: clear,
  }
  for (const [name, value] of Object.entries(overrides)) {
    Object.defineProperty(window, name, { value, writable: true, configurable: true })
  }
  window.requestAnimationFrame = (cb) => {
    const id = state.nextId++
    state.rafs.set(id, cb)
    return id
  }
  window.cancelAnimationFrame = (id) => void state.rafs.delete(id)
}

function nextDue(state: ClockState, untilMs: number): [number, Task] | undefined {
  let best: [number, Task] | undefined
  for (const entry of state.timers) {
    const task = entry[1]
    if (task.at > untilMs) continue
    if (!best || task.at < best[1].at || (task.at === best[1].at && task.seq < best[1].seq)) best = entry
  }
  return best
}

function fireTimers(state: ClockState, untilMs: number, steps: VirtualTimeSteps): void {
  const MAX_FIRES_PER_ADVANCE = 100_000
  for (let fired = 0; fired < MAX_FIRES_PER_ADVANCE; fired++) {
    const due = steps.nextDue(state, untilMs)
    if (!due) return
    const [id, task] = due
    state.nowMs = Math.max(state.nowMs, task.at)
    if (task.everyMs === undefined) state.timers.delete(id)
    else Object.assign(task, { at: task.at + task.everyMs, seq: state.seq++ })
    task.fn(...task.args)
  }
  throw new Error(`virtual time: more than ${MAX_FIRES_PER_ADVANCE} timers due by ${untilMs} ms`)
}

function runFrame(state: ClockState): void {
  const callbacks = state.rafs
  state.rafs = new Map()
  for (const cb of callbacks.values()) cb(state.nowMs)
}

function publishVirtualTime(state: ClockState, steps: VirtualTimeSteps): void {
  const api: VirtualTimeApi = {
    now: () => state.nowMs,
    pending: () => ({ timers: state.timers.size, rafs: state.rafs.size }),
    advanceTo(ms: number) {
      if (ms < state.nowMs) throw new Error(`virtual time cannot go back from ${state.nowMs} to ${ms} ms`)
      steps.fireTimers(state, ms, steps)
      state.nowMs = ms
      steps.runFrame(state)
    },
  }
  Object.defineProperty(window, '__virtualTime', { value: api })
}

const STEPS = { seedMathRandom, patchDate, patchTimers, nextDue, fireTimers, runFrame, publishVirtualTime }
type VirtualTimeSteps = typeof STEPS

function installVirtualTime(steps: VirtualTimeSteps): void {
  const state: ClockState = { nowMs: 0, nextId: 1, seq: 0, timers: new Map(), rafs: new Map() }
  steps.seedMathRandom()
  steps.patchDate(state)
  steps.patchTimers(state)
  steps.publishVirtualTime(state, steps)
}

/** The init script source, for `context.addInitScript({ content: VIRTUAL_TIME_SCRIPT })`. */
export const VIRTUAL_TIME_SCRIPT = `(${String(installVirtualTime)})({ ${Object.entries(STEPS)
  .map(([name, step]) => `${name}: ${String(step)}`)
  .join(', ')} })`

export interface VirtualTimeApi {
  now(): number
  pending(): { timers: number; rafs: number }
  /** Fires every timer due by `ms` in order, sets the clock to `ms`, then runs one rAF frame. */
  advanceTo(ms: number): void
}
