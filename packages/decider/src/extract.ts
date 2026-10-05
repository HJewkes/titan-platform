import { isExcluded, type ExclusionPolicy, type ExclusionReason } from "./exclusion.js";
import type { LedgerRowWire } from "./ledger.js";
import type { LedgerSource, SourceCandidate } from "./source.js";
import type { LedgerStore } from "./store.js";

export interface ExtractSummary {
  source: string;
  /** Candidates the source returned past its watermark. */
  read: number;
  written: number;
  /** Candidates whose key the ledger already held. */
  alreadyIndexed: number;
  excluded: Record<ExclusionReason, number>;
  pending: number;
  errors: string[];
}

function emptyExcluded(): Record<ExclusionReason, number> {
  return { "human-only-initiative": 0, "human-only-cwd": 0, "personal-data": 0 };
}

/** Applies exclusion; a returned reason means the row must never be written. */
function admit(candidate: SourceCandidate, policy: ExclusionPolicy): LedgerRowWire | ExclusionReason {
  const { row, cwd, mentionedInitiatives } = candidate;
  const options = row.options.map(asOption);
  const verdict = isExcluded({ ...row, options, cwd, mentionedInitiatives }, policy);
  if (verdict.excluded) return verdict.reason;
  return { ...row, initiative: verdict.initiative, unclaimed: verdict.unclaimed };
}

function asOption(option: LedgerRowWire["options"][number]): { label: string; description?: string } {
  return typeof option === "string" ? { label: option } : option;
}

/**
 * Reads one source past its watermark, drops excluded rows before anything is written, appends
 * the rest by key and advances the watermark, all in one transaction.
 */
export async function extractSource(
  store: LedgerStore,
  source: LedgerSource,
  policy: ExclusionPolicy,
): Promise<ExtractSummary> {
  const read = await source.read(store.sourceWatermarks(source.name));
  const excluded = emptyExcluded();
  const admitted: LedgerRowWire[] = [];
  for (const candidate of read.candidates) {
    const result = admit(candidate, policy);
    if (typeof result === "string") excluded[result] += 1;
    else admitted.push(result);
  }
  const written = store.transaction(() => {
    const count = store.append(admitted);
    store.advance(source.name, read.watermarks);
    return count;
  });
  return {
    source: source.name,
    read: read.candidates.length,
    written,
    alreadyIndexed: admitted.length - written,
    excluded,
    pending: read.pending,
    errors: read.errors,
  };
}
