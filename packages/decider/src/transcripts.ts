import { stat } from "node:fs/promises";
import { prefixHash } from "@titan-design/locator";
import {
  claudeSourceFromPath,
  discoverAllTranscripts,
  readClaudeObservations,
  type NormalizedSessionObservation,
  type ResumeBoundary,
} from "@titan-design/session-read";
import { classifyQuestion } from "./classify.js";
import type { LedgerOption, LedgerRowWire } from "./ledger.js";
import { answerFor, parseAnswerText, recommendedOption } from "./parse-answer.js";
import type { LedgerSource, SourceCandidate, SourceRead, SourceWatermark, SourceWatermarks } from "./source.js";

/**
 * The `AskUserQuestion` source, ported from active-work's `src/precedent/transcripts.ts`. It reads
 * Claude Code transcripts directly through session-read, one watermark per transcript file, so it
 * needs no miner graph.
 */

export const TRANSCRIPT_SOURCE = "transcript";

export interface TranscriptFile {
  path: string;
  /** The Claude account the file belongs to; `default` for `~/.claude`. */
  namespace: string;
}

export type InitiativeResolver = (cwd: string | null) => string | null | Promise<string | null>;

export interface TranscriptSourceOptions {
  /** Defaults to every top-level transcript under every Claude config directory. */
  transcripts?: () => Promise<readonly TranscriptFile[]>;
  /** Defaults to null, leaving exclusion's project-directory mapping to resolve the initiative. */
  resolveInitiative?: InitiativeResolver;
}

interface AskCall {
  sessionId: string;
  toolUseId: string;
  askedAt: string | null;
  cwd: string | null;
  byteOffset: number;
  input: unknown;
}

interface CallResult {
  text: string;
  answeredAt: string | null;
}

interface FileScan {
  calls: AskCall[];
  results: Map<string, CallResult>;
  end: ResumeBoundary | null;
}

interface QuestionInput {
  header?: unknown;
  question?: unknown;
  options?: unknown;
}

async function discoverTopLevel(): Promise<TranscriptFile[]> {
  const found = await discoverAllTranscripts();
  return found
    .filter((t) => t.subagentId === null)
    .map((t) => ({ path: t.absolutePath, namespace: t.account ?? "default" }));
}

/** One question's key; the first keeps v1's call-level key so v1 and v2 rows dedupe together. */
export function transcriptKey(sessionId: string, toolUseId: string, index = 0): string {
  const base = `transcript:${sessionId}:${toolUseId}`;
  return index === 0 ? base : `${base}#${index}`;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .map((part: unknown) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
      .join(" ");
  }
  return JSON.stringify(output ?? "");
}

function cwdOf(obs: NormalizedSessionObservation): string | null | undefined {
  if (obs.kind !== "metadata") return undefined;
  const entry = obs.entries.find((e) => e.name === "cwd");
  return typeof entry?.value === "string" ? entry.value : undefined;
}

function collect(obs: NormalizedSessionObservation, scan: FileScan, cwd: string | null): void {
  if (obs.kind === "tool_call" && obs.name === "AskUserQuestion") {
    scan.calls.push({
      sessionId: obs.conversation.nativeId,
      toolUseId: obs.call.nativeId,
      askedAt: obs.timestamp,
      cwd,
      byteOffset: obs.evidence.line.byteOffset,
      input: obs.input,
    });
  } else if (obs.kind === "tool_result") {
    scan.results.set(obs.call.nativeId, { text: outputText(obs.output), answeredAt: obs.timestamp });
  }
}

async function scanFile(file: TranscriptFile, since: SourceWatermark | undefined): Promise<FileScan> {
  const source = claudeSourceFromPath(file.path, file.namespace);
  const from = since?.prefixHash ? { byteOffset: since.offset, prefixHash: since.prefixHash } : undefined;
  const scan: FileScan = { calls: [], results: new Map(), end: null };
  let cwd: string | null = null;
  const observations = readClaudeObservations(source, { from }, (done) => (scan.end = done.resumeBoundary));
  for await (const obs of observations) {
    cwd = cwdOf(obs) ?? cwd;
    collect(obs, scan, cwd);
  }
  return scan;
}

