/**
 * Black, silent and frozen stretches of a video, from one ffmpeg pass of blackdetect, silencedetect and freezedetect.
 * The filters report on stderr, so the scan reads ffmpeg's log, not its output, through the same exec seam as
 * framediff.
 */
import { spawnFfmpeg, type FfmpegExec } from './framediff.js'

/** A blank picture this long reads as a dropped frame run, not a cut's dip to black. */
export const BLACK_MIN_S = 0.5
/** Below this level is silence; narration's quietest syllables sit well above it. */
export const SILENCE_NOISE_DB = -50
/** The ar target 3 guard counts silences of 2 s and more. */
export const SILENCE_MIN_S = 2
/** A picture held this long is a static stretch (DIRECTION's static window). */
export const FREEZE_MIN_S = 3

export interface MediaInterval {
  startS: number
  endS: number
}

export interface MediaScan {
  black: MediaInterval[]
  silence: MediaInterval[]
  freeze: MediaInterval[]
}

/** Detector arguments: decode `video` once, run the three filters and discard the output. */
export function mediaScanArgs(video: string): string[] {
  return [
    '-hide_banner', '-nostats', '-i', video,
    '-vf', `blackdetect=d=${BLACK_MIN_S},freezedetect=d=${FREEZE_MIN_S}`,
    '-af', `silencedetect=n=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_S}`,
    '-f', 'null', '-',
  ]
}

/** The detect filters log to stderr; frames go nowhere. */
const readLog: FfmpegExec = (args) => spawnFfmpeg(args, 'ffmpeg', 'stderr')

const NUM = '(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)'
const BLACK = new RegExp(`\\[blackdetect @ [^\\]]*\\] black_start:\\s*${NUM} black_end:\\s*${NUM}`)
const SILENCE_START = new RegExp(`\\[silencedetect @ [^\\]]*\\] silence_start:\\s*${NUM}`)
const SILENCE_END = new RegExp(`\\[silencedetect @ [^\\]]*\\] silence_end:\\s*${NUM}`)
const FREEZE_START = new RegExp(`\\[freezedetect @ [^\\]]*\\] lavfi\\.freezedetect\\.freeze_start:\\s*${NUM}`)
const FREEZE_END = new RegExp(`\\[freezedetect @ [^\\]]*\\] lavfi\\.freezedetect\\.freeze_end:\\s*${NUM}`)
const DURATION = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/

const seconds = (text: string): number => Math.max(0, Number(Number(text).toFixed(3)))

/** Pairs start and end lines of one detector; a start left open at the end runs to `endS`. */
function intervals(lines: readonly string[], start: RegExp, end: RegExp, endS: number): MediaInterval[] {
  const out: MediaInterval[] = []
  let open: number | null = null
  for (const line of lines) {
    const started = start.exec(line)
    const ended = end.exec(line)
    if (started) open = seconds(started[1]!)
    else if (ended && open !== null) {
      out.push({ startS: open, endS: seconds(ended[1]!) })
      open = null
    }
  }
  if (open !== null) out.push({ startS: open, endS })
  return out
}

/** The input's length from its header; freezedetect logs no end for a freeze that lasts to the last frame. */
function durationS(log: string): number {
  const m = DURATION.exec(log)
  return m ? seconds(String(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))) : 0
}

/** The three detectors' intervals from ffmpeg's stderr, in the order logged. */
export function parseMediaScan(log: string): MediaScan {
  const lines = log.split(/\r?\n/)
  const endS = durationS(log)
  const black = lines.flatMap((line) => {
    const m = BLACK.exec(line)
    return m ? [{ startS: seconds(m[1]!), endS: seconds(m[2]!) }] : []
  })
  return { black, silence: intervals(lines, SILENCE_START, SILENCE_END, endS), freeze: intervals(lines, FREEZE_START, FREEZE_END, endS) }
}

/** Scans `video`; rejects when ffmpeg fails, so an unreadable video never reads as a clean one. */
export async function mediaScan(video: string, { exec = readLog }: { exec?: FfmpegExec } = {}): Promise<MediaScan> {
  const decoder = new TextDecoder()
  let log = ''
  for await (const chunk of exec(mediaScanArgs(video))) log += decoder.decode(chunk, { stream: true })
  return parseMediaScan(log + decoder.decode())
}
