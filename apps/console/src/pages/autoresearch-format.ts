import type { ArIdea, ArLadder, ArOutcome, ArRound, ArRunView } from "../../server/autoresearch-view.js";

const SHORT_SHA = 7;
const SHORT_ID = 6;

export const shortSha = (sha: string): string => sha.slice(0, SHORT_SHA);

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA = /^[0-9a-f]{7,64}$/i;

/** Only a plain `owner/name` and a hex sha become a GitHub URL; anything else stays text rather than a malformed link. */
export function commitUrl(repo: string | undefined, sha: string): string | undefined {
  return repo !== undefined && REPO.test(repo) && SHA.test(sha) ? `https://github.com/${repo}/commit/${sha}` : undefined;
}

/** A snapshot PR's own URL when the factory recorded one, else one built from the target's repository like `commitUrl`. */
export function pullUrl(repo: string | undefined, pr: number, url?: string): string | undefined {
  if (url?.startsWith("https://") === true) return url;
  return repo !== undefined && REPO.test(repo) ? `https://github.com/${repo}/pull/${pr}` : undefined;
}

/** The round's ratchet move, when this outcome is the winner that made it. */
export function keptMove(round: ArRound, outcome: ArOutcome | null): ArRound["ratchet"] {
  const { ratchet } = round;
  return outcome?.verdict === "kept" && ratchet !== null && ratchet.to === outcome.head ? ratchet : null;
}

/** Idea ids share the `i-` prefix, so the short form keeps it and the first hex digits. */
export const shortId = (id: string): string => id.slice(0, SHORT_ID);

/** How many parents deep the idea sits, once the read model counts it; nothing before then. */
export const depthSuffix = ({ lineageDepth }: ArIdea): string => (lineageDepth === undefined ? "" : ` · depth ${lineageDepth}`);

export const ladders = (run: ArRunView): ArLadder[] => run.rounds.flatMap((round) => round.ladders);

export const signed = (value: number, digits = 1): string => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

/** Design §2.3: the human label for each reason code an autoresearch outcome carries. */
const REASON_LABELS: Readonly<Record<string, string>> = {
  "beyond-band": "Δ > 2σ",
  "more-all-gate": "more all-gate passes, Δ ≥ −σ",
  confirmed: "in band, both confirms beat B",
  "confirm-lost": "in band, a confirm lost",
  "not-better": "Δ ≤ 0",
  "fewer-all-gate": "fewer all-gate passes than B",
  "single-caller": "guard exceeded",
  "hidden-regression": "zero-tolerance violation",
  "no-op": "no-op metric was 0",
  "clearly-worse": "L2 run below −2σ",
  "no-micro-signal": "micro rung missed predicted direction",
  superseded: "another winner moved the ratchet first; requeued",
  conflict: "the merge onto the new head conflicted",
  "no-integrate": "the host cannot merge onto the new head",
};

/** C-256 S5a: a later winner rejected when measured again on the head the round's first winner left. */
const REEVAL_PREFIX = "reeval:";

/** Codes that carry a name after their prefix, so the label names it too. */
const PREFIXED_LABELS: readonly (readonly [string, string])[] = [
  ["rejected:post:", "L0 static check failed"],
  ["guard:", "guard exceeded"],
  ["violation:", "zero-tolerance violation"],
  ["error:", "step failed"],
];

/** An unknown code has no label, so the page shows the bare code rather than guess at one. */
export function reasonLabel(code: string): string | undefined {
  if (code.startsWith(REEVAL_PREFIX)) {
    const inner = code.slice(REEVAL_PREFIX.length);
    return `re-evaluated on the new head: ${reasonLabel(inner) ?? inner}`;
  }
  const exact = REASON_LABELS[code];
  if (exact !== undefined) return exact;
  const prefixed = PREFIXED_LABELS.find(([prefix]) => code.startsWith(prefix));
  return prefixed ? `${prefixed[1]}: ${code.slice(prefixed[0].length)}` : undefined;
}

export function reasonText(code: string): string {
  const label = reasonLabel(code);
  return label === undefined ? code : `${code}: ${label}`;
}
