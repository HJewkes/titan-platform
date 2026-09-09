import type { WatermarkTable } from "@titan-design/store-sqlite";
import { curate, type CurateOptions, type CurationReport } from "./curate.js";
import type { PlaybookStore } from "./store.js";
import { normalizeContent } from "./text.js";
import { PlaybookDeltaSchema, type Bullet, type ParsedDelta } from "./types.js";

export interface ReflectInput {
  sessionRef: string;
  /** Whatever the caller distilled from the session: a diary, a subgraph summary, raw notes. */
  diary: string;
  iteration: number;
  bullets: Bullet[];
  priorDeltas: ParsedDelta[];
}

/** The one stage that may call a model. Returns anything; the deltas are validated here, not trusted. */
export type Reflector = (input: ReflectInput) => Promise<unknown>;

export interface ReflectSessionInput {
  sessionRef: string;
  diary: string;
  byteOffset?: number;
}

export interface ReflectOptions extends Omit<CurateOptions, "provenance"> {
  maxIterations?: number;
  maxDeltas?: number;
}

export interface RejectedDelta {
  iteration: number;
  index: number;
  reason: string;
}

export interface ReflectionResult {
  deltas: ParsedDelta[];
  rejected: RejectedDelta[];
  iterations: number;
  report: CurationReport;
}

export interface ReflectDeps {
  store: PlaybookStore;
  /** When present, the session's offset is recorded so incremental runs know where they stopped. */
  watermark?: WatermarkTable;
}

/**
 * cass-memory's multi-iteration reflect loop: feed the growing playbook and the
 * deltas so far back in, stop early on nothing new or at the cap, then curate
 * with provenance stamped from the input, never from the model.
 */
export async function reflectSession(deps: ReflectDeps, input: ReflectSessionInput, reflector: Reflector, options: ReflectOptions = {}): Promise<ReflectionResult> {
  const maxIterations = options.maxIterations ?? 3;
  const maxDeltas = options.maxDeltas ?? 50;
  const deltas: ParsedDelta[] = [];
  const rejected: RejectedDelta[] = [];
  const seen = new Set<string>();
  let iterations = 0;
  while (iterations < maxIterations && deltas.length < maxDeltas) {
    iterations++;
    const raw = await reflector({ sessionRef: input.sessionRef, diary: input.diary, iteration: iterations, bullets: deps.store.list(), priorDeltas: [...deltas] });
    const fresh = parseDeltas(raw, seen, iterations, rejected);
    if (fresh.length === 0) break;
    deltas.push(...fresh.slice(0, maxDeltas - deltas.length));
  }
  const report = curate(deps.store, deltas, { ...curateOptions(options), provenance: { sessionRef: input.sessionRef, byteOffset: input.byteOffset } });
  advanceWatermark(deps.watermark, input);
  return { deltas, rejected, iterations, report };
}

function curateOptions(options: ReflectOptions): Omit<CurateOptions, "provenance"> {
  const { now, nearDupThreshold, conflictThreshold, inversion } = options;
  return { now, nearDupThreshold, conflictThreshold, inversion };
}

export function parseDeltas(raw: unknown, seen: Set<string>, iteration: number, rejected: RejectedDelta[]): ParsedDelta[] {
  if (!Array.isArray(raw)) {
    rejected.push({ iteration, index: -1, reason: "reflector did not return an array" });
    return [];
  }
  const fresh: ParsedDelta[] = [];
  raw.forEach((item, index) => {
    const parsed = PlaybookDeltaSchema.safeParse(item);
    if (!parsed.success) {
      rejected.push({ iteration, index, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const key = deltaKey(parsed.data);
    if (seen.has(key)) return;
    seen.add(key);
    fresh.push(parsed.data);
  });
  return fresh;
}

function deltaKey(delta: ParsedDelta): string {
  switch (delta.type) {
    case "add":
    case "replace":
    case "merge":
      return `${delta.type}:${normalizeContent(delta.content)}`;
    default:
      return `${delta.type}:${delta.bulletId}`;
  }
}

function advanceWatermark(watermark: WatermarkTable | undefined, input: ReflectSessionInput): void {
  if (!watermark) return;
  watermark.ensure(input.sessionRef);
  watermark.advance(input.sessionRef, { lastOffset: input.byteOffset ?? 0 });
}
