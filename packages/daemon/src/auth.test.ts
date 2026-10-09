import { createHmac } from "node:crypto";
import fs from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOGIN_CODE_TTL_MS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  TokenFileError,
  authGate,
  consumeLoginCode,
  createDaemonAuth,
  createLoginCodeLedger,
  ensureTokenFile,
  mintLoginCode,
  mountLogoutRoute,
  rotateTokenFile,
  signSession,
  verifySession,
  type DaemonAuth,
  type TokenFileProblem,
} from "./auth.js";
import { buildHttpApp } from "./http.js";
import type { Surface } from "./surface.js";
import { createTestContext, createTestRegistry } from "./test-fixtures.js";

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const MINUTE = 60_000;

let dir: string;
let tokenFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(tmpdir(), "daemon-auth-"));
  tokenFile = path.join(dir, "lan.token");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeToken(content: string, mode = 0o600, file = tokenFile): void {
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

function problemOf(fn: () => unknown): TokenFileProblem | "none" {
  try {
    fn();
  } catch (err) {
    if (err instanceof TokenFileError) return err.problem;
    throw err;
  }
  return "none";
}

const VALID_SECRET = Buffer.alloc(32, 7).toString("base64url");

describe("ensureTokenFile", () => {
  it("creates a 32-byte base64url secret readable only by the owner", () => {
    const secret = ensureTokenFile(tokenFile);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe(secret);
  });

  it("returns the existing secret on a second call without rewriting it", () => {
    const first = ensureTokenFile(tokenFile);
    const inode = fs.statSync(tokenFile).ino;

    expect(ensureTokenFile(tokenFile)).toBe(first);
    expect(fs.statSync(tokenFile).ino).toBe(inode);
  });

  it.each([0o644, 0o640, 0o604, 0o660])("refuses an existing file at mode %o", (mode) => {
    writeToken(VALID_SECRET, mode);
    expect(problemOf(() => ensureTokenFile(tokenFile))).toBe("mode");
  });

  it("accepts an owner-only read-only file and a trailing newline", () => {
    writeToken(`${VALID_SECRET}\n`, 0o400);
    expect(ensureTokenFile(tokenFile)).toBe(VALID_SECRET);
  });

  it.each([
    ["an empty file", "", "empty"],
    ["a lone newline", "\n", "empty"],
    ["a 31-byte secret", Buffer.alloc(31, 1).toString("base64url"), "short"],
    ["a short word", "abc", "short"],
    ["whitespace", "   ", "malformed"],
    ["padded base64", `${Buffer.alloc(32, 1).toString("base64")}`, "malformed"],
    ["two lines", `${VALID_SECRET}\n${VALID_SECRET}`, "malformed"],
  ])("refuses %s", (_label, content, problem) => {
    writeToken(content);
    expect(problemOf(() => ensureTokenFile(tokenFile))).toBe(problem);
  });

  it("refuses a symlink to a valid token file", () => {
    const real = path.join(dir, "real.token");
    writeToken(VALID_SECRET, 0o600, real);
    fs.symlinkSync(real, tokenFile);

    expect(problemOf(() => ensureTokenFile(tokenFile))).toBe("symlink");
  });

  it("refuses a dangling symlink and does not create its target", () => {
    const target = path.join(dir, "planted");
    fs.symlinkSync(target, tokenFile);

    expect(problemOf(() => ensureTokenFile(tokenFile))).toBe("symlink");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses a directory", () => {
    fs.mkdirSync(tokenFile, { mode: 0o700 });
    expect(problemOf(() => ensureTokenFile(tokenFile))).toBe("not-regular");
  });

  const rootOwned = "/etc/passwd";
  const canTestOwner = process.getuid?.() !== 0 && fs.existsSync(rootOwned) && fs.statSync(rootOwned).uid === 0;
  it.skipIf(!canTestOwner)("refuses a file another user owns before looking at its mode", () => {
    expect(problemOf(() => createDaemonAuth({ tokenFile: rootOwned }))).toBe("owner");
  });
});

describe("rotateTokenFile", () => {
  it("renames a fresh 0600 file into place and leaves no temp file behind", () => {
    const old = ensureTokenFile(tokenFile);
    const oldInode = fs.statSync(tokenFile).ino;

    const next = rotateTokenFile(tokenFile);

    expect(next).not.toBe(old);
    expect(fs.readFileSync(tokenFile, "utf8")).toBe(next);
    expect(fs.statSync(tokenFile).ino).not.toBe(oldInode);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["lan.token"]);
  });
});

