import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { FRAMEDIFF_HEIGHT, FRAMEDIFF_WIDTH, frameDiffs, spawnFfmpeg } from './framediff.js'

const FFMPEG_TIMEOUT_MS = 60_000
const FPS = 30
/** The fading element: 64x36 px of the 320x180 frame, 4 % of it. */
const ELEMENT_SHARE = (64 * 36) / (FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT)

let dir: string

/** A 1 s clip on black; `fade` adds a white 64x36 box that fades in from 0.25 s to 0.75 s. */
function makeClip(name: string, fade: boolean): string {
  const out = join(dir, `${name}.mp4`)
  const black = ['-f', 'lavfi', '-i', `color=black:s=${FRAMEDIFF_WIDTH}x${FRAMEDIFF_HEIGHT}:r=${FPS}:d=1`]
  const box = ['-f', 'lavfi', '-i', `color=white:s=64x36:r=${FPS}:d=1`, '-filter_complex', '[1]format=rgba,fade=t=in:st=0.25:d=0.5:alpha=1[b];[0][b]overlay=20:20']
  execFileSync('ffmpeg', ['-v', 'error', ...black, ...(fade ? box : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', out])
  return out
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'render-qa-framediff-'))
})

after(() => rmSync(dir, { recursive: true, force: true }))

describe('frameDiffs on clips ffmpeg makes', { timeout: FFMPEG_TIMEOUT_MS }, () => {
  test('a 0.5 s fade of a 4 % element counts as change on the fade frames and nowhere else', async () => {
    const clip = makeClip('fade', true)

    const diffs = await frameDiffs(clip)

    const fadeFrames = diffs.filter((share) => share > ELEMENT_SHARE / 2)
    assert.equal(diffs.length, FPS)
    assert.ok(fadeFrames.length >= 13 && fadeFrames.length <= 16, `fade frames: ${fadeFrames.length}`)
    assert.ok(fadeFrames.every((share) => share <= ELEMENT_SHARE * 1.25), String(fadeFrames))
    assert.deepEqual([...diffs.slice(0, 6), ...diffs.slice(25)], new Array(11).fill(0))
  })

  test('a clip of identical frames has no change on any frame', async () => {
    const clip = makeClip('still', false)

    const diffs = await frameDiffs(clip)

    assert.deepEqual(diffs, new Array(FPS).fill(0))
  })

  test('a video ffmpeg cannot read fails instead of reading as no change', async () => {
    const missing = join(dir, 'missing.mp4')

    await assert.rejects(frameDiffs(missing), /^Error: ffmpeg exited \d+: .*missing\.mp4/s)
  })
})

describe('frameDiffs through the exec seam', () => {
  // catches: the spawn error rejected a promise with no handler yet, so a missing ffmpeg killed the process
  test('an ffmpeg that cannot start rejects the diff instead of crashing the process', async () => {
    const missing = join(dir, 'no-such-ffmpeg')
    const unhandled: unknown[] = []
    const record = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', record)

    try {
      await assert.rejects(frameDiffs('clip.mp4', (args) => spawnFfmpeg(args, missing)), /ENOENT/)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', record)
    }

    assert.deepEqual(unhandled, [])
  })

  test('frames split across stdout chunks are joined, and a trailing partial frame is dropped', async () => {
    const frame = (level: number) => new Uint8Array(FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT).fill(level)
    const changed = frame(0).fill(200, 0, 576)
    const bytes = Buffer.concat([frame(0), changed, frame(0).subarray(0, 100)])
    async function* exec() {
      for (let at = 0; at < bytes.length; at += 7001) yield bytes.subarray(at, at + 7001)
    }

    const diffs = await frameDiffs('clip.mp4', exec)

    assert.deepEqual(diffs, [0, 0.01])
  })

  test('a change of exactly the pixel threshold is not counted', async () => {
    const bytes = Buffer.concat([new Uint8Array(FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT).fill(10), new Uint8Array(FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT).fill(13)])
    async function* exec() {
      yield bytes
    }

    const diffs = await frameDiffs('clip.mp4', exec)

    assert.deepEqual(diffs, [0, 0])
  })

  describe('a one-frame codec blip on a still picture', () => {
    const still = () => new Uint8Array(FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT).fill(40)
    /** The still with its first 207 pixels moved by `levels`, like the keyframe noise of a real h264 render. */
    const strayed = (levels: number) => still().fill(40 + levels, 0, 207)
    const execOf = (frames: Uint8Array[]) =>
      async function* exec() {
        yield Buffer.concat(frames)
      }

    // catches: an I-frame's re-quantisation noise read as motion and split a real 5.5 s still into two short ones
    test('a keyframe blip that strays 5 levels and returns the next frame is no change', async () => {
      const frames = [still(), still(), strayed(5), still(), still()]

      const diffs = await frameDiffs('clip.mp4', execOf(frames))

      assert.deepEqual(diffs, [0, 0, 0, 0, 0])
    })

    test('a one-frame flash that moves pixels 40 levels still counts as change', async () => {
      const frames = [still(), still(), strayed(40), still(), still()]

      const diffs = await frameDiffs('clip.mp4', execOf(frames))

      assert.deepEqual(diffs, [0, 0, 0.00359, 0.00359, 0])
    })

    test('a small step that stays on the next frame still counts as change', async () => {
      const frames = [still(), still(), strayed(5), strayed(5), strayed(5)]

      const diffs = await frameDiffs('clip.mp4', execOf(frames))

      assert.deepEqual(diffs, [0, 0, 0.00359, 0, 0])
    })
  })
})
