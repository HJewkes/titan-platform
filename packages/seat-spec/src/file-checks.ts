import path from "node:path";
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
  /** Absolute roots an agent can write (worktrees, agent scratch); none may contain the seats directory. */
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

const clean = (value: string): string => path.posix.normalize(value).replace(/(.)\/+$/, "$1");

const isWithin = (root: string, target: string): boolean => {
  const rel = path.posix.relative(clean(root), clean(target));
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !path.posix.isAbsolute(rel));
};

function unsafeDir(ctx: OwnerFileContext): SeatRefusal | undefined {
  const dir = ctx.seatsDirFacts;
  if (!path.posix.isAbsolute(ctx.seatsDir) || dir.isSymbolicLink() || !dir.isDirectory()) {
    return { code: "seats_dir_unsafe", detail: `${ctx.seatsDir} is not a real absolute directory` };
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
 * root overlaps. `filePath` is the absolute path the reader opened.
 */
export function checkOwnerFile(filePath: string, facts: FileFacts, ctx: OwnerFileContext): SeatRefusal | undefined {
  const dirRefusal = unsafeDir(ctx);
  if (dirRefusal !== undefined) return dirRefusal;
  if (!path.posix.isAbsolute(filePath) || path.posix.dirname(clean(filePath)) !== clean(ctx.seatsDir)) {
    return { code: "outside_seats_dir", detail: `${filePath} is not directly inside ${ctx.seatsDir}` };
  }
  if (facts.isSymbolicLink()) return { code: "symlink", detail: `${filePath} is a symlink` };
  if (!facts.isFile()) return { code: "not_regular_file", detail: `${filePath} is not a regular file` };
  return unsafeOwner(facts, ctx.ownerUid);
}