describe("signSession / verifySession", () => {
  it("verifies its own session and reports the issue time", () => {
    expect(verifySession(VALID_SECRET, signSession(VALID_SECRET, T0), T0 + MINUTE)).toEqual({ issuedAt: T0 });
  });

  it("refuses a session signed under another secret", () => {
    const other = Buffer.alloc(32, 9).toString("base64url");
    expect(verifySession(VALID_SECRET, signSession(other, T0), T0)).toBeNull();
  });

  it("refuses a session issued in the future", () => {
    expect(verifySession(VALID_SECRET, signSession(VALID_SECRET, T0 + 1), T0)).toBeNull();
  });

  it("expires a session at 30 days", () => {
    const session = signSession(VALID_SECRET, T0);
    expect(verifySession(VALID_SECRET, session, T0 + SESSION_MAX_AGE_MS - 1)).not.toBeNull();
    expect(verifySession(VALID_SECRET, session, T0 + SESSION_MAX_AGE_MS)).toBeNull();
  });

  it("refuses a MAC keyed with the raw secret, so the bearer is not the cookie key", () => {
    const payload = `v1.${T0}`;
    const rawKeyed = createHmac("sha256", Buffer.from(VALID_SECRET, "base64url")).update(payload).digest("base64url");
    const stringKeyed = createHmac("sha256", VALID_SECRET).update(payload).digest("base64url");

    expect(verifySession(VALID_SECRET, `${payload}.${rawKeyed}`, T0)).toBeNull();
    expect(verifySession(VALID_SECRET, `${payload}.${stringKeyed}`, T0)).toBeNull();
  });

  it("refuses malformed and malleated values", () => {
    const [, , macPart] = signSession(VALID_SECRET, T0).split(".");
    const flipped = `${macPart!.slice(0, -1)}${macPart!.endsWith("A") ? "B" : "A"}`;
    for (const value of [
      "",
      `v1.${T0}`,
      `v2.${T0}.${macPart}`,
      `v1.0${T0}.${macPart}`,
      `v1.${T0}.${macPart}.extra`,
      `v1.${T0}.${macPart}=`,
      `v1.${T0}.${flipped}`,
      `v1.${T0}.${macPart!.slice(1)}`,
      `v1.-${T0}.${macPart}`,
    ]) {
      expect(verifySession(VALID_SECRET, value, T0), value).toBeNull();
    }
  });

  it("refuses to sign a non-integer timestamp", () => {
    expect(() => signSession(VALID_SECRET, 1.5)).toThrow(RangeError);
    expect(() => signSession(VALID_SECRET, -1)).toThrow(RangeError);
  });
});

