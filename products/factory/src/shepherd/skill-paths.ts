/** A segment a filesystem may read as another name: `.`, `..`, empty, or one ending in a space or dot that Windows and macOS strip. */
function isNonCanonicalSegment(segment: string): boolean {
  return segment === "" || segment === "." || segment === ".." || /[ .]$/.test(segment);
}

/** Outside printable ASCII or holding a backslash, a path can alias `.claude/skills` under some fold this check does not model. */
function isNonCanonical(path: string): boolean {
  return /[^\x20-\x7e]|\\/.test(path) || path.split("/").some(isNonCanonicalSegment);
}

/**
 * Case is folded, as a case-insensitive checkout writes `.Claude/Skills/x` into `.claude/skills/`. A bare `.claude` or
 * `.claude/skills` entry counts, so a PR that swaps either directory for a symlink still gates.
 */
export function isSkillPath(path: string): boolean {
  if (isNonCanonical(path)) return true;
  const segments = path.toLowerCase().split("/");
  return segments.some((segment, i) => segment === ".claude" && (i === segments.length - 1 || segments[i + 1] === "skills"));
}

export function skillPathsIn(paths: readonly string[]): string[] {
  return paths.filter(isSkillPath);
}
