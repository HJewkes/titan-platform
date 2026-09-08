import type { GraphNode, NodeRole } from "./types.js";
import { isGeneratedFile, loadGeneratedPatterns } from "./generated.js";

const TEST_RE = /(?:^|\/)(?:__tests__\/|tests?\/)|\.(?:test|spec)(?:\.[a-z]+)?$/;
const FIXTURE_RE = /(?:^|\/)fixtures(?:\/|$)/;
// One-off tooling under scripts/ or dormant archive/ dirs: report noise, not
// product signal. Test-ness wins (checked first) since it's more meaningful.
const SCRIPT_RE = /(?:^|\/)(?:scripts|archive)(?:\/|$)/;
const BARREL_RE = /(?:^|\/)index(?:\.[a-z]+)?$/;
const TYPES_RE = /(?:^|\/)(?:[a-z][\w-]*\.)?types(?:\.[a-z]+)?$/i;
const CONFIG_RE = /\.config(?:\.[a-z]+)?$/;

export const ALL_ROLES: readonly NodeRole[] = [
  "test",
  "fixture",
  "barrel",
  "types",
  "config",
  "script",
  "entry",
  "generated",
  "source",
];

export interface RoleHints {
  /** File begins with a `#!` shebang, i.e. it is an executable entry point. */
  hasShebang?: boolean;
  /** File is codegen output (`.gitattributes linguist-generated` or heuristic). */
  isGenerated?: boolean;
}

export function classifyRole(id: string, hints?: RoleHints): NodeRole {
  // Generated wins outright: codegen output is noise for every human-facing
  // signal, so labeling it `generated` (not, say, `barrel` for a `.gen` index)
  // is what lets hotspots/unused-exports exclude it at one shared boundary.
  if (hints?.isGenerated) return "generated";
  if (TEST_RE.test(id)) return "test";
  if (FIXTURE_RE.test(id)) return "fixture";
  if (SCRIPT_RE.test(id)) return "script";
  // A shebang-prefixed file (e.g. a CLI's index.ts) is an executable entry
  // point, not re-export plumbing — check before the filename barrel heuristic
  // so it doesn't get mislabeled as `barrel`. `entry` seeds reachability (like
  // a barrel) and is exempt from the fan-out smell (an entry legitimately wires
  // up many command modules).
  if (hints?.hasShebang) return "entry";
  if (BARREL_RE.test(id)) return "barrel";
  if (TYPES_RE.test(id)) return "types";
  if (CONFIG_RE.test(id)) return "config";
  return "source";
}

export interface AnnotateRolesOptions {
  /** Node ids whose source begins with a `#!` shebang. */
  shebangIds?: ReadonlySet<string>;
  /** Node ids detected as generated (codegen output). */
  generatedIds?: ReadonlySet<string>;
}

interface ReadFileLike {
  filePath: string;
  content: string;
}

/**
 * Derive per-file role hints for a batch of read files in one pass: the shebang
 * set (executable entries) and the generated set (codegen output, detected via
 * `.gitattributes linguist-generated` under `idRoot` plus filename/path
 * heuristics). Lives here so the indexer stays at its file-size ceiling.
 */
export function computeRoleHints(
  readFiles: readonly ReadFileLike[],
  idRoot: string,
  toId: (root: string, filePath: string) => string,
): AnnotateRolesOptions {
  const patterns = loadGeneratedPatterns(idRoot);
  const shebangIds = new Set<string>();
  const generatedIds = new Set<string>();
  for (const rf of readFiles) {
    const id = toId(idRoot, rf.filePath);
    if (rf.content.startsWith("#!")) shebangIds.add(id);
    if (isGeneratedFile(id, patterns)) generatedIds.add(id);
  }
  return { shebangIds, generatedIds };
}

export function annotateRoles(
  nodes: readonly GraphNode[],
  options?: AnnotateRolesOptions,
): GraphNode[] {
  return nodes.map((n) =>
    n.kind === "file" || n.kind === "module"
      ? {
          ...n,
          role:
            n.role ??
            classifyRole(n.id, {
              hasShebang: options?.shebangIds?.has(n.id) ?? false,
              isGenerated: options?.generatedIds?.has(n.id) ?? false,
            }),
        }
      : n,
  );
}
