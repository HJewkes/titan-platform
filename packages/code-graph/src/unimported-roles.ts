import type { NodeRole } from "./types.js";

/**
 * Roles of files nothing imports by design, so reachability and dead-export
 * reports treat them as roots. One list, typed by role, so a new role cannot be
 * added to one report and missed in another. It lives apart from `roles.ts`,
 * which reads files, so browser-safe report code can import it.
 */
export const UNIMPORTED_ROLES: ReadonlySet<NodeRole> = new Set<NodeRole>([
  "test",
  "fixture",
  "story",
  "lab",
  "config",
  "script",
  "entry",
]);
