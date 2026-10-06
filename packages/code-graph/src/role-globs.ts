import { gitattributesPatternToRegex } from "./generated.js";
import type { NodeRole } from "./types.js";

/**
 * Repo-configured role globs, read from `.codewatch/roles.json`. They label
 * paths no filename convention can (a design system's `lab/` playground is
 * too generic a directory name to guess), and they beat the built-in role
 * heuristics. Globs use `.gitattributes` syntax, matched against file ids.
 */
export type RoleGlobs = Partial<Record<NodeRole, string[]>>;

/** Validate parsed roles.json: an object mapping known roles to string arrays. */
export function parseRoleGlobs(
  value: unknown,
  label: string,
  knownRoles: readonly NodeRole[],
): RoleGlobs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object mapping roles to glob arrays`);
  }
  const out: RoleGlobs = {};
  for (const [role, globs] of Object.entries(value)) {
    if (!knownRoles.includes(role as NodeRole)) {
      throw new Error(`${label}: unknown role "${role}"`);
    }
    if (!Array.isArray(globs) || !globs.every((g) => typeof g === "string")) {
      throw new Error(`${label}: "${role}" must be an array of glob strings`);
    }
    out[role as NodeRole] = globs;
  }
  return out;
}

/** Compile role globs into a lookup; the first role in `order` with a matching glob wins. */
export function roleGlobMatcher(
  globs: RoleGlobs | undefined,
  order: readonly NodeRole[],
): (id: string) => NodeRole | undefined {
  const compiled = order.flatMap((role) =>
    (globs?.[role] ?? []).map((g) => ({ role, rx: gitattributesPatternToRegex(g) })),
  );
  return (id) => compiled.find(({ rx }) => rx.test(id))?.role;
}
