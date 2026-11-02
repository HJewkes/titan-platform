import type { PrKey } from "../head-guard/epoch-store.js";
import type { BlobStore } from "./blob-store.js";
import { markerHistory, readMarkerValues, type MarkerRow } from "./marker-store.js";
import { itemKey } from "./pins.js";
import { evaluateFact, type ValidityContext, type Verdict } from "./validity.js";

const NEWEST_SHOWN = 3;

/** `titan-factory markers why`: the fact's verdict, its inputs, any drift, and its newest marker rows. Reads only. */
export async function explainFact(ctx: ValidityContext & { blobs: BlobStore }, target: { item: PrKey; fact: string }): Promise<string[]> {
  const verdict = await evaluateFact(ctx, target);
  const missing = verdict.status === "valid" && verdict.marker ? readMarkerValues(ctx.sources.db, ctx.blobs, verdict.marker.id).missing : [];
  const history = markerHistory(ctx.sources.db, { item: itemKey(target.item), fact: target.fact });
  return formatWhy(`${target.fact} at ${itemKey(target.item)}`, verdict, missing, history);
}

function formatWhy(subject: string, verdict: Verdict, missing: readonly string[], history: readonly MarkerRow[]): string[] {
  const head = verdict.status === "valid" ? `${subject}: valid${missing.length > 0 ? `, unreplayable (missing ${missing.join(", ")})` : ""}` : `${subject}: absent, ${reasonText(verdict)}`;
  return [head, ...inputLines(verdict), ...historyLines(history)];
}

function reasonText(verdict: Extract<Verdict, { status: "absent" }>): string {
  return verdict.detail === undefined ? verdict.reason : `${verdict.reason}: ${verdict.detail}`;
}

function inputLines(verdict: Verdict): string[] {
  if (verdict.status === "absent") {
    return verdict.inputs.map(({ fact, verdict: input }) => `  input ${fact}: ${input.status === "valid" ? "valid" : `absent, ${reasonText(input)}`}`);
  }
  const recorded = Object.entries(verdict.marker?.inputDigests ?? {}).map(([fact, digest]) => `  input ${fact}: pin ${digest.pin}, projection unchanged`);
  // v8's full-versus-material split: the fact is valid on its material inputs and was not re-run for these.
  return [...recorded, ...verdict.drift.map((fact) => `  would be stale on full inputs: ${fact}`)];
}

function historyLines(history: readonly MarkerRow[]): string[] {
  const newest = history.slice(-NEWEST_SHOWN).reverse();
  return [
    `history: ${history.length} ${history.length === 1 ? "row" : "rows"}`,
    ...newest.map((row) => `  #${row.id} ${row.pinClass} ${row.pin} written ${row.writtenAt}${row.runId === null ? "" : ` run ${row.runId}`}`),
  ];
}
