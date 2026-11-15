import { visibleLines } from "@titan-design/session-read";
import { bulletsAfter } from "./follow-ups.js";

export const CHECK_CANDIDATES_HEADING = "Check-candidates:";
const CHECK_CANDIDATES_NONE = "Check-candidates: none";
export const MAX_CHECK_CANDIDATES = 5;
export const MAX_CHECK_SKETCH_CHARS = 160;

/** The audit's routes without `none`: a reviewer writes no line for a one-off rather than a line routed nowhere. */
export const CHECK_ROUTES = ["lint", "type", "structure", "test", "analysis", "design", "prompt", "docs"] as const;

export type CheckRoute = (typeof CHECK_ROUTES)[number];

/** A standard class's default route; `none` marks the classes that never become a check. */
export type CheckClassRoute = CheckRoute | "none";

const byRoute = (route: CheckClassRoute, keys: readonly string[]): { key: string; route: CheckClassRoute }[] => keys.map((key) => ({ key, route }));

/** The review audit's fixed vocabulary of 45 class keys, so the same class counts as one across PRs whatever the reviewer's wording. */
export const CHECK_CLASSES: readonly { readonly key: string; readonly route: CheckClassRoute }[] = [
  ...byRoute("design", ["fail-open-on-missing-or-unreadable-input", "approval-or-gate-bypass", "parallel-reader-diverges", "fix-applied-to-one-branch", "unlocked-read-modify-write", "stale-read-after-wait", "visibility-leak"]),
  ...byRoute("test", ["parser-edge-case", "producer-consumer-mismatch", "missing-branch-test", "test-name-overclaims", "test-checks-nothing"]),
  ...byRoute("structure", ["stale-doc-after-contract-change", "doc-omits-new-flag-or-kind", "cli-flag-not-wired", "unused-public-api", "release-ordering", "changeset-rules", "task-done-when-unmet"]),
  ...byRoute("type", ["hand-written-schema-drift", "consumer-enum-missing-member", "wrong-signature"]),
  ...byRoute("analysis", ["duplicated-helper", "attestation-contradicts-diff", "multi-step-sequence-bug"]),
  ...byRoute("lint", ["unsafe-file-read", "path-containment", "swallowed-error", "real-clock-in-test", "import-order", "formatting", "duplicate-test-block", "complexity"]),
  ...byRoute("prompt", ["prose-claim-false", "external-api-semantics", "toctou-race"]),
  ...byRoute("none", ["logic-bug-one-off", "stale-code-comment", "stale-pr-description", "naming", "ordering-or-sort", "known-gap-stated", "preexisting-behaviour", "cosmetic", "status-noise"]),
];

const STANDARD_KEYS: ReadonlySet<string> = new Set(CHECK_CLASSES.map((entry) => entry.key));

/** One finding a reviewer thinks a check could have caught; it never decides the verdict. */
export interface CheckCandidate {
  /** A standard key, or `other:<slug>` for a key the reviewer coined. */
  classKey: string;
  route: CheckRoute;
  sketch: string;
}

export const CHECK_CANDIDATES_WARNINGS = ["multiple_blocks", "bad_item", "bad_route", "too_many", "too_long"] as const;

/** Why a Check-candidates block was dropped whole; a closed set, so no reviewer text travels with it. */
export type CheckCandidatesWarning = (typeof CHECK_CANDIDATES_WARNINGS)[number];

export interface ParsedCheckCandidates {
  items: CheckCandidate[];
  warning?: CheckCandidatesWarning;
}

const OTHER_PREFIX = /^other:/i;

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

/** Spellings that differ only in case, spacing or punctuation give one key; anything off the list is kept, marked as coined. */
function classKeyOf(written: string): string | undefined {
  const key = slug(written.replace(OTHER_PREFIX, ""));
  if (key === "") return undefined;
  return STANDARD_KEYS.has(key) && !OTHER_PREFIX.test(written) ? key : `other:${key}`;
}

const isRoute = (route: string): route is CheckRoute => (CHECK_ROUTES as readonly string[]).includes(route);

function parseItem(line: string): CheckCandidate | CheckCandidatesWarning {
  const fields = line.slice(2).split(" | ").map((field) => field.trim());
  if (fields.length !== 3) return "bad_item";
  const [written = "", writtenRoute = "", sketch = ""] = fields;
  const route = writtenRoute.toLowerCase();
  if (!isRoute(route)) return "bad_route";
  const classKey = classKeyOf(written);
  if (classKey === undefined || sketch === "") return "bad_item";
  if (sketch.length > MAX_CHECK_SKETCH_CHARS) return "too_long";
  return { classKey, route, sketch };
}

/**
 * The one `Check-candidates:` block anywhere in a reviewer's visible text, before or after the verdict lines. Any fault drops
 * the whole block with one named warning rather than recording part of it, and nothing here can change the verdict.
 */
export function parseCheckCandidates(text: string): ParsedCheckCandidates {
  const lines = visibleLines(text);
  const headings = lines.flatMap((line, index) => (line?.startsWith(CHECK_CANDIDATES_HEADING) ? [index] : []));
  if (headings.length === 0) return { items: [] };
  if (headings.length > 1) return { items: [], warning: "multiple_blocks" };
  const heading = lines[headings[0]!];
  if (heading === CHECK_CANDIDATES_NONE) return { items: [] };
  const bullets = heading === CHECK_CANDIDATES_HEADING ? bulletsAfter(lines, headings[0]!) : [];
  if (bullets.length === 0) return { items: [], warning: "bad_item" };
  if (bullets.length > MAX_CHECK_CANDIDATES) return { items: [], warning: "too_many" };
  const items: CheckCandidate[] = [];
  for (const parsed of bullets.map(parseItem)) {
    if (typeof parsed === "string") return { items: [], warning: parsed };
    items.push(parsed);
  }
  return { items };
}

/** The fields an accepted verdict carries: both absent when the reviewer named no candidate and wrote nothing malformed. */
export function checkCandidatesFields(text: string): { checkCandidates?: CheckCandidate[]; checkCandidatesWarning?: CheckCandidatesWarning } {
  const { items, warning } = parseCheckCandidates(text);
  return { ...(items.length > 0 && { checkCandidates: items }), ...(warning && { checkCandidatesWarning: warning }) };
}