function questionsOf(input: unknown): QuestionInput[] {
  const questions = (input as { questions?: unknown } | null)?.questions;
  return Array.isArray(questions)
    ? questions.filter((q): q is QuestionInput => typeof q === "object" && q !== null)
    : [];
}

function optionsOf(options: unknown): LedgerOption[] {
  if (!Array.isArray(options)) return [];
  return options.map((o: unknown) => {
    if (typeof o !== "object" || o === null || !("label" in o)) return { label: String(o) };
    const description = "description" in o && typeof o.description === "string" ? o.description : undefined;
    return description === undefined ? { label: String(o.label) } : { label: String(o.label), description };
  });
}

/** One v2 row per question in the call; a declined call keeps a null answer and stays unscored. */
function rowsForCall(call: AskCall, path: string, result: CallResult, initiative: string | null): LedgerRowWire[] {
  const parsed = parseAnswerText(result.text);
  return questionsOf(call.input).map((q, index) => {
    const question = typeof q.question === "string" ? q.question : "";
    const header = typeof q.header === "string" ? q.header : "";
    const options = optionsOf(q.options);
    const labels = options.map((o) => o.label);
    return {
      key: transcriptKey(call.sessionId, call.toolUseId, index),
      v: 2,
      source: "transcript",
      asked_at: call.askedAt,
      answered_at: result.answeredAt,
      locator: { path, byteOffset: call.byteOffset, sessionId: call.sessionId, toolUseId: call.toolUseId },
      initiative,
      category: classifyQuestion({ header, question, options: labels }),
      header,
      question,
      options,
      recommended: recommendedOption(labels),
      answer: parsed.rejected ? null : answerFor(parsed.answers, question),
    };
  });
}

/** Past the last answered call, or at the first unanswered one so the next read sees its answer. */
async function nextWatermark(file: TranscriptFile, scan: FileScan, pending: AskCall[]): Promise<SourceWatermark | null> {
  if (pending.length === 0) return scan.end && { offset: scan.end.byteOffset, prefixHash: scan.end.prefixHash };
  const offset = Math.min(...pending.map((c) => c.byteOffset));
  return { offset, prefixHash: await prefixHash(file.path, offset) };
}

async function readFile(file: TranscriptFile, since: SourceWatermark | undefined, resolve: InitiativeResolver, out: SourceRead): Promise<void> {
  const scan = await scanFile(file, since);
  const pending = scan.calls.filter((c) => !scan.results.has(c.toolUseId));
  for (const call of scan.calls) {
    const result = scan.results.get(call.toolUseId);
    if (result === undefined) continue;
    const initiative = await resolve(call.cwd);
    const rows = rowsForCall(call, file.path, result, initiative);
    out.candidates.push(...rows.map((row): SourceCandidate => ({ row, cwd: call.cwd })));
  }
  out.pending += pending.length;
  const watermark = await nextWatermark(file, scan, pending);
  if (watermark !== null) out.watermarks.set(file.path, watermark);
}

async function unchanged(file: TranscriptFile, since: SourceWatermark | undefined): Promise<boolean> {
  return since !== undefined && (await stat(file.path)).size === since.offset;
}

export function transcriptSource(options: TranscriptSourceOptions = {}): LedgerSource {
  const list = options.transcripts ?? discoverTopLevel;
  const resolve = options.resolveInitiative ?? (() => null);
  return {
    name: TRANSCRIPT_SOURCE,
    async read(since: SourceWatermarks): Promise<SourceRead> {
      const out: SourceRead = { candidates: [], watermarks: new Map(), pending: 0, errors: [] };
      for (const file of await list()) {
        try {
          if (!(await unchanged(file, since.get(file.path)))) await readFile(file, since.get(file.path), resolve, out);
        } catch (err) {
          out.errors.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return out;
    },
  };
}
