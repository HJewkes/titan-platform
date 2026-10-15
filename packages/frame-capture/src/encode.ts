import { spawn } from 'node:child_process'
import { once } from 'node:events'
/** One voice clip in the mix: `wavPath(id)` names its file, and it is padded to `durationS`. */
export interface MixSegment {
  id: string
  durationS: number
}

function run(args: string[]): Promise<void> {
  const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
  return new Promise((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
  })
}

/** mix.wav: each segment's voice from its start, padded with silence to the segment's length, in order. */
export function mixAudio(segments: readonly MixSegment[], wavPath: (id: string) => string, out: string): Promise<void> {
  const inputs = segments.flatMap((segment) => ['-i', wavPath(segment.id)])
  const pads = segments.map((segment, i) => `[${i}:a]apad=whole_dur=${segment.durationS}[a${i}]`)
  const concat = `${segments.map((_, i) => `[a${i}]`).join('')}concat=n=${segments.length}:v=0:a=1[mix]`
  return run([...inputs, '-filter_complex', [...pads, concat].join(';'), '-map', '[mix]', out])
}

export interface Encoder {
  write(png: Buffer): Promise<void>
  finish(): Promise<void>
}

/** One ffmpeg reading PNGs on stdin, muxing mix.wav, writing H.264 + AAC with no run-specific metadata. */
export function startEncoder(out: string, fps: number, audio: string): Encoder {
  const args = [
    '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-i', audio,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
    '-c:a', 'aac', '-shortest',
    '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact',
    out,
  ]
  const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  const closed = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', reject)
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
  })
  return {
    async write(png) {
      if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, 'drain')
    },
    async finish() {
      ffmpeg.stdin.end()
      await closed
    },
  }
}
