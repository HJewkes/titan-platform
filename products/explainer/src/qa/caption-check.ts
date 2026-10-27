import { z } from "zod";

/**
 * The caption track against the narration (content standards XT-32, XT-33, RA-1, RA-11..13; WCAG 1.2.2 Level A):
 * the VTT parses and has cues, its words are words.json's, and each cue keeps the line, reading-rate and onset limits.
 */
export const CAPTION_LIMITS = { lineChars: 42, lines: 2, cps: 20, onsetS: 0.3 } as const;

export const CAPTION_RULES = ["complete", "words", "lines", "cps", "onset"] as const;
export type CaptionRule = (typeof CAPTION_RULES)[number];

export const CaptionReportSchema = z.object({
  cues: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  findings: z.array(z.object({ rule: z.enum(CAPTION_RULES), cue: z.number().int().nullable(), message: z.string() })),
});
export type CaptionReport = z.infer<typeof CaptionReportSchema>;
type CaptionFinding = CaptionReport["findings"][number];

interface Cue {
  index: number;
  startS: number;
  endS: number;
  lines: string[];
}

interface Token {
  text: string;
  startS: number;
}

/** Only what captions need of words.json: each beat's offset and its words' starts. */
const CaptionWordsSchema = z.object({
  beats: z.array(z.object({ startS: z.number(), words: z.array(z.object({ word: z.string(), start: z.number() })).default([]) })),
});

const STAMP = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})$/;

function seconds(stamp: string): number | undefined {
  const match = STAMP.exec(stamp);
  if (!match) return undefined;
  const [, h = "0", m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** What a viewer reads: tags dropped and the three escapes WebVTT requires decoded. */
const shown = (line: string): string => line.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Lower case, letters and digits only, so punctuation and markup never count as a different word. */
const normalised = (text: string): string[] => text.toLowerCase().split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);

function parseCue(block: string[], index: number, findings: CaptionFinding[]): Cue | undefined {
  const at = block.findIndex((line) => line.includes("-->"));
  const [start, end] = at < 0 ? [] : block[at]!.split("-->").map((part) => part.trim().split(/\s+/)[0]!);
  const startS = start === undefined ? undefined : seconds(start);
  const endS = end === undefined ? undefined : seconds(end);
  if (startS === undefined || endS === undefined || endS <= startS) {
    findings.push({ rule: "complete", cue: index, message: `cue ${index} has no valid timing line` });
    return undefined;
  }
  const lines = block.slice(at + 1).map(shown);
  if (lines.join("").trim() === "") findings.push({ rule: "complete", cue: index, message: `cue ${index} has no text` });
  return { index, startS, endS, lines };
}

/** Header, then blank-line-separated blocks; NOTE, STYLE and REGION blocks are not cues. */
function parseVtt(vtt: string, findings: CaptionFinding[]): Cue[] {
  const blocks = vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((block) => block.split("\n").filter((line) => line !== ""));
  const [header, ...rest] = blocks;
  if (!/^WEBVTT(?:[ \t]|$)/.test(header?.[0] ?? "")) findings.push({ rule: "complete", cue: null, message: "captions.vtt does not start with WEBVTT" });
  const cueBlocks = rest.filter((block) => block.length > 0 && !/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block[0]!));
  return cueBlocks.flatMap((block, i) => parseCue(block, i + 1, findings) ?? []);
}

function spokenTokens(words: unknown): Token[] {
  const { beats } = CaptionWordsSchema.parse(words);
  return beats.flatMap((beat) => beat.words.flatMap(({ word, start }) => normalised(word).map((text) => ({ text, startS: beat.startS + start }))));
}

function wordFindings(cues: readonly Cue[], spoken: readonly Token[]): CaptionFinding[] {
  const said = cues.flatMap((cue) => normalised(cue.lines.join(" ")));
  const at = said.findIndex((word, i) => word !== spoken[i]?.text);
  const first = at >= 0 ? at : said.length === spoken.length ? -1 : Math.min(said.length, spoken.length);
  if (first < 0) return [];
  const message = `word ${first + 1}: captions "${said[first] ?? "(end)"}", words.json "${spoken[first]?.text ?? "(end)"}" (${said.length} vs ${spoken.length} words)`;
  return [{ rule: "words", cue: null, message }];
}

function limitFindings(cue: Cue): CaptionFinding[] {
  const { lineChars, lines, cps } = CAPTION_LIMITS;
  const out: CaptionFinding[] = [];
  if (cue.lines.length > lines) out.push({ rule: "lines", cue: cue.index, message: `cue ${cue.index}: ${cue.lines.length} lines (at most ${lines})` });
  const longest = Math.max(...cue.lines.map((line) => [...line].length));
  if (longest > lineChars) out.push({ rule: "lines", cue: cue.index, message: `cue ${cue.index}: a ${longest}-character line (at most ${lineChars})` });
  const rate = [...cue.lines.join(" ")].length / (cue.endS - cue.startS);
  if (rate > cps) out.push({ rule: "cps", cue: cue.index, message: `cue ${cue.index}: ${rate.toFixed(1)} characters/s (at most ${cps})` });
  return out;
}

/** Each cue's first word is the next spoken word in order; a cue past the narration's end is left to the words rule. */
function onsetFindings(cues: readonly Cue[], spoken: readonly Token[]): CaptionFinding[] {
  const out: CaptionFinding[] = [];
  let next = 0;
  for (const cue of cues) {
    const first = spoken[next];
    const count = normalised(cue.lines.join(" ")).length;
    next += count;
    if (count === 0 || first === undefined) continue;
    const offS = cue.startS - first.startS;
    if (Math.abs(offS) > CAPTION_LIMITS.onsetS) out.push({ rule: "onset", cue: cue.index, message: `cue ${cue.index} starts ${offS.toFixed(2)} s from its first word (at most ±${CAPTION_LIMITS.onsetS})` });
  }
  return out;
}

/** The caption report for qa.json; no VTT at all is one `complete` finding. */
export function captionReport(vtt: string | undefined, words: unknown): CaptionReport {
  const spoken = spokenTokens(words);
  if (vtt === undefined) return { cues: 0, words: spoken.length, findings: [{ rule: "complete", cue: null, message: "no captions.vtt artifact" }] };
  const findings: CaptionFinding[] = [];
  const cues = parseVtt(vtt, findings);
  if (cues.length === 0 && spoken.length > 0) findings.push({ rule: "complete", cue: null, message: `no cues for ${spoken.length} spoken words` });
  findings.push(...wordFindings(cues, spoken), ...cues.flatMap(limitFindings), ...onsetFindings(cues, spoken));
  return { cues: cues.length, words: spoken.length, findings };
}
