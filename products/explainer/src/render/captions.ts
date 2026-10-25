/** WebVTT from timed words: one line per cue, broken at sentence ends or at the length caps. */

export interface CaptionWord {
  text: string;
  startS: number;
  endS: number;
}

const MAX_CHARS = 42;
const MAX_WORDS = 8;
/** A cue stays up this long after its last word, unless the next cue starts sooner. */
const TAIL_S = 0.3;

function stamp(s: number): string {
  const ms = Math.round(s * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

export function captionCues(words: readonly CaptionWord[]): CaptionWord[][] {
  const out: CaptionWord[][] = [];
  let line: CaptionWord[] = [];
  for (const word of words) {
    const text = [...line, word].map((w) => w.text).join(" ");
    if (line.length > 0 && (text.length > MAX_CHARS || line.length >= MAX_WORDS)) {
      out.push(line);
      line = [];
    }
    line.push(word);
    if (/[.!?]$/.test(word.text)) {
      out.push(line);
      line = [];
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

/** No words gives a header-only file, which players accept as a track with no cues. */
export function toVtt(words: readonly CaptionWord[]): string {
  const lines = captionCues(words);
  const body = lines.map((line, i) => {
    const start = line[0]!.startS;
    const next = lines[i + 1]?.[0]?.startS ?? Infinity;
    const end = Math.min(line.at(-1)!.endS + TAIL_S, next);
    return `${i + 1}\n${stamp(start)} --> ${stamp(end)}\n${line.map((w) => w.text).join(" ")}\n`;
  });
  return `WEBVTT\n\n${body.join("\n")}`;
}
