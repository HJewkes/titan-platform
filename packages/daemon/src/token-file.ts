/**
 * The secret file behind `auth.ts`: created once with O_EXCL at 0600, refused whenever it
 * cannot be trusted, re-read when it changes, and rotated by an atomic rename.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { errorCode } from "@titan-design/rpc-protocol/narrow";

const SECRET_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type TokenFileProblem = "symlink" | "not-regular" | "owner" | "mode" | "empty" | "short" | "malformed";

/** The token file exists but cannot be trusted. The message never contains the secret. */
export class TokenFileError extends Error {
  constructor(
    readonly problem: TokenFileProblem,
    file: string,
    detail: string,
  ) {
    super(`Token file ${file} refused: ${detail}`);
    this.name = "TokenFileError";
  }
}

/**
 * Create the token file if it is missing (mode 0600, O_EXCL, so a file or symlink planted
 * first is never written through), then read it back under the same checks as a reload.
 */
export function ensureTokenFile(file: string): string {
  try {
    return writeNewSecret(file);
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  }
  return readSecretFile(file, parseBase64Secret).secret;
}

/** Replace the secret by writing a 0600 temp file and renaming it over the old one. */
export function rotateTokenFile(file: string): string {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const secret = writeNewSecret(temp);
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
  return secret;
}

/**
 * Read the file now, throwing {@link TokenFileError} if it cannot be trusted, and return a
 * reader that re-reads and re-checks it whenever its inode, size, times, mode or owner change.
 */
export function trackTokenFile(file: string): () => string {
  return trackSecretFile(file, parseBase64Secret);
}

/**
 * The same tracked read for any secret shape. `parse` gets the file text and returns the
 * secret or throws; a {@link SecretRejection} picks the problem, any other throw becomes
 * "malformed". The thrown text is dropped, so a parser cannot leak the value into an error.
 * The caller supplies the path: nothing here knows where a given secret lives.
 */
export function trackSecretFile(file: string, parse: SecretParser): () => string {
  let snapshot = readSecretFile(file, parse);
  return () => {
    const changed = statIdentity(fs.lstatSync(file, { bigint: true })) !== snapshot.identity;
    if (changed || snapshot.racy) snapshot = readSecretFile(file, parse);
    return snapshot.secret;
  };
}

export type SecretParser = (raw: string) => string;

/** A parser's refusal with a stated problem; `detail` must never quote the file's text. */
export class SecretRejection extends Error {
  constructor(
    readonly problem: TokenFileProblem,
    detail: string,
  ) {
    super(detail);
    this.name = "SecretRejection";
  }
}

function writeNewSecret(file: string): string {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeSync(fd, secret);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  return secret;
}

interface TokenSnapshot {
  secret: string;
  identity: string;
  /** Written too recently to trust its identity; see {@link isRacy}. */
  racy: boolean;
}

function readSecretFile(file: string, parse: SecretParser): TokenSnapshot {
  if (fs.lstatSync(file).isSymbolicLink()) throw new TokenFileError("symlink", file, "it is a symbolic link");
  const fd = openNoFollow(file);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    checkTokenStat(file, stat);
    const secret = runParser(file, parse, fs.readFileSync(fd, "utf8"));
    return { secret, identity: statIdentity(stat), racy: isRacy(stat) };
  } finally {
    fs.closeSync(fd);
  }
}

/** O_NOFOLLOW closes the race with the lstat above; O_NONBLOCK keeps a FIFO from hanging. */
function openNoFollow(file: string): number {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  try {
    return fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (err) {
    if (errorCode(err) === "ELOOP") throw new TokenFileError("symlink", file, "it is a symbolic link");
    throw err;
  }
}

function checkTokenStat(file: string, stat: fs.BigIntStats): void {
  if (!stat.isFile()) throw new TokenFileError("not-regular", file, "it is not a regular file");
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== BigInt(uid)) {
    throw new TokenFileError("owner", file, `it is owned by uid ${stat.uid}, not ${uid}`);
  }
  const mode = Number(stat.mode & 0o777n);
  if ((mode & 0o077) !== 0) {
    throw new TokenFileError("mode", file, `mode ${mode.toString(8).padStart(4, "0")} is readable by group or others; chmod 600 it`);
  }
}

function runParser(file: string, parse: SecretParser, raw: string): string {
  try {
    return parse(raw);
  } catch (err) {
    if (err instanceof SecretRejection) throw new TokenFileError(err.problem, file, err.message);
    throw new TokenFileError("malformed", file, "it does not have the expected shape");
  }
}

/** The daemon's own secrets: at least 32 random bytes, base64url, one optional trailing newline. */
export function parseBase64Secret(raw: string): string {
  const secret = raw.replace(/\r?\n$/, "");
  if (secret === "") throw new SecretRejection("empty", "it is empty");
  if (!BASE64URL.test(secret)) throw new SecretRejection("malformed", "it is not base64url");
  if (Buffer.from(secret, "base64url").length < SECRET_BYTES) {
    throw new SecretRejection("short", `it holds fewer than ${SECRET_BYTES} bytes`);
  }
  return secret;
}

/** Inode first: a rename-based rotation can keep the size and even the mtime. */
function statIdentity(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].join(":");
}

const RACY_WINDOW_NS = 2_000_000_000n;

/**
 * Filesystem timestamps tick coarsely (a jiffy on Linux), so a same-size rewrite in place
 * just after a read can leave the identity unchanged. Like git's racy-index rule, a file
 * written within the window is re-read on every call until it settles. Wall time comes from
 * `performance` rather than `Date`, so it tracks the filesystem clock even under a fake Date.
 */
function isRacy(stat: fs.BigIntStats): boolean {
  const nowNs = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  return nowNs - stat.mtimeNs < RACY_WINDOW_NS;
}
