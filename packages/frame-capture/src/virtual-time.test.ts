import assert from 'node:assert/strict'
import vm from 'node:vm'
import { describe, test } from 'vitest'
import { VIRTUAL_TIME_SCRIPT } from './virtual-time.js'

/** What the browser's own timeline would read: anything but virtual time. */
const REAL_TIMELINE_MS = 98_765

/** The slice of the Web Animations API the shim touches; it starts mid-run on the real timeline. */
class FakeAnimation {
  playState = 'running'
  playbackRate = 1
  currentTime: number | null = 4321
  pause(): void {
    this.playState = 'paused'
  }
}

/**
 * Runs the init script in a fresh V8 context standing in for a page, with no browser: the context is its own
 * `window`, and `document` carries only a timeline and the given animations. Returns an evaluator for that page.
 */
function openShimmedPage(animations: FakeAnimation[] = []): (code: string) => unknown {
  const context = vm.createContext({
    performance: { now: () => REAL_TIMELINE_MS },
    document: { timeline: { currentTime: REAL_TIMELINE_MS }, getAnimations: () => animations },
  })
  vm.runInContext('globalThis.window = globalThis', context)
  vm.runInContext(VIRTUAL_TIME_SCRIPT, context)
  return (code) => vm.runInContext(code, context)
}

describe('virtual-time init script', () => {
  // Mutation: the Date proxy's apply trap is dropped; calling the class without new throws a TypeError.
  test('Date() called without new returns the virtual time as a string', () => {
    const page = openShimmedPage()
    page('__virtualTime.advanceTo(1500)')

    const called = page('Date()')

    assert.equal(page('new Date().toISOString()'), '2026-01-01T00:00:01.500Z')
    assert.equal(called, page('new Date().toString()'))
  })

  // Mutation: patchTimeline left out of the init script; document.timeline keeps reading the real clock.
  test('document.timeline.currentTime follows the virtual clock', () => {
    const page = openShimmedPage()

    page('__virtualTime.advanceTo(1500)')

    assert.equal(page('document.timeline.currentTime'), 1500)
  })

  // Mutation: advanceTo stops calling syncAnimations; the animation keeps the real-time position it had.
  test('a running animation is paused and set to the virtual time since the clock first saw it', () => {
    const animation = new FakeAnimation()
    const page = openShimmedPage([animation])
    page('__virtualTime.advanceTo(0)')

    page('__virtualTime.advanceTo(250)')

    assert.deepEqual({ playState: animation.playState, currentTime: animation.currentTime }, { playState: 'paused', currentTime: 250 })
  })

  // Mutation: syncAnimations ignores pageOwned; the page's own seek is overwritten with virtual time.
  test('an animation the page pauses and seeks itself is left to the page', () => {
    const animation = new FakeAnimation()
    const page = openShimmedPage([animation])
    page('__virtualTime.advanceTo(0)')
    animation.currentTime = 123

    page('__virtualTime.advanceTo(250)')

    assert.equal(animation.currentTime, 123)
  })
})
