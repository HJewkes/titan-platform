import type { Source } from "./config.js";
import type { VideoKind, VideoRow } from "./store.js";

// The step contracts later slices implement: detect (S2), transcribe (S3) and score (S4).
// The tick (S7) composes them; S1 fixes only their shapes.

/** One id a source listing returned, before dedupe against `videos`. */
export interface DetectedVideo {
  id: string;
  source: string;
  kind: VideoKind;
  title?: string;
  published?: string;
  duration?: number;
}

export interface Detector {
  detect(source: Source, now: Date): Promise<DetectedVideo[]>;
}

export type StepErrorClass = "http429" | "no_captions" | "live" | "upcoming" | "schema_invalid" | "refusal" | "budget" | "other";

export type StepOutcome<T> = { ok: true; value: T } | { ok: false; errorClass: StepErrorClass; message: string };

export interface Transcript {
  path: string;
  via: "subtitles" | "auto-captions" | "whisper";
  words: number;
}

export interface Transcriber {
  transcribe(video: VideoRow): Promise<StepOutcome<Transcript>>;
}

export interface ScoreResult {
  card: unknown;
  costUsd: number;
}

export interface Scorer {
  score(video: VideoRow, transcript: Transcript): Promise<StepOutcome<ScoreResult>>;
}

export interface ScoreCall {
  prompt: string;
  systemPrompt: string;
  model: string;
  maxBudgetUsd: number;
}

export interface ScoreCallOutput {
  /** Unvalidated: the score step parses it against `ScoreCardSchema` itself. */
  output: unknown;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/** One bare, tool-less harness call. The real one wraps `runAgent`; tests pass a fake. */
export type ScoreRunner = (call: ScoreCall) => Promise<StepOutcome<ScoreCallOutput>>;

/** The digest call returns markdown, so `output` is a string. Same bare-call shape as the score runner. */
export type DigestRunner = (call: ScoreCall) => Promise<StepOutcome<ScoreCallOutput>>;
