const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const PROTECTED_FILES = new Set(["codeowners", "docs/codeowners", ".github/codeowners", ".gitmodules"]);
// Owner decision of 2026-10-12 (TP-2440): main-side changes to the code that decides authority, guards tools or runs CI always earn a fresh review.
// TP-2951 fences config that decides which checks run or what they accept. Code the checks execute (scripts/, package.json,
// pnpm-lock.yaml) stays unfenced: it was reviewed on main and runs on the merged head before required contexts pass, and
// fencing it would end the carry for almost every merge-up.
const CARRY_FENCED_PREFIXES = ["packages/authority/", "packages/tool-guard/", ".github/", ".codewatch/"];
// A symlink, submodule or file at a prefix's bare name stands in for that whole tree, which the prefix test never sees.
const CARRY_FENCED_ENTRIES = new Set(CARRY_FENCED_PREFIXES.map((prefix) => prefix.slice(0, -1)));
// Exact files, so a sibling such as .egress-allow.md stays unfenced.
const CARRY_FENCED_FILES = new Set([".egress-allow"]);
const NON_CANONICAL_SEGMENTS = new Set(["", ".", ".."]);
const TRAILING_SPACE_OR_DOT = /[ .]$/;

function isNonCanonicalSegment(segment: string): boolean {
  return NON_CANONICAL_SEGMENTS.has(segment) || TRAILING_SPACE_OR_DOT.test(segment);
}

/** A path we cannot compare exactly could alias a protected one, so every caller treats it as protected. */
export function isNonCanonical(path: string): boolean {
  return !PRINTABLE_ASCII.test(path) || path.includes("\\") || path.split("/").some(isNonCanonicalSegment);
}

export function isProtectedPath(path: unknown): boolean {
  if (typeof path !== "string" || isNonCanonical(path)) return true;
  const folded = path.toLowerCase();
  return PROTECTED_FILES.has(folded);
}

/** Whether a base-side path bars a MERGE carry across a merge-up; a path that cannot be compared exactly counts as fenced. */
export function isCarryFencedPath(path: unknown): boolean {
  if (typeof path !== "string" || isNonCanonical(path)) return true;
  const folded = path.toLowerCase();
  return CARRY_FENCED_FILES.has(folded) || CARRY_FENCED_ENTRIES.has(folded) || CARRY_FENCED_PREFIXES.some((prefix) => folded.startsWith(prefix));
}

// Mirrors Shepherd's owner-tier lists (risk-tier.ts: settings, publish and owner-lever files) coarsely, so it refuses at least what they hold.
const OWNER_FLOOR_SEGMENTS = new Set([".claude", ".agent-chat"]);
const OWNER_FLOOR_PREFIXES = ["products/factory/src/shepherd/", "products/factory/src/config", "products/factory/src/cli-release", "packages/hitl/"];
const OWNER_FLOOR_STEMS = ["g10-", "adversary-", "merge-evidence-gate", "task-kind", "registration-hold", "release-head", "risk-tier", "owner-tier", "merge-facts", "owner-tap", "inbox-actions", "gate-resolve", "owner-release"];

/** Whether a changed path stays the owner's however Shepherd's own read came out; a path that cannot be compared exactly counts. */
export function isOwnerFloorPath(path: unknown): boolean {
  if (typeof path !== "string" || isNonCanonical(path)) return true;
  const segments = path.toLowerCase().split("/");
  const folded = segments.join("/");
  const name = segments.at(-1) ?? "";
  return (
    segments.some((segment) => OWNER_FLOOR_SEGMENTS.has(segment)) ||
    OWNER_FLOOR_PREFIXES.some((prefix) => folded.startsWith(prefix)) ||
    OWNER_FLOOR_STEMS.some((stem) => name.includes(stem))
  );
}
