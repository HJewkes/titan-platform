/**
 * Friction lines in worker reports. `Friction:` is the return-contract field (CC-1660); until most
 * reports carry it, `Concerns:` and blocked lines stand in, labelled so the two never read as one.
 */
export const FRICTION_SOURCES = ["friction", "concerns", "blocked"] as const;
export type FrictionSource = (typeof FRICTION_SOURCES)[number];

export const FRICTION_CLUSTERS = ["denials", "ci-wait", "flaky-test", "missing-context", "broker-infra", "review-loop", "other"] as const;
export type FrictionCluster = (typeof FRICTION_CLUSTERS)[number];

export interface FrictionLine {
  source: FrictionSource;
  text: string;
}

/** The contract caps the field at 200 characters; fallback lines are held to the same length. */
export const FRICTION_MAX_CHARS = 200;
const FRICTION_LINE = /^Friction: (.+)$/;
const CONCERNS_LINE = /^Concerns:\s*(.*)$/;
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/;
const BLOCKED_LINE = /\bBLOCKED\b|^\s*(?:[-*]\s+)?Blocked\b/;
const STATUS_BLOCKED = /^Status:\s*BLOCKED\b[\s.:;,-]*(.*)$/;
const NOTHING = /^(?:none|n\/a|nothing|no concerns?)\b[\s.;,]*$/i;
/** The contract caps `Concerns:` at three items. */
const MAX_CONCERNS = 3;

const clip = (text: string) => text.trim().slice(0, FRICTION_MAX_CHARS);
const said = (text: string) => text.trim() !== "" && !NOTHING.test(text.trim());

/** The report's `Friction:` lines when it has any, else its concerns and blocked lines; "none" counts as nothing said. */
export function extractFriction(body: string): FrictionLine[] {
  const lines = body.split("\n");
  const friction = lines.flatMap((line) => {
    const match = FRICTION_LINE.exec(line.trimEnd());
    return match && said(match[1]!) ? [{ source: "friction" as const, text: clip(match[1]!) }] : [];
  });
  return friction.length > 0 ? friction : [...concernLines(lines), ...blockedLines(lines)];
}

function concernLines(lines: readonly string[]): FrictionLine[] {
  const at = lines.findIndex((line) => CONCERNS_LINE.test(line));
  if (at < 0) return [];
  const inline = CONCERNS_LINE.exec(lines[at]!)![1]!;
  const items = said(inline) ? [inline] : inline.trim() === "" ? bulletsAfter(lines, at) : [];
  return items.filter(said).slice(0, MAX_CONCERNS).map((text) => ({ source: "concerns", text: clip(text) }));
}

function bulletsAfter(lines: readonly string[], at: number): string[] {
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const bullet = BULLET.exec(line);
    if (!bullet) break;
    items.push(bullet[1]!);
  }
  return items;
}

/** A bare `Status: BLOCKED` says nothing the concerns do not; any other blocked line is kept. */
function blockedLines(lines: readonly string[]): FrictionLine[] {
  return lines.flatMap((line) => {
    if (CONCERNS_LINE.test(line) || !BLOCKED_LINE.test(line)) return [];
    const status = STATUS_BLOCKED.exec(line);
    const text = status ? status[1]! : line;
    return said(text) ? [{ source: "blocked" as const, text: clip(text) }] : [];
  });
}

/** Lower case, with links, paths, PR refs, hashes and numbers reduced to tokens, so wording, not ids, decides the cluster. */
export function normaliseFriction(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/[\w.-]+\/[\w.-]+#\d+/g, " pr ")
    .replace(/(?:~|\.{1,2})?\/[\w./-]+/g, " path ")
    .replace(/\b[0-9a-f]{7,40}\b/g, " sha ")
    .replace(/\d+(?:\.\d+)?/g, " n ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** First match wins, so the order settles a line that names two causes. */
const CLUSTER_RULES: readonly [FrictionCluster, RegExp][] = [
  ["denials", /\b(?:denied|denial|denials|classifier|auto mode|permission|permissions|refused by|not allowed|blocked by the harness)\b/],
  ["flaky-test", /\b(?:flaky|flake|flakes|flakiness|intermittent|intermittently|nondeterministic)\b/],
  ["ci-wait", /\b(?:ci|checks?|workflows?|runners?|github actions|queued|pending checks?)\b/],
  ["broker-infra", /\b(?:broker|agent chat|socket|daemon|sqlite|disk|oom|out of memory|heap|network|rate limit(?:ed)?|quota|worktree budget|install|lockfile|timeouts?|timed out)\b/],
  ["review-loop", /\b(?:review|reviews|reviewer|verdicts?|fix rounds?|re review|nits?|request changes)\b/],
  ["missing-context", /\b(?:context|brief|unclear|ambiguous|missing|undocumented|not found|could not find|couldn t find|no docs?|stale docs?|wrong path)\b/],
];

export function clusterOf(text: string): FrictionCluster {
  const normal = normaliseFriction(text);
  return CLUSTER_RULES.find(([, pattern]) => pattern.test(normal))?.[0] ?? "other";
}