describe("mintLoginCode / consumeLoginCode", () => {
  it("accepts a code once and refuses its replay", () => {
    const ledger = createLoginCodeLedger(T0);
    const code = mintLoginCode(VALID_SECRET, T0);

    expect(consumeLoginCode(ledger, VALID_SECRET, code, T0 + MINUTE)).toBe(true);
    expect(consumeLoginCode(ledger, VALID_SECRET, code, T0 + MINUTE)).toBe(false);
  });

  it("expires a code at ten minutes", () => {
    const code = mintLoginCode(VALID_SECRET, T0);
    expect(consumeLoginCode(createLoginCodeLedger(T0), VALID_SECRET, code, T0 + LOGIN_CODE_TTL_MS - 1)).toBe(true);
    expect(consumeLoginCode(createLoginCodeLedger(T0), VALID_SECRET, code, T0 + LOGIN_CODE_TTL_MS)).toBe(false);
  });

  it("refuses a code minted before this process started, so a restart cannot revive a spent one", () => {
    const code = mintLoginCode(VALID_SECRET, T0);
    expect(consumeLoginCode(createLoginCodeLedger(T0), VALID_SECRET, code, T0)).toBe(true);

    const restarted = createLoginCodeLedger(T0 + 1);
    expect(consumeLoginCode(restarted, VALID_SECRET, code, T0 + MINUTE)).toBe(false);
  });

  it("refuses a code issued in the future", () => {
    const code = mintLoginCode(VALID_SECRET, T0 + MINUTE);
    expect(consumeLoginCode(createLoginCodeLedger(T0), VALID_SECRET, code, T0)).toBe(false);
  });

  it("refuses a code from another secret, a tampered code and a session value", () => {
    const ledger = createLoginCodeLedger(T0);
    const other = Buffer.alloc(32, 9).toString("base64url");
    const code = mintLoginCode(VALID_SECRET, T0);
    const tampered = code.replace(/\.(.)/, (_m, c: string) => `.${c === "a" ? "b" : "a"}`);

    expect(consumeLoginCode(ledger, VALID_SECRET, mintLoginCode(other, T0), T0)).toBe(false);
    expect(consumeLoginCode(ledger, VALID_SECRET, tampered, T0)).toBe(false);
    expect(consumeLoginCode(ledger, VALID_SECRET, signSession(VALID_SECRET, T0), T0)).toBe(false);
    expect(consumeLoginCode(ledger, VALID_SECRET, code, T0)).toBe(true);
  });

  it("does not accept a code MAC'd with the cookie key's construction", () => {
    const payload = `v1.${T0}.${"A".repeat(22)}`;
    const rawKeyed = createHmac("sha256", Buffer.from(VALID_SECRET, "base64url")).update(payload).digest("base64url");
    expect(consumeLoginCode(createLoginCodeLedger(T0), VALID_SECRET, `${payload}.${rawKeyed}`, T0)).toBe(false);
  });
});

function buildGatedApp(auth: DaemonAuth): Hono {
  const app = new Hono();
  app.use("*", authGate(auth));
  mountLogoutRoute(app);
  app.get("/", (c) => c.text("home"));
  app.post("/rpc/thing", (c) => c.json({ ok: true }));
  return app;
}

function buildDaemonApp(auth: DaemonAuth, mountRoutes?: (app: Hono) => void, createContext = createTestContext): Hono {
  return buildHttpApp({ registry: createTestRegistry(), createContext, version: "0.0.0", port: () => 7500, gate: auth, mountRoutes });
}

function setup(startedAt = T0): { app: Hono; auth: DaemonAuth; secret: string } {
  const secret = ensureTokenFile(tokenFile);
  const auth = createDaemonAuth({ tokenFile, startedAt });
  return { app: buildGatedApp(auth), auth, secret };
}

