/**
 * Frame-to-frame picture change of a video: each frame is decoded to 320x180 grey and compared with the one before
 * as the share of pixels (0-1) that moved by more than PIXEL_LEVELS levels. A mean difference misses slow fades of
 * small elements (a 0.5 s map-node fade moves the mean by < 0.1 level per frame), so count pixels instead.
 * Frame 0 gets 0, and a one-frame codec blip (`isCodecBlip`) is not change.
 */
import { spawn } from 'node:child_process'

export const FRAMEDIFF_WIDTH = 320
export const FRAMEDIFF_HEIGHT = 180
export const PIXEL_LEVELS = 3
/** The most a codec blip moves any pixel; keyframe noise measured at most 10 levels. */
const BLIP_LEVELS = 12
const FRAME_BYTES = FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT

/** Runs ffmpeg with `args` and yields its stdout; rejects when ffmpeg fails. Tests pass their own. */
export type FfmpegExec = (args: readonly string[]) => AsyncIterable<Uint8Array>

export function changedShare(a: Uint8Array, b: Uint8Array): number {
  let changed = 0
  for (let i = 0; i < a.length; i++) if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > PIXEL_LEVELS) changed++
  return changed / a.length
}

/**
 * `bin` is the ffmpeg to run; a binary that cannot start (missing, not executable) rejects like a failed run. `read`
 * picks the stream to yield: stdout for decoded frames, stderr for what filters log (`mediaScan`).
 */
export async function* spawnFfmpeg(args: readonly string[], bin = 'ffmpeg', read: 'stdout' | 'stderr' = 'stdout'): AsyncIterable<Uint8Array> {
  const proc = spawn(bin, args, { stdio: ['ignore', read === 'stdout' ? 'pipe' : 'ignore', 'pipe'] })
  // stdio fixes stderr to a pipe and stdout to one when read is 'stdout'; the spawn types cannot see that.
  const errStream = proc.stderr!
  let stderr = ''
  const log = (chunk: Buffer) => (stderr += chunk.toString())
  if (read === 'stdout') errStream.on('data', log)
  const exited = new Promise<number | null>((resolve, reject) => proc.on('error', reject).on('close', resolve))
  // A spawn error fires while stdout is still being read; without a handler now it is unhandled and kills the process.
  exited.catch(() => undefined)
  for await (const chunk of (read === 'stdout' ? proc.stdout! : errStream) as AsyncIterable<Buffer>) {
    if (read === 'stderr') log(chunk)
    yield chunk
  }
  const code = await exited
  if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.trim()}`)
}

/** Decode arguments: every frame of `video`, area-scaled to the diff size, as raw 8-bit grey on stdout. */
export function decodeArgs(video: string): string[] {
  return ['-v', 'error', '-i', video, '-vf', `scale=${FRAMEDIFF_WIDTH}:${FRAMEDIFF_HEIGHT}:flags=area,format=gray`, '-f', 'rawvideo', '-']
}

/** Frames of `video`, decoded to raw grey and cut at frame boundaries; a trailing partial frame is dropped. */
async function* decodedFrames(video: string, exec: FfmpegExec): AsyncIterable<Uint8Array> {
  let pending = Buffer.alloc(0)
  for await (const chunk of exec(decodeArgs(video))) {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= FRAME_BYTES) {
      yield new Uint8Array(pending.subarray(0, FRAME_BYTES))
      pending = pending.subarray(FRAME_BYTES)
    }
  }
}

function maxLevelChange(a: Uint8Array, b: Uint8Array): number {
  let max = 0
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
  return max
}

/**
 * An h264 keyframe re-quantises a still picture, and the P-frames after it pulse the same noise back out: one frame
 * strays a few levels from the picture and the next returns to it exactly (measured at 4-10 levels on a few hundred
 * pixels). Such a frame is no motion. A frame whose next one does not return, or that moved any pixel more than
 * BLIP_LEVELS, still counts.
 */
function isCodecBlip(prev: Uint8Array, frame: Uint8Array, next: Uint8Array): boolean {
  return changedShare(prev, frame) > 0 && changedShare(prev, next) === 0 && maxLevelChange(prev, frame) <= BLIP_LEVELS
}

const diffFrom = (prev: Uint8Array | null, frame: Uint8Array) => (prev ? Number(changedShare(prev, frame).toFixed(5)) : 0)

/** One changed share per decoded frame, rounded to 5 places; a codec blip frame reads as its predecessor. */
export async function frameDiffs(video: string, exec: FfmpegExec = spawnFfmpeg): Promise<number[]> {
  const diffs: number[] = []
  let prev: Uint8Array | null = null
  let held: Uint8Array | null = null
  for await (const next of decodedFrames(video, exec)) {
    if (held) {
      const shown: Uint8Array = prev && isCodecBlip(prev, held, next) ? prev : held
      diffs.push(diffFrom(prev, shown))
      prev = shown
    }
    held = next
  }
  if (held) diffs.push(diffFrom(prev, held))
  return diffs
}
