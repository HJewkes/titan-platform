import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";

/** A pending request lives this long; the owner approves inside it or the agent asks again. */
export const REQUEST_TTL_S = 600;
/** The most requests pending at once; the oldest is evicted, so a looping agent cannot fill the disk. */
export const MAX_PENDING = 50;
/** A spent nonce outlives its request by far; after this its ledger entry is pruned. */
export const SPENT_TTL_S = 86_400;

const ID_RE = /^[0-9a-f]{12}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const READ_CAP = 256 * 1024;

/** What the hook knows about the denied action when it asks the owner. */
export interface RequestFields {
  digest: string;
  session: string | null;
  aud: string;
  tool: string;
  action: string;
  rule: string | null;
  cwd: string;
  toolInput: unknown;
}

const RequestSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(ID_RE),
  nonce: z.string().regex(NONCE_RE),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  session: z.string().nullable(),
  aud: z.string().min(1),
  tool: z.string().min(1),
  action: z.string().min(1),
  rule: z.string().nullable(),
  cwd: z.string(),
  toolInput: z.unknown(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

export type ApprovalRequest = z.infer<typeof RequestSchema>;

/** A pending request and the owner's approval for it, still unverified, if one was written. */
export interface Pending {
  request: ApprovalRequest;
  approval: string | null;
}

/**
 * Pending requests, approval files and the spent-nonce ledger. `now` is unix seconds. The store trusts nothing it
 * reads: an approval is opaque text the caller must verify, and a request file that fails its schema is ignored.
 */
export interface ApprovalStore {
  issue(fields: RequestFields, now: number): ApprovalRequest;
  get(id: string, now: number): ApprovalRequest | null;
  list(now: number): ApprovalRequest[];
  /** The live requests for this exact action, each with its approval text if the owner has written one. */
  find(digest: string, now: number): Pending[];
  /** Writes the approval for a pending request once; a second write for the same id throws EEXIST. */
  accept(id: string, approval: string, now: number): void;
  /** Claims the nonce in the ledger, then removes the approval and request. False when it was already spent. */
  spend(id: string, nonce: string, now: number): boolean;
  isSpent(nonce: string): boolean;
  prune(now: number): void;
}

/**
 * The store directory comes from the passwd entry, never `$HOME` or `$XDG_STATE_HOME`: an agent can set those for a
 * child it starts, and the hook must read the same store the owner's `approve` writes.
 */
export function approvalsDir(passwdHome: string): string {
  return path.join(passwdHome, ".local", "state", "titan-tool-guard", "approvals");
}

export function passwdHome(): string {
  return os.userInfo().homedir;
}

interface StorePaths {
  root: string;
  requests: string;
  granted: string;
  spent: string;
}

function storePaths(home: string): StorePaths {
  const root = approvalsDir(home);
  return { root, requests: path.join(root, "requests"), granted: path.join(root, "granted"), spent: path.join(root, "spent") };
}

const requestFile = (p: StorePaths, id: string) => path.join(p.requests, `${checked(id, ID_RE, "id")}.json`);
const grantFile = (p: StorePaths, id: string) => path.join(p.granted, `${checked(id, ID_RE, "id")}.json`);
const spentFile = (p: StorePaths, nonce: string) => path.join(p.spent, `${checked(nonce, NONCE_RE, "nonce")}.json`);

function ready(p: StorePaths): void {
  for (const dir of [p.root, p.requests, p.granted, p.spent]) ensurePrivateDir(dir);
}

function liveRequests(p: StorePaths, now: number): ApprovalRequest[] {
  ready(p);
  return readRequests(p.requests)
    .filter((request) => request.expiresAt > now)
    .sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));
}

/** Drops expired requests, evicts the oldest so one more fits under the cap, and ages out old ledger entries. */
function pruneStore(p: StorePaths, now: number): void {
  ready(p);
  const all = readRequests(p.requests);
  const kept = all.filter((request) => request.expiresAt > now).sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id));
  const evicted = kept.slice(0, Math.max(0, kept.length - (MAX_PENDING - 1)));
  const expired = all.filter((request) => request.expiresAt <= now);
  for (const request of [...expired, ...evicted]) drop(requestFile(p, request.id), grantFile(p, request.id));
  pruneSpent(p.spent, now);
}

