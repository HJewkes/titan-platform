import { z } from "zod";
import { canonicalSha } from "./eval-store.js";
import { EvidenceSchema, evalVersion, formatEvidence, readRubric, scriptRubricParts, voidReason, type Evidence } from "./eval-evidence.js";
import { judgeLabel, type JudgeConfig, type JudgeHarness, type JudgeReply } from "./eval-harness.js";
import { sumSpend, type CanaryResult, type Verdict } from "./eval-judge.js";
import type { PaceBeat } from "./pace-items.js";
import type { ScriptV1 } from "./script-schema.js";

export const COLD_RUBRIC_EVAL_ID = "L1-cold-rubric";
export const COLD_RUBRIC_DIMS = ["J8", "J9", "J10", "J11", "J12"] as const;
export type ColdRubricDim = (typeof COLD_RUBRIC_DIMS)[number];
/** A canary scored above this on its row was not caught by the judge. */
export const CANARY_MAX_SCORE = 2;
/** The earlier videos of a series the novelty row compares against. */
export const SERIES_WINDOW = 5;

/** The reported section of the shipped script rubric, which this call judges. */
export const readColdRubric = (): string => scriptRubricParts(readRubric("l1-script.md")).reported;

/** One beat as the cold viewer meets it: what is said, and the text on screen. */
export interface RubricBeat {
  id: string;
  spoken: string;
  screen: string[];
}

/** An earlier video of the series, as much of it as the novelty row compares. */
export interface SeriesVideo {
  promise: string;
  hook: string;
  chapters: string[];
}

export const rubricBeatsFromPace = (beats: readonly PaceBeat[]): RubricBeat[] =>
  beats.map((beat) => ({ id: beat.id, spoken: beat.spoken, screen: beat.items.map((item) => item.label) }));

/** Stands in for the PP-9 fingerprint until it lands: the series is read from the earlier videos' own scripts. */
export const seriesFromScripts = (scripts: readonly ScriptV1[]): SeriesVideo[] =>
  scripts.slice(-SERIES_WINDOW).map((script) => ({
    promise: script.video.promise,
    hook: script.beats[0]?.spoken ?? "",
    chapters: script.chapters.map((chapter) => chapter.label),
  }));

export interface ColdRubricCanary {
  dim: ColdRubricDim;
  key: string;
  /** Spoken line and screen text per beat; each plants the one defect its row must catch. */
  beats: { spoken: string; screen: string[] }[];
}

/** Synthetic videos, each planted with one row's defect; the judge must score that row at most `CANARY_MAX_SCORE`. */
export const COLD_RUBRIC_CANARIES: readonly ColdRubricCanary[] = [
  {
    dim: "J8",
    key: "mechanism-first",
    beats: [
      { spoken: "The queue keeps its entries in a heap ordered by deadline.", screen: ["heap of entries"] },
      { spoken: "Each tick pops the head of the heap and hands it to a worker.", screen: ["tick", "worker"] },
      { spoken: "Workers write their results to a second queue in the same order.", screen: ["result queue"] },
    ],
  },
  {
    dim: "J9",
    key: "jargon-wall",
    beats: [
      { spoken: "Set the LWW register's HLC skew bound before GC compacts the tombstones.", screen: ["LWW", "HLC"] },
      { spoken: "Then the CRDT merge is a join over the semilattice, so the OT path never runs.", screen: ["CRDT", "OT"] },
    ],
  },
  {
    dim: "J10",
    key: "search-result",
    beats: [
      { spoken: "This tool is an open source library, and it is popular.", screen: ["open source library"] },
      { spoken: "You install it with a package manager and run it from the command line.", screen: ["install command"] },
    ],
  },
  {
    dim: "J11",
    key: "vague-filler",
    beats: [
      { spoken: "This part is useful in many ways and helps with various things.", screen: ["useful part"] },
      { spoken: "Overall it makes everything better in general for everyone.", screen: ["better overall"] },
    ],
  },
  {
    dim: "J12",
    key: "clashing-looks",
    beats: [
      { spoken: "The desk server checks each scan before the ledger.", screen: ["stock photo of a handshake"] },
      { spoken: "It refuses a label whose parcel was never scanned.", screen: ["a meme in a different font and palette"] },
      { spoken: "Refused labels go back to the courier.", screen: ["seven lines of plain bullet text"] },
    ],
  },
];

const DimsSchema = z.array(z.strictObject({ dim: z.enum(COLD_RUBRIC_DIMS), evidence: z.array(EvidenceSchema), score: z.number().int().min(1).max(5) }));
const ReplySchema = z.strictObject({ videos: z.array(z.strictObject({ video: z.string(), dims: DimsSchema })) });
type RubricReply = JudgeReply<z.infer<typeof ReplySchema>>;

export interface ColdRubricInput {
  /** The judged script's sha, or an audition candidate's; it seeds the canary rotation. */
  subjectSha: string;
  beats: readonly RubricBeat[];
  /** The reported section of `l1-script.md` (`scriptRubricParts(...).reported`). */
  rubric: string;
  /** Earlier videos of the series, oldest first; empty when none is known. */
  series: readonly SeriesVideo[];
  judge: JudgeConfig;
  harness: JudgeHarness;
  run: number;
}

/**
 * Reported only: no field here is a pass or a gate, and nothing reads these scores as a verdict on the video until
 * they are calibrated against owner labels (TP-4012). `trusted` is about the judge (its canary and call), not the video.
 */
export interface ColdRubricResult {
  eval_version: string;
  judge: string;
  mode: "reported";
  dims: { dim: ColdRubricDim; verdict: Verdict }[];
  canary: CanaryResult;
  failures: string[];
  trusted: boolean;
  spend: { usd: number; tokensIn: number; tokensOut: number };
}