const withCookie = (value: string) => ({ headers: { cookie: `${SESSION_COOKIE}=${value}` } });
const withBearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function postLogin(app: Hono, body: unknown): Promise<Response> {
  return app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function sessionFrom(res: Response): string {
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(res.headers.get("set-cookie") ?? "");
  if (!match) throw new Error("no session cookie set");
  return match[1]!;
}

describe("authGate", () => {
  it("answers 401 JSON without credentials, naming no login tool", async () => {
    const { app } = setup();

    const res = await app.request("/rpc/thing", { method: "POST" });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: "Authentication required" });
    expect(body).not.toMatch(/login-link|titan-console/);
  });

  it("answers a browser's page request with a 401 page that links back to itself", async () => {
    const { app } = setup();

    const res = await app.request("/", { headers: { accept: "text/html,*/*" } });

    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain('<a href="">');
  });

  it("passes the bearer secret, with the scheme in any case", async () => {
    const { app, secret } = setup();
    expect((await app.request("/", withBearer(secret))).status).toBe(200);
    expect((await app.request("/", { headers: { authorization: `bearer ${secret}` } })).status).toBe(200);
  });

  it.each([
    ["a wrong secret of equal length", (s: string) => `${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`],
    ["a prefix of the secret", (s: string) => s.slice(0, 10)],
    ["the secret plus a byte", (s: string) => `${s}x`],
    ["an empty token", () => ""],
  ])("refuses %s as a bearer", async (_label, mutate) => {
    const { app, secret } = setup();
    expect((await app.request("/", withBearer(mutate(secret)))).status).toBe(401);
  });

  it("refuses the secret under another scheme or as a cookie", async () => {
    const { app, secret } = setup();
    expect((await app.request("/", { headers: { authorization: `Basic ${secret}` } })).status).toBe(401);
    expect((await app.request("/", withCookie(secret))).status).toBe(401);
  });

  it("passes a valid session cookie and refuses a tampered one", async () => {
    const { app, secret } = setup();
    const session = signSession(secret, T0);

    expect((await app.request("/", withCookie(session))).status).toBe(200);
    expect((await app.request("/", withCookie(`${session.slice(0, -1)}${session.endsWith("A") ? "B" : "A"}`))).status).toBe(401);
    expect((await app.request("/", withCookie(`${session}A`))).status).toBe(401);
  });

  it("refuses a session cookie once it is 30 days old", async () => {
    const { app, secret } = setup();
    const session = signSession(secret, T0);

    vi.setSystemTime(T0 + SESSION_MAX_AGE_MS);

    expect((await app.request("/", withCookie(session))).status).toBe(401);
  });

  it("refuses old cookies and the old bearer after a rotation, and accepts the new bearer", async () => {
    const { app, secret } = setup();
    const session = signSession(secret, T0);

    const next = rotateTokenFile(tokenFile);

    expect((await app.request("/", withCookie(session))).status).toBe(401);
    expect((await app.request("/", withBearer(secret))).status).toBe(401);
    expect((await app.request("/", withBearer(next))).status).toBe(200);
  });

  it("notices a same-size replacement that keeps the old mtime", async () => {
    const { app, secret } = setup();
    const hourAgo = new Date(Date.now() - 60 * MINUTE);
    fs.utimesSync(tokenFile, hourAgo, hourAgo);
    expect((await app.request("/", withBearer(secret))).status).toBe(200);
    const replacement = path.join(dir, "replacement");
    writeToken(VALID_SECRET, 0o600, replacement);
    fs.utimesSync(replacement, hourAgo, hourAgo);

    fs.renameSync(replacement, tokenFile);

    expect((await app.request("/", withBearer(secret))).status).toBe(401);
    expect((await app.request("/", withBearer(VALID_SECRET))).status).toBe(200);
  });

  it("notices a same-size rewrite in place right after a read", async () => {
    const { app, secret } = setup();
    expect((await app.request("/", withBearer(secret))).status).toBe(200);

    fs.writeFileSync(tokenFile, VALID_SECRET);

    expect((await app.request("/", withBearer(secret))).status).toBe(401);
  });

  it("fails closed when the file is loosened, emptied or removed after start", async () => {
    const { app, secret } = setup();
    expect((await app.request("/", withBearer(secret))).status).toBe(200);

    fs.chmodSync(tokenFile, 0o644);
    expect((await app.request("/", withBearer(secret))).status).toBe(503);

    fs.chmodSync(tokenFile, 0o600);
    expect((await app.request("/", withBearer(secret))).status).toBe(200);

    fs.writeFileSync(tokenFile, "");
    expect((await app.request("/", withBearer(secret))).status).toBe(503);

    fs.rmSync(tokenFile);
    const res = await app.request("/", withBearer(secret));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(secret);
  });

  it("fails closed when the file is swapped for a symlink to a valid secret", async () => {
    const { app } = setup();
    const real = path.join(dir, "real.token");
    writeToken(VALID_SECRET, 0o600, real);

    fs.rmSync(tokenFile);
    fs.symlinkSync(real, tokenFile);

    expect((await app.request("/", withBearer(VALID_SECRET))).status).toBe(503);
  });

  it("refuses to start on a group-readable token file", () => {
    writeToken(VALID_SECRET, 0o644);
    expect(problemOf(() => createDaemonAuth({ tokenFile }))).toBe("mode");
  });

  it("keeps everything but the exact login path behind the gate", async () => {
    const { app } = setup();
    for (const route of ["/auth/login/", "/auth/logout", "/auth/login/x", "/auth"]) {
      expect((await app.request(route, { method: "POST" })).status, route).toBe(401);
    }
  });
});