function issueRequest(p: StorePaths, fields: RequestFields, now: number): ApprovalRequest {
  pruneStore(p, now);
  const request = RequestSchema.parse({ v: 1, id: hex(6), nonce: hex(16), ...fields, issuedAt: now, expiresAt: now + REQUEST_TTL_S });
  writeExclusive(requestFile(p, request.id), JSON.stringify(request));
  return request;
}

function getRequest(p: StorePaths, id: string, now: number): ApprovalRequest | null {
  ready(p);
  const request = parseRequest(readNoFollow(requestFile(p, id)));
  return request && request.id === id && request.expiresAt > now ? request : null;
}

/** The O_EXCL ledger claim is the atomic step: of two hooks redeeming one nonce, only one creates the file. */
function spendNonce(p: StorePaths, id: string, nonce: string, now: number): boolean {
  ready(p);
  const approval = readNoFollow(grantFile(p, id));
  try {
    writeExclusive(spentFile(p, nonce), JSON.stringify({ id, nonce, spentAt: now, approval }));
  } catch (err) {
    if (errCode(err) === "EEXIST") return false;
    throw err;
  }
  drop(grantFile(p, id), requestFile(p, id));
  return true;
}

export function nodeApprovalStore(home: string): ApprovalStore {
  const p = storePaths(home);
  return {
    issue: (fields, now) => issueRequest(p, fields, now),
    get: (id, now) => getRequest(p, id, now),
    list: (now) => liveRequests(p, now),
    find: (digest, now) =>
      liveRequests(p, now)
        .filter((request) => request.digest === digest)
        .map((request) => ({ request, approval: readNoFollow(grantFile(p, request.id)) })),
    accept: (id, approval, now) => {
      if (!getRequest(p, id, now)) throw new Error(`no pending request ${id}`);
      writeExclusive(grantFile(p, id), approval);
    },
    spend: (id, nonce, now) => spendNonce(p, id, nonce, now),
    isSpent: (nonce) => {
      ready(p);
      return fs.lstatSync(spentFile(p, nonce), { throwIfNoEntry: false }) !== undefined;
    },
    prune: (now) => pruneStore(p, now),
  };
}

/** Creates the directory 0700, or refuses one that is a symlink, someone else's, or open to group or other. */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) throw new Error(`approval store ${dir} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`approval store ${dir} is not owned by this user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`approval store ${dir} is open to group or other`);
}

function writeExclusive(file: string, text: string): void {
  const fd = fs.openSync(file, CREATE_FLAGS, FILE_MODE);
  try {
    fs.writeFileSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/** The file's text, or null when it is absent. A symlink in its place throws (ELOOP), and so does anything not a file. */
function readNoFollow(file: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`approval store ${file} is not a file`);
    const buf = Buffer.alloc(READ_CAP);
    return buf.subarray(0, fs.readSync(fd, buf, 0, READ_CAP, 0)).toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

function readRequests(dir: string): ApprovalRequest[] {
  const out: ApprovalRequest[] = [];
  for (const name of fs.readdirSync(dir)) {
    const id = name.replace(/\.json$/, "");
    if (!ID_RE.test(id) || name !== `${id}.json`) continue;
    const request = parseRequest(attemptRead(path.join(dir, name)));
    if (request && request.id === id) out.push(request);
  }
  return out;
}

function parseRequest(text: string | null): ApprovalRequest | null {
  if (text === null) return null;
  try {
    const parsed = RequestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A planted symlink among the requests is skipped, never followed. */
function attemptRead(file: string): string | null {
  try {
    return readNoFollow(file);
  } catch {
    return null;
  }
}

function pruneSpent(dir: string, now: number): void {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const st = fs.lstatSync(file, { throwIfNoEntry: false });
    if (st && st.mtimeMs / 1000 + SPENT_TTL_S <= now) fs.rmSync(file, { force: true });
  }
}

function drop(...files: string[]): void {
  for (const file of files) fs.rmSync(file, { force: true });
}

function checked(value: string, re: RegExp, what: string): string {
  if (!re.test(value)) throw new Error(`approval store: bad ${what}`);
  return value;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function errCode(err: unknown): string | undefined {
  return isErrno(err) ? err.code : undefined;
}
