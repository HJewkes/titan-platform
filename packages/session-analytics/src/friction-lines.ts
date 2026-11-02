/**
 * Friction lines in worker reports. `Friction:` is the return-contract field (CC-1660); until most
 * reports carry it, `Concerns:` and blocked lines stand in, labelled so the two never read as one.
 */
export const FRICTION_SOURCES = ["friction", "concerns", "blocked"] as const;
export type FrictionSource = (typeof FRICTION_SOURCES)[number];

export const FRICTION_CLUSTERS = ["denials", "ci-wait", "flaky-test", "missing-context", "broker-infra", "review-loop", "other", "scope-note"] as const;
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

/** The report's `Concerns:` items alone, whether or not it also has `Friction:` lines. */
export const extractConcerns = (body: string): FrictionLine[] => concernLines(body.split("\n"));

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

const CI_NOUN = String.raw`(?:ci|checks?|workflows?|runners?|github actions)`;
const WAIT_WORD = String.raw`(?:wait\w*|queued|queue|pending|slow|took|poll\w*|stuck|hung)`;
/** "CI" alone is a place, not a wait: the line must also say it waited, within a few words either way. */
const CI_WAIT = new RegExp(String.raw`\b${CI_NOUN}\b(?: \w+){0,6} ${WAIT_WORD}\b|\b${WAIT_WORD}(?: \w+){0,6} ${CI_NOUN}\b`);

/**
 * First match wins, so the order settles a line that names two causes. Scope notes (design caveats,
 * follow-ups, choices to accept) come before review and context words, which they often contain.
 */
const CLUSTER_RULES: readonly [FrictionCluster, RegExp][] = [
  ["denials", /\b(?:denied|denial|denials|classifier|auto mode|permission|permissions|refused by|not allowed|blocked by the harness|leak guard|guard blocked|hook blocked|blocked by (?:the |a )?(?:hook|guard))\b/],
  [
    "flaky-test",
    /\b(?:flaky|flake|flakes|flakiness|intermittent|intermittently|nondeterministic|could not reproduce|couldn t reproduce|passes on its own|under load|down to load)\b|\btests?\b(?: \w+){0,8} (?:timed out|times out)\b/,
  ],
  ["ci-wait", CI_WAIT],
  [
    "broker-infra",
    /\b(?:broker|agent chat|socket|daemon|sqlite|disk|oom|out of memory|heap|network|rate limit(?:ed)?|quota|worktree budget|lockfile|timeouts?|timed out|not installed|venv|sandbox|pre push hook|background limit|could not run|couldn t run|cannot run|no local tool)\b/,
  ],
  [
    "scope-note",
    /\b(?:out of scope|outside the (?:file )?fence|went outside|not in this pr|follow ?up|separate(?:ly)? (?:task|pr)|needs? a [\w ]{0,20}task|accept (?:this|it|or)|please confirm|confirm against|say if you want|owner needs|unchanged|is noted|written up|not deployed|untested|by eye|left out|still stands?|none new|not met|still unmet|merge (?:pr )?n first|i (?:added|edited|placed|shrank|extended|chose|kept|named))\b/,
  ],
  ["review-loop", /\b(?:review|reviews|reviewer|verdicts?|fix rounds?|fix first|re review|nits?|request changes|adversary|held for|hold for)\b/],
  ["missing-context", /\b(?:context|brief|unclear|ambiguous|missing|undocumented|not found|could not find|couldn t find|no docs?|stale docs?|wrong path)\b/],
];

/** Lines that say something true but cost no time; they are counted, never ranked. */
export const NON_FRICTION: ReadonlySet<FrictionCluster> = new Set(["scope-note"]);

export function clusterOf(text: string): FrictionCluster {
  const normal = normaliseFriction(text);
  return CLUSTER_RULES.find(([, pattern]) => pattern.test(normal))?.[0] ?? "other";
}

/**
 * A `Concerns:` or blocked line is about the work unless it names a friction cause, so one that
 * names none is a scope note; only a line written as `Friction:` can land in `other`.
 */
export function lineCluster(line: FrictionLine): FrictionCluster {
  const cluster = clusterOf(line.text);
  return cluster === "other" && line.source !== "friction" ? "scope-note" : cluster;
}
