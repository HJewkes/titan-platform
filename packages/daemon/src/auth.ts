/**
 * Authentication for a daemon reached from beyond loopback.
 *
 * - A 32-byte secret lives in a token file. It is never an HMAC key itself: HKDF derives
 *   separate cookie, login-code and bearer keys from it, so a leaked MAC never helps with
 *   another credential.
 * - A login code is minted offline by anyone who can read the file, works once, lives ten
 *   minutes, and is refused if it was minted before this process started. The used set is
 *   in memory, so without that rule a restart would revive every code it had seen.
 * - A browser trades the code for a stateless session cookie in two steps. `GET` only
 *   renders an inert page, because link previewers fetch URLs and would burn the code, and a
 *   redirect that began cross-site may not carry a SameSite=Strict cookie. The page's script
 *   then makes a same-origin JSON `POST`, which consumes the code and sets the cookie.
 * - A non-browser client sends `Authorization: Bearer <secret>`.
 * - Rewriting the file, in place or by rename, ends every session and voids every code.
 *
 * Every comparison runs through {@link safeEqual}: both sides are HMAC'd to an equal length
 * first, because `timingSafeEqual` throws on unequal lengths and that throw is a length oracle.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { EXIT, errorEnvelope } from "@titan-design/registry";

export const SESSION_COOKIE = "titan_session";
export const LOGIN_PATH = "/auth/login";
export const LOGOUT_PATH = "/auth/logout";
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const SECRET_BYTES = 32;
const HKDF_SALT = "titan-design/daemon auth v1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SESSION_PATTERN = /^v1\.(0|[1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/;
const CODE_PATTERN = /^v1\.(0|[1-9]\d{0,15})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

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

// ---------------------------------------------------------------------------------------
// Token file

/**
 * Create the token file if it is missing (mode 0600, O_EXCL, so a file or symlink planted
 * first is never written through), then read it back under the same checks as a reload.
 */