describe("two-step login", () => {
  it("GET renders an inert, uncached, no-referrer page that neither sets a cookie nor spends the code", async () => {
    const { app, secret } = setup();
    const code = mintLoginCode(secret, T0);

    const page = await app.request(`/auth/login?code=${code}`);

    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(await page.text()).not.toContain(code);
    expect((await postLogin(app, { code })).status).toBe(200);
  });

  it("HEAD answers like GET with no body", async () => {
    const { app } = setup();

    const res = await app.request("/auth/login", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it.each(["PUT", "DELETE", "OPTIONS", "PATCH"])("answers %s with 405 before any product catch-all", async (method) => {
    const { auth } = setup();
    const app = buildDaemonApp(auth, (inner) => inner.all("*", (c) => c.text("catch-all")));

    const res = await app.request("/auth/login", {
      method,
      headers: { host: "localhost:7500", "content-type": "application/json", "x-titan-client": "test" },
      body: method === "OPTIONS" ? undefined : "{}",
    });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
    expect(await res.text()).not.toBe("catch-all");
  });

  it("GET does not reflect its query into the page", async () => {
    const { app } = setup();
    const res = await app.request(`/auth/login?code=${encodeURIComponent('"><script>alert(1)</script>')}`);
    expect(await res.text()).not.toContain("alert(1)");
  });

  it("POST spends the code and sets an HttpOnly, SameSite=Strict, Path=/ cookie that the gate accepts", async () => {
    const { app, secret } = setup();

    const res = await postLogin(app, { code: mintLoginCode(secret, T0) });

    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=2592000/);
    expect(header).not.toMatch(/Domain=/i);
    expect((await app.request("/", withCookie(sessionFrom(res)))).status).toBe(200);
  });

  it("refuses a replayed code", async () => {
    const { app, secret } = setup();
    const code = mintLoginCode(secret, T0);

    expect((await postLogin(app, { code })).status).toBe(200);
    const replay = await postLogin(app, { code });

    expect(replay.status).toBe(401);
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("lets exactly one of two concurrent logins with one code through", async () => {
    const { app, secret } = setup();
    const code = mintLoginCode(secret, T0);

    const results = await Promise.all([postLogin(app, { code }), postLogin(app, { code })]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("refuses an expired code", async () => {
    const { app, secret } = setup();
    const code = mintLoginCode(secret, T0);

    vi.setSystemTime(T0 + LOGIN_CODE_TTL_MS);

    expect((await postLogin(app, { code })).status).toBe(401);
  });

  it("refuses a code minted before the daemon started", async () => {
    const secret = ensureTokenFile(tokenFile);
    const code = mintLoginCode(secret, T0 - 1);
    const app = buildGatedApp(createDaemonAuth({ tokenFile, startedAt: T0 }));

    expect((await postLogin(app, { code })).status).toBe(401);
  });

  it("refuses a code minted under the secret a rotation replaced", async () => {
    const { app, secret } = setup();
    const code = mintLoginCode(secret, T0);

    rotateTokenFile(tokenFile);

    expect((await postLogin(app, { code })).status).toBe(401);
  });

  it.each([["not JSON", "code="], ["no code", {}], ["a numeric code", { code: 1 }], ["null", "null"]])(
    "refuses a body that is %s",
    async (_label, body) => {
      const { app } = setup();
      expect((await postLogin(app, body)).status).toBe(401);
    },
  );
});

describe("POST /auth/logout", () => {
  it("clears the cookie with the attributes it was set with", async () => {
    const { app, secret } = setup();

    const res = await app.request("/auth/logout", { method: "POST", ...withCookie(signSession(secret, T0)) });

    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(header).toMatch(/Max-Age=0/);
    expect(header).toMatch(/Path=\//);
  });

  it("is answered 415 for a non-JSON body behind the request guard", async () => {
    const { auth, secret } = setup();
    const app = buildDaemonApp(auth);
    const headers = { host: "localhost:7500", origin: "http://localhost:7500", cookie: `${SESSION_COOKIE}=${signSession(secret, T0)}` };

    const form = await app.request("/auth/logout", { method: "POST", headers: { ...headers, "content-type": "text/plain" } });
    const json = await app.request("/auth/logout", { method: "POST", headers: { ...headers, "content-type": "application/json" } });

    expect(form.status).toBe(415);
    expect(json.status).toBe(200);
  });
});

describe("createContext receives what the gate recorded", () => {
  function buildRpcApp(auth?: DaemonAuth) {
    const createContext = vi.fn((surface: Surface) => createTestContext(surface));
    if (!auth) return { app: buildHttpApp({ registry: createTestRegistry(), createContext, version: "0.0.0", port: () => 7500 }), createContext };
    return { app: buildDaemonApp(auth, undefined, createContext), createContext };
  }

  const rpc = (app: Hono, headers: Record<string, string>, peer?: string) =>
    app.request(
      "/rpc/greet",
      {
        method: "POST",
        body: JSON.stringify({ name: "x" }),
        headers: { host: "localhost:7500", "content-type": "application/json", "x-titan-client": "test", ...headers },
      },
      peer === undefined ? undefined : { incoming: { socket: { remoteAddress: peer } } },
    );

  it("passes the bearer credential", async () => {
    const secret = ensureTokenFile(tokenFile);
    const { app, createContext } = buildRpcApp(createDaemonAuth({ tokenFile }));

    expect((await rpc(app, { authorization: `Bearer ${secret}` })).status).toBe(200);
    expect(createContext).toHaveBeenCalledWith("http", { credential: "bearer", issuedAt: null, peerLocal: true });
  });

  it("passes the session credential with its issue time", async () => {
    const secret = ensureTokenFile(tokenFile);
    const { app, createContext } = buildRpcApp(createDaemonAuth({ tokenFile }));
    const issuedAt = T0 - MINUTE;

    expect((await rpc(app, { cookie: `${SESSION_COOKIE}=${signSession(secret, issuedAt)}` })).status).toBe(200);
    expect(createContext).toHaveBeenCalledWith("http", { credential: "session", issuedAt, peerLocal: true });
  });

  const ownLanAddress = Object.values(networkInterfaces())
    .flat()
    .find((i) => i?.family === "IPv4" && !i.internal)?.address;

  const peers: Array<[string, string, boolean]> = [
    ["a documentation address", "192.0.2.50", false],
    ["a mapped documentation address", "::ffff:192.0.2.50", false],
    ["loopback", "127.0.0.1", true],
    ["mapped loopback", "::ffff:127.0.0.1", true],
    ["IPv6 loopback", "::1", true],
  ];
  if (ownLanAddress) peers.push(["this host's own LAN address", ownLanAddress, true], ["this host's own mapped LAN address", `::ffff:${ownLanAddress}`, true]);

  it.each(peers)("records peerLocal for %s", async (_label, peer, peerLocal) => {
    const secret = ensureTokenFile(tokenFile);
    const { app, createContext } = buildRpcApp(createDaemonAuth({ tokenFile }));

    expect((await rpc(app, { authorization: `Bearer ${secret}` }, peer)).status).toBe(200);
    expect(createContext).toHaveBeenCalledWith("http", { credential: "bearer", issuedAt: null, peerLocal });
  });

  it("counts an unknown peer address as local, so a same-machine refusal fails closed", async () => {
    const secret = ensureTokenFile(tokenFile);
    const { app, createContext } = buildRpcApp(createDaemonAuth({ tokenFile }));

    expect((await rpc(app, { authorization: `Bearer ${secret}` })).status).toBe(200);
    expect(createContext).toHaveBeenCalledWith("http", { credential: "bearer", issuedAt: null, peerLocal: true });
  });

  it("passes nothing on an ungated app", async () => {
    const { app, createContext } = buildRpcApp();

    expect((await rpc(app, {})).status).toBe(200);
    expect(createContext).toHaveBeenCalledWith("http", undefined);
  });
});
