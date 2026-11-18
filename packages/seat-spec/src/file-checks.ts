import path from "node:path";
import { isCleanAbsolutePath } from "./clean-path.js";
import type { SeatRefusal } from "./refusal.js";

/** The `lstat` facts a check needs; a `fs.Stats` from `lstat` satisfies it. */
export interface FileFacts {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  uid: number;
  mode: number;
}

/** Where owner-held files may live and who must own them, as the reader observed it. */
export interface OwnerFileContext {
  ownerUid: number;
  /** Absolute, resolved path of the owner-held seats directory. */
  seatsDir: string;
  seatsDirFacts: FileFacts;
  /**
   * Absolute roots an agent can write (worktrees, agent scratch); none may contain the seats directory.
   * The list must not be empty, and each root must be a clean absolute path. Pass realpath output:
   * the compare is case-sensitive.
   */
  agentWritableRoots: readonly string[];
}

const WRITABLE_BY_OTHERS = 0o022;

const octal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");

function unsafeOwner(facts: FileFacts, ownerUid: number): SeatRefusal | undefined {
  if (facts.uid !== ownerUid) return { code: "wrong_owner", detail: `owned by uid ${facts.uid}, not ${ownerUid}` };
  if ((facts.mode & WRITABLE_BY_OTHERS) !== 0) {
    return { code: "writable_by_others", detail: `mode ${octal(facts.mode)} is group- or world-writable` };
  }
  return undefined;
}

/** Both paths are clean absolute paths (checked first), so a prefix compare on whole segments is exact. */
const isWithin = (root: string, target: string): boolean =>
  root === "/" || target === root || target.startsWith(`${root}/`);

/**
 * Every path the caller supplies must already be clean, and the agent roots must be listed:
 * a guard that tidies or skips an input it cannot judge would pass a file it never checked.
 */
function uncleanInput(filePath: string, ctx: OwnerFileContext): SeatRefusal | undefined {
  const inputs: [string, string][] = [
    ["file path", filePath],
    ["seats dir", ctx.seatsDir],
    ...ctx.agentWritableRoots.map((root): [string, string] => ["agent-writable root", root]),
  ];
  const unclean = inputs.find(([, value]) => !isCleanAbsolutePath(value));
  if (unclean !== undefined) {
    return { code: "unclean_path", detail: `${unclean[0]} "${unclean[1]}" is not a clean absolute path` };
  }
  if (ctx.agentWritableRoots.length === 0) {
    return { code: "agent_writable_path", detail: "no agent-writable roots given, so overlap cannot be checked" };
  }
  return undefined;
}

function unsafeDir(ctx: OwnerFileContext): SeatRefusal | undefined {
  const dir = ctx.seatsDirFacts;
  if (dir.isSymbolicLink() || !dir.isDirectory()) {
    return { code: "seats_dir_unsafe", detail: `${ctx.seatsDir} is not a real directory` };
  }
  const owner = unsafeOwner(dir, ctx.ownerUid);
  if (owner !== undefined) return { code: "seats_dir_unsafe", detail: owner.detail };
  const writable = ctx.agentWritableRoots.find((root) => isWithin(root, ctx.seatsDir) || isWithin(ctx.seatsDir, root));
  if (writable !== undefined) return { code: "agent_writable_path", detail: `${ctx.seatsDir} overlaps ${writable}` };
  return undefined;
}

/**
 * The seat-policy fail-closed rules for an owner-held file: a regular file, not a symlink, owned
 * by the owner, not group- or world-writable, directly inside a safe seats directory that no agent
 * root overlaps. `filePath`, `seatsDir` and every agent root must already be clean absolute paths
 * (no empty, `.` or `..` segment, no trailing slash); anything else is refused, never normalized.
 */
export function checkOwnerFile(filePath: string, facts: FileFacts, ctx: OwnerFileContext): SeatRefusal | undefined {
  const dirRefusal = uncleanInput(filePath, ctx) ?? unsafeDir(ctx);
  if (dirRefusal !== undefined) return dirRefusal;
  if (path.posix.dirname(filePath) !== ctx.seatsDir) {
    return { code: "outside_seats_dir", detail: `${filePath} is not directly inside ${ctx.seatsDir}` };
  }
  if (facts.isSymbolicLink()) return { code: "symlink", detail: `${filePath} is a symlink` };
  if (!facts.isFile()) return { code: "not_regular_file", detail: `${filePath} is not a regular file` };
  return unsafeOwner(facts, ctx.ownerUid);
}
