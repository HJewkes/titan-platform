import type { PrKey } from "../head-guard/epoch-store.js";
import { isFactEntry, type FactEntry } from "../registry/entry.js";
import { schemaHash, type createRegistry } from "../registry/registry.js";
import { currentMarker, type MarkerRow } from "./marker-store.js";
import { itemKey, pinFor, type Pin, type PinSources } from "./pins.js";
import { outputDigest } from "./projection.js";

export interface ValidityContext {
  registry: ReturnType<typeof createRegistry>;
  sources: PinSources;
  now: string;
}

type Reason = "unpinnable" | "no-marker" | "ttl-expired" | "version" | "input-absent" | "input-changed" | "cycle";

/**
 * A valid fact carries the digests its dependents compare against. A pin-source fact (O4) has no marker. `drift` names
 * inputs whose full output moved under an equal projection: the fact stays valid and is never re-run for them.
 */
type Verdict =
  | { status: "valid"; marker?: MarkerRow; digests: { projection: string | null; output: string | null }; drift: string[] }
  | { status: "absent"; reason: Reason; detail?: string; inputs: InputVerdict[] };

interface InputVerdict {
  fact: string;
  verdict: Verdict;
}

type Pinned = Exclude<Pin, { unpinnable: string }>;

/** The marker version: the schema hash plus the entry's bump, so either one moving invalidates every marker of the fact. */
export const versionOf = (entry: FactEntry): string => `${schemaHash(entry)}+b${entry.version.bump}`;

/** v9.1 §2.3 validity, inputs first. Reads marker columns only, never blobs, so a collected output is still valid. */
export function evaluateFact(ctx: ValidityContext, target: { item: PrKey; fact: string }): Promise<Verdict> {
  return evaluate(ctx, target.item, target.fact, new Map(), []);
}

async function evaluate(ctx: ValidityContext, item: PrKey, fact: string, memo: Map<string, Verdict>, path: string[]): Promise<Verdict> {
  if (path.includes(fact)) return absent("cycle", [], [...path, fact].join(" -> "));
  const known = memo.get(fact);
  if (known) return known;
  const verdict = await evaluateOnce(ctx, item, fact, memo, [...path, fact]);
  memo.set(fact, verdict);
  return verdict;
}

async function evaluateOnce(ctx: ValidityContext, item: PrKey, fact: string, memo: Map<string, Verdict>, path: string[]): Promise<Verdict> {
  const entry = ctx.registry.entries.find((candidate): candidate is FactEntry => isFactEntry(candidate) && candidate.fact === fact);
  const inputs: InputVerdict[] = [];
  for (const input of entry?.materialInputs ?? []) inputs.push({ fact: input.fact, verdict: await evaluate(ctx, item, input.fact, memo, path) });
  const broken = inputs.find((input) => input.verdict.status === "absent");
  // ABSENT matches nothing, even a digest recorded while the input was absent.
  if (broken) return absent(broken.verdict.status === "absent" && broken.verdict.reason === "cycle" ? "cycle" : "input-absent", inputs, broken.fact);
  const pin = await pinFor(fact, item, ctx.sources, ctx.now);
  if ("unpinnable" in pin) return absent("unpinnable", inputs, pin.unpinnable);
  if (!entry) return pinSourceVerdict(pin);
  return markerVerdict(ctx, entry, itemKey(item), pin, inputs);
}

/** A fact no registry entry produces (today `head:pushed`) is valid at its current pin; a tree pin projects `{ head }`. */
function pinSourceVerdict(pin: Pinned): Verdict {
  const value = pin.pinClass === "tree" ? { head: pin.pin.slice(0, pin.pin.lastIndexOf("@e")) } : { pin: pin.pin };
  const digest = outputDigest(value);
  return { status: "valid", digests: { projection: digest, output: digest }, drift: [] };
}

function markerVerdict(ctx: ValidityContext, entry: FactEntry, item: string, pin: Pinned, inputs: InputVerdict[]): Verdict {
  const marker = currentMarker(ctx.sources.db, { item, fact: entry.fact, pinClass: pin.pinClass, pin: pin.pin });
  if (!marker) return absent("no-marker", inputs);
  if (marker.expiresAt !== null && Date.parse(ctx.now) >= Date.parse(marker.expiresAt)) return absent("ttl-expired", inputs, marker.expiresAt);
  if (marker.version !== versionOf(entry)) return absent("version", inputs, marker.version);
  // The recorded pin is deliberately not compared: an input re-run at a new pin with an equal projection is the cutoff.
  const changed = inputs.find(({ fact, verdict }) => marker.inputDigests[fact]?.projection !== digestsOf(verdict)?.projection);
  if (changed) return absent("input-changed", inputs, changed.fact);
  const drift = inputs.filter(({ fact, verdict }) => {
    const recorded = marker.inputDigests[fact]?.output;
    return recorded !== undefined && recorded !== digestsOf(verdict)?.output;
  });
  return { status: "valid", marker, digests: { projection: marker.projectionDigest, output: marker.outputDigest }, drift: drift.map(({ fact }) => fact) };
}

const digestsOf = (verdict: Verdict) => (verdict.status === "valid" ? verdict.digests : undefined);

function absent(reason: Reason, inputs: InputVerdict[], detail?: string): Verdict {
  return detail === undefined ? { status: "absent", reason, inputs } : { status: "absent", reason, detail, inputs };
}
