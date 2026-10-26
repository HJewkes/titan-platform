import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll as after, beforeAll as before, describe, test } from 'vitest'
import { spawnFfmpeg } from './framediff.js'
import { mediaScan, parseMediaScan } from './media-scan.js'

const FFMPEG_TIMEOUT_MS = 60_000

let dir: string

const video = (src: string, d: number) => ['-f', 'lavfi', '-i', `${src}s=320x180:r=30:d=${d}`]
const tone = (d: number) => ['-f', 'lavfi', '-i', `sine=f=440:r=44100:d=${d}`]
const hush = (d: number) => ['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono:d=${d}`]

/**
 * 11 s: moving 0-1, black 1-2, moving 2-5, a frozen grey 5-9, moving 9-11; tone 0-1, silence 1-3.5 (2.5 s),
 * tone 3.5-6, silence 6-7.5 (1.5 s), tone 7.5-11.
 */
function makeClip(): string {
  const out = join(dir, 'scan.mp4')
  const pictures = [...video('testsrc2=', 1), ...video('color=black:', 1), ...video('testsrc2=', 3), ...video('color=gray:', 4), ...video('testsrc2=', 2)]
  const sounds = [...tone(1), ...hush(2.5), ...tone(2.5), ...hush(1.5), ...tone(3.5)]
  const graph = '[0][1][2][3][4]concat=n=5:v=1:a=0[v];[5][6][7][8][9]concat=n=5:v=0:a=1[a]'
  const encode = ['-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', out]
  execFileSync('ffmpeg', ['-v', 'error', ...pictures, ...sounds, '-filter_complex', graph, ...encode])
  return out
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'render-qa-media-scan-'))
})

after(() => rmSync(dir, { recursive: true, force: true }))

const near = (actual: { startS: number; endS: number }[], expected: [number, number][]) => {
  assert.equal(actual.length, expected.length, JSON.stringify(actual))
  actual.forEach(({ startS, endS }, i) => {
    assert.ok(Math.abs(startS - expected[i]![0]) < 0.1 && Math.abs(endS - expected[i]![1]) < 0.1, JSON.stringify(actual))
  })
}

describe('mediaScan on a clip ffmpeg makes', { timeout: FFMPEG_TIMEOUT_MS }, () => {
  test('finds the black second, the 2.5 s silence and the frozen stretch, and not the 1.5 s silence', async () => {
    const clip = makeClip()

    const scan = await mediaScan(clip)

    near(scan.black, [[1, 2]])
    near(scan.silence, [[1, 3.5]])
    near(scan.freeze, [[5, 9]])
  })

  test('a video ffmpeg cannot read fails instead of reading as clean', async () => {
    const missing = join(dir, 'missing.mp4')

    await assert.rejects(mediaScan(missing), /^Error: ffmpeg exited \d+: .*missing\.mp4/s)
  })

  test('an ffmpeg that cannot start rejects the scan', async () => {
    const missing = join(dir, 'no-such-ffmpeg')

    await assert.rejects(mediaScan('clip.mp4', { exec: (args) => spawnFfmpeg(args, missing, 'stderr') }), /ENOENT/)
  })
})

/** Detector lines as ffmpeg 8 logs them, around header and progress noise. */
const LOG = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
  '  Duration: 00:00:12.50, start: 0.000000, bitrate: 96 kb/s',
  '[blackdetect @ 0x5a1] black_start:0.4 black_end:1.2 black_duration:0.8',
  '[silencedetect @ 0x5b2] silence_start: -0.0213',
  '[silencedetect @ 0x5b2] silence_end: 2.3 | silence_duration: 2.3213',
  '[freezedetect @ 0x5c3] lavfi.freezedetect.freeze_start: 4',
  '[freezedetect @ 0x5c3] lavfi.freezedetect.freeze_duration: 3.5',
  '[freezedetect @ 0x5c3] lavfi.freezedetect.freeze_end: 7.5',
  '[silencedetect @ 0x5b2] silence_start: 9.75',
  '[freezedetect @ 0x5c3] lavfi.freezedetect.freeze_start: 9',
  'frame=  375 fps=0.0 q=-0.0 Lsize=N/A time=00:00:12.50 bitrate=N/A speed= 548x',
  '[silencedetect @ 0x5b2] silence_end: 12.5 | silence_duration: 2.75',
].join('\n')

describe('parseMediaScan on canned stderr', () => {
  test('pairs each detector start with its end and clamps a pre-roll start to 0', () => {
    const scan = parseMediaScan(LOG)

    assert.deepEqual(scan.black, [{ startS: 0.4, endS: 1.2 }])
    assert.deepEqual(scan.silence, [{ startS: 0, endS: 2.3 }, { startS: 9.75, endS: 12.5 }])
    assert.deepEqual(scan.freeze[0], { startS: 4, endS: 7.5 })
  })

  test('a freeze still open at the last frame runs to the input duration', () => {
    const scan = parseMediaScan(LOG)

    assert.deepEqual(scan.freeze[1], { startS: 9, endS: 12.5 })
  })

  test('a log with no detector lines is a clean scan', () => {
    const scan = parseMediaScan("  Duration: 00:00:03.00, start: 0.000000\nframe=   90 fps=0.0")

    assert.deepEqual(scan, { black: [], silence: [], freeze: [] })
  })

  test('a log split mid-line across chunks still parses', async () => {
    const bytes = new TextEncoder().encode(LOG)
    async function* exec() {
      for (let at = 0; at < bytes.length; at += 37) yield bytes.subarray(at, at + 37)
    }

    const scan = await mediaScan('clip.mp4', { exec })

    assert.deepEqual(scan, parseMediaScan(LOG))
  })
})
