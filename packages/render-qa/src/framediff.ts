/**
 * Frame-to-frame picture change of a video: each frame is decoded to 320x180 grey and compared with the one before
 * as the share of pixels (0-1) that moved by more than PIXEL_LEVELS levels. A mean difference misses slow fades of
 * small elements (a 0.5 s map-node fade moves the mean by < 0.1 level per frame), so count pixels instead.
 * Frame 0 gets 0.
 */
import { spawn } from 'node:child_process'

export const FRAMEDIFF_WIDTH = 320
export const FRAMEDIFF_HEIGHT = 180
export const PIXEL_LEVELS = 3
const FRAME_BYTES = FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT

/** Runs ffmpeg with `args` and yields its stdout; rejects when ffmpeg fails. Tests pass their own. */
export type FfmpegExec = (args: readonly string[]) => AsyncIterable<Uint8Array>

export function changedShare(a: Uint8Array, b: Uint8Array): number {
  let changed = 0
  for (let i = 0; i < a.length; i++) if (Math.abs((a[i] as number) - (b[i] as number)) > PIXEL_LEVELS) changed++
  return changed / a.length
}

export async function* spawnFfmpeg(args: readonly string[]): AsyncIterable<Uint8Array> {
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const exited = new Promise<number | null>((resolve, reject) => proc.on('error', reject).on('close', resolve))
  yield* proc.stdout as AsyncIterable<Buffer>
  const code = await exited
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)
}

/** Decode arguments: every frame of `video`, area-scaled to the diff size, as raw 8-bit grey on stdout. */
export function decodeArgs(video: string): string[] {
  return ['-v', 'error', '-i', video, '-vf', `scale=${FRAMEDIFF_WIDTH}:${FRAMEDIFF_HEIGHT}:flags=area,format=gray`, '-f', 'rawvideo', '-']
}

/** One changed share per decoded frame, rounded to 5 places. */
export async function frameDiffs(video: string, exec: FfmpegExec = spawnFfmpeg): Promise<number[]> {
  const diffs: number[] = []
  let prev: Uint8Array | null = null
  let pending = Buffer.alloc(0)
  for await (const chunk of exec(decodeArgs(video))) {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= FRAME_BYTES) {
      const frame = new Uint8Array(pending.subarray(0, FRAME_BYTES))
      pending = pending.subarray(FRAME_BYTES)
      diffs.push(prev ? Number(changedShare(prev, frame).toFixed(5)) : 0)
      prev = frame
    }
  }
  return diffs
}
