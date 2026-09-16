/**
 * The unit the whole harness turns on: one query a retriever could have been
 * given, and the files the agent went on to open after being given none.
 *
 * Labels are *observed reads*, not judged relevance. They undercount badly —
 * an agent reads what it managed to find, so a file it never located is
 * invisible here. Every number downstream inherits that bias; see REPORT.md.
 */

export type Arm = "spawn" | "bootstrap";

/**
 * One labelled file in the three vocabularies a retriever might answer in.
 *
 * `absolute` is ground truth. `relative` is what `active-work search` returns
 * as `path`, and `ref` is what it returns as `ref`; a candidate that answers in
 * either form still scores, which is the only reason both are carried.
 */
export interface Label {
  absolute: string;
  /** Path relative to the active-work root, for files under it. */
  relative?: string;
  /** `note:<slug>/<file>`, `source:<slug>/<file>` or `task:<id>`. */
  ref?: string;
}

export interface EvalPair {
  arm: Arm;
  /** Stable across runs, so a JSONL diff is readable. */
  id: string;
  /** The full trigger text: a spawn brief, or one session's open-loop texts. */
  query: string;
  labels: Label[];
  provenance: Provenance;
}

export interface Provenance {
  /** Transcript the query was read from. */
  queryTranscript?: string;
  /** Transcript the labels were read from. */
  labelTranscript?: string;
  /** Session record the open loops came from, for the bootstrap arm. */
  sessionFile?: string;
  /** How the label transcript was found, so a link rate can be audited. */
  linkedBy?: LinkMethod;
  timestamp?: string;
  initiative?: string;
}

export type LinkMethod = "brief-text" | "brief-text+timestamp" | "session-id" | "harness-id";

/** Every distinct label vocabulary one pair offers, for matching against a hit id. */
export function labelKeys(label: Label): string[] {
  return [label.absolute, label.relative, label.ref].filter((k): k is string => k !== undefined);
}

/**
 * Which labels a run is scored against.
 *
 * `all` is the honest denominator: everything the agent opened. It is also a
 * denominator no workspace retriever can ever fill, because most of what an
 * agent opens is repository code that the workspace index does not contain. So
 * both are reported. `all` answers "how much of the agent's reading could this
 * have replaced"; `workspace` answers "of the things this retriever could
 * possibly have returned, how many did it rank", which is the ranking question.
 */
export type LabelScope = "all" | "workspace";
export const LABEL_SCOPES: LabelScope[] = ["all", "workspace"];

/** Narrow a pair to one scope, or drop it when the scope leaves it with no labels. */
export function scopePair(pair: EvalPair, scope: LabelScope): EvalPair | undefined {
  if (scope === "all") return pair;
  const labels = pair.labels.filter((label) => label.relative !== undefined);
  return labels.length === 0 ? undefined : { ...pair, labels };
}

export function parsePairs(jsonl: string): EvalPair[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as EvalPair);
}

export function formatPairs(pairs: EvalPair[]): string {
  return pairs.map((pair) => JSON.stringify(pair)).join("\n") + "\n";
}
