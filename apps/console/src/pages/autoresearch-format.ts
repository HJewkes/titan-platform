import type { ArLadder, ArRunView } from "../../server/autoresearch-view.js";

const SHORT_SHA = 7;
const SHORT_ID = 6;

export const shortSha = (sha: string): string => sha.slice(0, SHORT_SHA);

/** Idea ids share the `i-` prefix, so the short form keeps it and the first hex digits. */
export const shortId = (id: string): string => id.slice(0, SHORT_ID);

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
};

/** Codes that carry a name after their prefix, so the label names it too. */
const PREFIXED_LABELS: readonly (readonly [string, string])[] = [
  ["rejected:post:", "L0 static check failed"],
  ["guard:", "guard exceeded"],
  ["violation:", "zero-tolerance violation"],
  ["error:", "step failed"],
];

/** An unknown code has no label, so the page shows the bare code rather than guess at one. */
export function reasonLabel(code: string): string | undefined {
  const exact = REASON_LABELS[code];
  if (exact !== undefined) return exact;
  const prefixed = PREFIXED_LABELS.find(([prefix]) => code.startsWith(prefix));
  return prefixed ? `${prefixed[1]}: ${code.slice(prefixed[0].length)}` : undefined;
}