export const coldRubricEvalVersion = (input: Pick<ColdRubricInput, "rubric" | "judge">): string =>
  evalVersion(COLD_RUBRIC_EVAL_ID, input.rubric, input.judge, { canaries: COLD_RUBRIC_CANARIES, canary_max_score: CANARY_MAX_SCORE, series_window: SERIES_WINDOW });

interface Placed {
  canary: ColdRubricCanary;
  canaryVideo: string;
  subjectVideo: string;
  canaryBeats: RubricBeat[];
}

/** The canary row rotates over runs, and a nonce picks whether the canary is video A or B, so neither gives it away. */
function placeCanary(input: ColdRubricInput): Placed {
  const nonce = Number.parseInt(canonicalSha({ subject: input.subjectSha, run: input.run }).slice(0, 6), 16);
  const canary = COLD_RUBRIC_CANARIES[nonce % COLD_RUBRIC_CANARIES.length]!;
  const [canaryVideo, subjectVideo] = nonce % 2 === 0 ? ["A", "B"] : ["B", "A"];
  const canaryBeats = canary.beats.map((beat, i) => ({ id: `x${nonce.toString(16)}-${i + 1}`, ...beat }));
  return { canary, canaryVideo, subjectVideo, canaryBeats };
}

const beatText = (beat: RubricBeat): string => [`spoken: ${beat.spoken}`, ...(beat.screen.length > 0 ? [`screen: ${beat.screen.join("; ")}`] : [])].join("\n");
const renderVideo = (name: string, beats: readonly RubricBeat[]): string => `### Video ${name}\n\n${beats.map((b) => `[${b.id}]\n${beatText(b)}`).join("\n\n")}`;

function renderSeries(series: readonly SeriesVideo[]): string {
  if (series.length === 0) return "No earlier video of this series is known.";
  return series.map((v, i) => `${i + 1}. ${v.promise}\n   hook: ${v.hook}\n   chapters: ${v.chapters.join("; ")}`).join("\n");
}

function rubricPrompt(input: ColdRubricInput, placed: Placed): string {
  const videos = { [placed.canaryVideo]: placed.canaryBeats, [placed.subjectVideo]: input.beats };
  const shown = ["A", "B"].map((name) => renderVideo(name, videos[name]!)).join("\n\n");
  return `${input.rubric.trim()}\n\n## Earlier videos in this series\n\n${renderSeries(input.series)}\n\n## Videos\n\n${shown}\n`;
}

const verdictOf = (evidence: readonly Evidence[], score: number, texts: ReadonlyMap<string, string>): Verdict => {
  const reason = voidReason(evidence, texts);
  return { score: reason ? null : score, evidence: formatEvidence(evidence), void_reason: reason };
};

function videoVerdicts(reply: RubricReply, video: string, beats: readonly RubricBeat[]) {
  const texts = new Map(beats.map((b) => [b.id, beatText(b)]));
  const dims = reply.ok ? reply.output.videos.find((v) => v.video.replace(/^Video\s+/i, "") === video)?.dims : undefined;
  return COLD_RUBRIC_DIMS.map((dim) => {
    if (!reply.ok) return { dim, verdict: { score: null, evidence: "", void_reason: `call failed: ${reply.reason}` } };
    const found = dims?.find((d) => d.dim === dim);
    return { dim, verdict: found ? verdictOf(found.evidence, found.score, texts) : { score: null, evidence: "", void_reason: "not judged" } };
  });
}

function canaryResult(placed: Placed, reply: RubricReply): CanaryResult {
  const score = videoVerdicts(reply, placed.canaryVideo, placed.canaryBeats).find((v) => v.dim === placed.canary.dim)!.verdict.score;
  const got = score === null ? "void" : String(score);
  return { canary: placed.canary.key, dim: placed.canary.dim, got, pass: score !== null && score <= CANARY_MAX_SCORE };
}

/** One call: the subject and a canary video, scored on J8 to J12 with verbatim quotes. */
export async function runColdRubric(input: ColdRubricInput): Promise<ColdRubricResult> {
  const placed = placeCanary(input);
  const reply: RubricReply = await input.harness({ prompt: rubricPrompt(input, placed), schema: ReplySchema });
  const canary = canaryResult(placed, reply);
  const failures = reply.ok ? [] : [reply.reason];
  return {
    eval_version: coldRubricEvalVersion(input),
    judge: judgeLabel(input.judge),
    mode: "reported",
    dims: videoVerdicts(reply, placed.subjectVideo, input.beats),
    canary,
    failures,
    trusted: failures.length === 0 && canary.pass,
    spend: sumSpend([reply]),
  };
}

/** An audition candidate as the rubric sees it: its hook, block questions and signature layer, written as beats. */
export interface RubricCandidate {
  id: string;
  sha: string;
  beats: RubricBeat[];
}

/** Every candidate is scored, none skipped; the scores are recorded beside the pick and never choose it. */
export async function scoreCandidates(candidates: readonly RubricCandidate[], base: Omit<ColdRubricInput, "subjectSha" | "beats">) {
  const scored: { candidate: string; rubric: ColdRubricResult }[] = [];
  for (const c of candidates) scored.push({ candidate: c.id, rubric: await runColdRubric({ ...base, subjectSha: c.sha, beats: c.beats }) });
  return scored;
}

/** One line for a run report: each row's score, or `-` for a void one, and whether the judge's canary held. */
export function rubricNote(result: ColdRubricResult): string {
  const rows = result.dims.map((d) => `${d.dim} ${d.verdict.score ?? "-"}`).join(", ");
  const canary = result.canary.pass ? "held" : `missed (${result.canary.dim}=${result.canary.got})`;
  return `cold rubric (reported only): ${rows}; canary ${canary}`;
}