export function ensureTokenFile(file: string): string {
  try {
    return writeNewSecret(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return readTokenFile(file).secret;
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

function readTokenFile(file: string): TokenSnapshot {
  if (fs.lstatSync(file).isSymbolicLink()) throw new TokenFileError("symlink", file, "it is a symbolic link");
  const fd = openNoFollow(file);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    checkTokenStat(file, stat);
    const secret = parseSecret(file, fs.readFileSync(fd, "utf8"));
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
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new TokenFileError("symlink", file, "it is a symbolic link");
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

function parseSecret(file: string, raw: string): string {
  const secret = raw.replace(/\r?\n$/, "");
  if (secret === "") throw new TokenFileError("empty", file, "it is empty");
  if (!BASE64URL.test(secret)) throw new TokenFileError("malformed", file, "it is not base64url");
  if (Buffer.from(secret, "base64url").length < SECRET_BYTES) {
    throw new TokenFileError("short", file, `it holds fewer than ${SECRET_BYTES} bytes`);
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

// ---------------------------------------------------------------------------------------
// Keys and comparison

type KeyPurpose = "cookie" | "code" | "bearer";

function deriveKey(secret: string, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), HKDF_SALT, purpose, 32));
}

function mac(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

const COMPARE_KEY = randomBytes(32);

function safeEqual(a: string, b: string, key: Buffer = COMPARE_KEY): boolean {
  const digest = (value: string) => createHmac("sha256", key).update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Not a millisecond timestamp: ${value}`);
}

// ---------------------------------------------------------------------------------------
// Sessions

/** `v1.<issuedAt>.<HMAC(cookieKey, "v1.<issuedAt>")>`; stateless, so it survives restarts. */
export function signSession(secret: string, issuedAt: number = Date.now()): string {
  assertTimestamp(issuedAt);
  const payload = `v1.${issuedAt}`;
  return `${payload}.${mac(deriveKey(secret, "cookie"), payload)}`;
}

/** The session's issue time, or null when it is malformed, forged, from the future, or 30 days old. */
export function verifySession(secret: string, value: string, now: number = Date.now()): { issuedAt: number } | null {
  const match = SESSION_PATTERN.exec(value);
  if (!match) return null;
  const issuedAt = Number(match[1]);
  if (!safeEqual(match[2]!, mac(deriveKey(secret, "cookie"), `v1.${issuedAt}`))) return null;
  if (issuedAt > now || now - issuedAt >= SESSION_MAX_AGE_MS) return null;
  return { issuedAt };
}

// ---------------------------------------------------------------------------------------
// Login codes

/** `v1.<issuedAt>.<nonce>.<HMAC(codeKey, ...)>`. Minting needs only the secret, not the daemon. */
export function mintLoginCode(secret: string, now: number = Date.now()): string {
  assertTimestamp(now);
  const payload = `v1.${now}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${mac(deriveKey(secret, "code"), payload)}`;
}

/** The per-process memory of spent codes, and the start time that bounds which codes count. */
export interface LoginCodeLedger {
  readonly startedAt: number;
  readonly used: Set<string>;
}

export function createLoginCodeLedger(startedAt: number = Date.now()): LoginCodeLedger {
  return { startedAt, used: new Set() };
}

/**
 * Synchronous on purpose: the used-set check and the mark have no await between them, so two
 * concurrent requests carrying one code cannot both pass. Entries are never pruned; only a
 * correctly signed code is ever added, so the set grows by one per real login.
 */
export function consumeLoginCode(ledger: LoginCodeLedger, secret: string, code: string, now: number = Date.now()): boolean {
  const match = CODE_PATTERN.exec(code);
  if (!match) return false;
  const issuedAt = Number(match[1]);
  const payload = `v1.${issuedAt}.${match[2]}`;
  if (!safeEqual(match[3]!, mac(deriveKey(secret, "code"), payload))) return false;
  if (issuedAt < ledger.startedAt || issuedAt > now || now - issuedAt >= LOGIN_CODE_TTL_MS) return false;
  if (ledger.used.has(payload)) return false;
  ledger.used.add(payload);
  return true;
}

// ---------------------------------------------------------------------------------------
// The hono surface

export interface DaemonAuthOptions {
  /** The token file. It must already exist; see {@link ensureTokenFile}. */
  tokenFile: string;
  /** Codes minted before this are refused. Defaults to now. */
  startedAt?: number;
}

export interface DaemonAuth {
  /** The current secret, re-read when the file's inode, size, times, mode or owner change. */
  secret(): string;
  readonly ledger: LoginCodeLedger;
}

/** Throws {@link TokenFileError} now, so a daemon with an untrustworthy file never starts. */
export function createDaemonAuth(options: DaemonAuthOptions): DaemonAuth {
  const file = options.tokenFile;
  let snapshot = readTokenFile(file);
  return {
    ledger: createLoginCodeLedger(options.startedAt),
    secret() {
      const changed = statIdentity(fs.lstatSync(file, { bigint: true })) !== snapshot.identity;
      if (changed || snapshot.racy) snapshot = readTokenFile(file);
      return snapshot.secret;
    },
  };
}

/** How the request authenticated; `issuedAt` is the session's, null for a bearer. */
export interface RequestAuth {
  credential: "session" | "bearer";
  issuedAt: number | null;
}

const requestAuth = new WeakMap<Request, RequestAuth>();

/** What {@link authGate} recorded for this request, or undefined if no gate ran. */
export function getRequestAuth(request: Request): RequestAuth | undefined {
  return requestAuth.get(request);
}

/**
 * Pass a valid session cookie or bearer, answer 401 otherwise. Only {@link LOGIN_PATH} is
 * open. Mount it after the Host/Origin guard, so `/auth/*` stays behind the Host check.
 */
export function authGate(auth: DaemonAuth): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === LOGIN_PATH) return next();
    const secret = currentSecret(auth);
    if (secret === null) return unavailable(c);
    const facts = authenticate(c, secret, Date.now());
    if (!facts) return unauthorized(c);
    requestAuth.set(c.req.raw, facts);
    await next();
  };
}

function authenticate(c: Context, secret: string, now: number): RequestAuth | null {
  const bearer = /^Bearer +(\S+) *$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (bearer !== undefined && safeEqual(bearer, secret, deriveKey(secret, "bearer"))) {
    return { credential: "bearer", issuedAt: null };
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  const session = cookie === undefined ? null : verifySession(secret, cookie, now);
  return session ? { credential: "session", issuedAt: session.issuedAt } : null;
}

/** Fail closed: a vanished or loosened token file authenticates no one. */
function currentSecret(auth: DaemonAuth): string | null {
  try {
    return auth.secret();
  } catch {
    return null;
  }
}

function unavailable(c: Context): Response {
  c.header("Cache-Control", "no-store");
  return c.json(errorEnvelope("Authentication is unavailable", EXIT.CONFIG), 503);
}

function unauthorized(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer realm="daemon"');
  c.header("Cache-Control", "no-store");
  if (c.req.method === "GET" && (c.req.header("accept") ?? "").includes("text/html")) {
    return c.html(UNAUTHORIZED_PAGE, 401);
  }
  return c.json(errorEnvelope("Authentication required", EXIT.USAGE), 401);
}

const COOKIE_OPTIONS = { httpOnly: true, sameSite: "Strict", path: "/" } as const;

/** `GET` and `POST` {@link LOGIN_PATH} and `POST` {@link LOGOUT_PATH}. */
export function mountAuthRoutes(app: Hono, auth: DaemonAuth): void {
  app.get(LOGIN_PATH, loginPage);
  app.post(LOGIN_PATH, (c) => login(c, auth));
  app.post(LOGOUT_PATH, (c) => {
    deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });
}

async function login(c: Context, auth: DaemonAuth): Promise<Response> {
  const code = await readLoginCode(c);
  const secret = currentSecret(auth);
  if (secret === null) return unavailable(c);
  const now = Date.now();
  c.header("Cache-Control", "no-store");
  if (code === null || !consumeLoginCode(auth.ledger, secret, code, now)) {
    return c.json(errorEnvelope("Login code is invalid, expired, or already used", EXIT.USAGE), 401);
  }
  setCookie(c, SESSION_COOKIE, signSession(secret, now), { ...COOKIE_OPTIONS, maxAge: SESSION_MAX_AGE_MS / 1000 });
  return c.json({ ok: true });
}

async function readLoginCode(c: Context): Promise<string | null> {
  try {
    const body: unknown = await c.req.json();
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

/** Inert: it never reads the code server-side, never reflects it, and leaks no Referer. */
function loginPage(c: Context): Response {
  const nonce = randomBytes(16).toString("base64");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  );
  return c.html(loginPageHtml(nonce));
}

function loginPageHtml(nonce: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 28rem; padding: 0 1rem">
<h1>Sign in</h1>
<p>This one-time link signs this browser in.</p>
<button id="go" type="button">Sign in</button>
<p id="status" role="status"></p>
<script nonce="${nonce}">
document.getElementById("go").addEventListener("click", async () => {
  const status = document.getElementById("status");
  const code = new URLSearchParams(location.search).get("code") || "";
  const res = await fetch(${JSON.stringify(LOGIN_PATH)}, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  if (res.ok) location.replace("/");
  else status.textContent = "This link is invalid, expired, or already used. Ask for a fresh one.";
});
</script>
</body></html>`;
}

const UNAUTHORIZED_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not signed in</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 28rem; padding: 0 1rem">
<h1>Not signed in</h1>
<p>Open a fresh login link, then <a href="">reload this page</a>.</p>
</body></html>`;
