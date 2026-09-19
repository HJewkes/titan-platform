import type { CodeReadCommandMap } from "@titan-design/code-read/query";

type NodeMetric = CodeReadCommandMap["node.get"]["result"]["metrics"][number];
export type Direction = NodeMetric["direction"];

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

const MISSING_TEXT: Record<string, string> = {
  "no-rollup": "not summed for directories",
  "not-measured": "not measured",
  "not-applicable": "does not apply",
  "not-in-snapshot": "not in this snapshot",
};

export function missingText(reason: string | undefined): string {
  return reason ? (MISSING_TEXT[reason] ?? reason) : "n/a";
}

export function directionText(direction: Direction): string {
  if (direction === "higher-worse") return "higher is worse";
  if (direction === "lower-worse") return "lower is worse";
  return "neither way is worse";
}

/** siblingRank 1 is always the largest value; only `direction` says whether that is the worst or the best. */
export function rankText(metric: Pick<NodeMetric, "siblingRank" | "siblingCount" | "direction">): string {
  const { siblingRank: rank, siblingCount: count, direction } = metric;
  if (rank === null) return "not ranked";
  const place = `${ordinal(rank)} largest of ${count} siblings`;
  if (direction === "neutral") return place;
  const worst = direction === "higher-worse" ? rank === 1 : rank === count;
  const best = direction === "higher-worse" ? rank === count : rank === 1;
  if (worst && count > 1) return `${place}: the worst here`;
  if (best && count > 1) return `${place}: the best here`;
  return place;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}
