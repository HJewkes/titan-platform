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
