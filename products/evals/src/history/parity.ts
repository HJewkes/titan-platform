import { isDeepStrictEqual } from "node:util";
import { labelV2, type V2Labels, type WindowPr } from "./label-v2.js";

/** The label fields the Python builder compares between label versions. */
const LABEL_FIELDS = ["prior_attempts", "follow_up_fixes", "reverted_by", "rework_commits", "rework_count", "outcome"] as const;

type LabelField = (typeof LABEL_FIELDS)[number];

export interface StoredCase {
  case_id: string;
  repo: string;
  pr_number: number;
  [field: string]: unknown;
}

/** Each repo's pinned window, keyed by the short repo name a case id starts with. */
type CachedWindow = Record<string, WindowPr[]>;

interface ParityMismatch {
  case_id: string;
  field: LabelField;
}

interface ParityReport {
  cases: number;
  mismatches: ParityMismatch[];
  /** Stored cases whose PR is not in the window: an input gap, not a label mismatch. */
  missing: string[];
}

function caseMismatches(stored: StoredCase, labels: V2Labels): ParityMismatch[] {
  return LABEL_FIELDS.filter((field) => !isDeepStrictEqual(stored[field], labels[field])).map((field) => ({
    case_id: stored.case_id,
    field,
  }));
}

/** Recomputes label v2 for every stored case from its window and lists each field that differs. */
export function v2Parity(cachedWindow: CachedWindow, storedCases: StoredCase[]): ParityReport {
  const mismatches: ParityMismatch[] = [];
  const missing: string[] = [];
  for (const stored of storedCases) {
    const repoPrs = cachedWindow[stored.repo] ?? [];
    const pr = repoPrs.find((p) => p.number === stored.pr_number);
    if (pr) mismatches.push(...caseMismatches(stored, labelV2(pr, repoPrs)));
    else missing.push(stored.case_id);
  }
  return { cases: storedCases.length, mismatches, missing };
}
