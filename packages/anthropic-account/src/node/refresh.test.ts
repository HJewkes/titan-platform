import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANARY, FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, HOUR, NOW, fakeCredentials } from "../fixtures/fake-tokens.js";
import {
  captureOutput,
  errorText,
  makeFifo,
  makeTempHome,
  removeTempHome,
  unblockFifoLater,
  writeFileWithMode,
} from "../fixtures/temp-home.js";
import type { AccountProfile } from "../profile.js";
import { REFRESH_LOCK, REFRESH_LOCK_HOLDER, acquireRefreshLock } from "./credentials-write.js";
import { CREDENTIALS_FILE } from "./login.js";
import type { FetchLike } from "./poll.js";
import { DEFAULT_REFRESH_SCOPES, OAUTH_CLIENT_ID, TOKEN_URL, refreshIfNeeded, type RefreshOptions } from "./refresh.js";
import { refreshFailureDeposit, type RefreshFailureDeposit } from "./refresh-deposit.js";

const uid = process.getuid?.() ?? 0;
const MARGIN = 5 * 60_000;
const EXPIRING = NOW + 60_000;
const tail = (seed: string): string => `${CANARY}${seed}${"Rk7_".repeat(12)}`;
const NEW_ACCESS_TOKEN = ["sk", "ant", "oat01", tail("newaccess")].join("-");
const NEW_REFRESH_TOKEN = ["sk", "ant", "ort01", tail("newrefresh")].join("-");

interface Call {
  url: string;
  init: RequestInit;
}

let home: string;
let profile: AccountProfile;
let file: string;
let output: ReturnType<typeof captureOutput>;
let deposits: RefreshFailureDeposit[];

beforeEach(() => {
  home = makeTempHome();
  profile = { label: "default", configDir: path.join(home, ".claude") };
  file = path.join(profile.configDir, CREDENTIALS_FILE);
  output = captureOutput();
  deposits = [];
});

afterEach(() => {
  output.restore();
  vi.restoreAllMocks();
  expectNoCanaryInFiles(home);
  removeTempHome(home);
});

function writeText(text: string, mode = 0o600): void {
  writeFileWithMode(file, text, mode);
}

function expiringCredentials(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return fakeCredentials({ expiresAt: EXPIRING, ...overrides });
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const granted = (extra: Record<string, unknown> = {}): Response =>
  json({ access_token: NEW_ACCESS_TOKEN, expires_in: 28_800, token_type: "Bearer", ...extra });

function refresh(fetch: FetchLike, options: Partial<RefreshOptions> = {}): ReturnType<typeof refreshIfNeeded> {
  return refreshIfNeeded(profile, {
    fetch,
    marginMs: MARGIN,
    now: NOW,
    uid,
    onFailure: (deposit) => void deposits.push(deposit),
    ...options,
  });
}

// Case-blind, so a server that lowercases the echoed token into a key is caught too.
function expectCanaryAbsent(text: string): void {
  expect(text.toLowerCase()).not.toContain(CANARY.toLowerCase());
}

function expectNoCanary(...values: unknown[]): void {
  for (const value of values) expectCanaryAbsent(value instanceof Error ? errorText(value) : (JSON.stringify(value) ?? ""));
  expectCanaryAbsent(JSON.stringify(deposits));
  expectCanaryAbsent(output.text());
}

// The credentials files hold the canary by design; every other file is one this package wrote.
function expectNoCanaryInFiles(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name === CREDENTIALS_FILE) continue;
    expectCanaryAbsent(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"));
  }
}

// What a crash between taking and releasing the locks leaves: both lock dirs and the record.
function leaveOwnLock(pid: number, inoOffset = 0, recordMode = 0o600): void {
  const primary = path.join(profile.configDir, REFRESH_LOCK);
  const legacy = `${profile.configDir}.lock`;
  fs.mkdirSync(primary);
  fs.mkdirSync(legacy);
  const identity = (dir: string) => {
    const { ino, ctimeMs } = fs.lstatSync(dir);
    return { ino: ino + inoOffset, ctimeMs };
  };
  const record = { pid, primary: identity(primary), legacy: identity(legacy) };
  writeFileWithMode(holderFile(), JSON.stringify(record), recordMode);
}

const holderFile = (): string => path.join(profile.configDir, REFRESH_LOCK_HOLDER);
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

function expectNoLeftovers(): void {
  expect(fs.readdirSync(profile.configDir)).toEqual([CREDENTIALS_FILE]);
  expect(fs.existsSync(`${profile.configDir}.lock`)).toBe(false);
}

describe("refreshIfNeeded leaves a fresh token alone", () => {
  it("sends nothing and writes nothing when the token is outside the margin", async () => {
    writeText(JSON.stringify(fakeCredentials()));
    const before = fs.readFileSync(file, "utf8");
    const { fetch, calls } = fakeFetch(() => granted());

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "fresh" });
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expectNoLeftovers();
  });

  it("skips a credentials file wider than 0600 without sending or depositing", async () => {
    writeText(JSON.stringify(expiringCredentials()), 0o644);
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "skipped", reason: "mode-too-wide" });
    expect(calls).toHaveLength(0);
    expect(deposits).toEqual([]);
  });

  it("skips a profile with no credentials file", async () => {
    fs.mkdirSync(profile.configDir, { recursive: true });
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "skipped", reason: "missing" });
    expect(calls).toHaveLength(0);
  });
});

describe("refreshIfNeeded exchanges the refresh token the way Claude Code does", () => {
  it("POSTs JSON with the refresh grant, Claude Code's client id and default scopes", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const { fetch, calls } = fakeFetch(() => granted());

    await refresh(fetch);

    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [Call];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: FAKE_REFRESH_TOKEN,
      client_id: OAUTH_CLIENT_ID,
      scope: DEFAULT_REFRESH_SCOPES.join(" "),
    });
    expect(JSON.stringify(init.headers)).not.toContain(CANARY);
  });

  it("keeps a stored client id and asks for exactly the scopes it holds", async () => {
    const clientId = "00000000-0000-4000-8000-00000000abcd";
    writeText(JSON.stringify(expiringCredentials({ clientId, scopes: ["user:inference"] })));
    const { fetch, calls } = fakeFetch(() => granted());

    await refresh(fetch);

    const body = JSON.parse(String((calls[0] as Call).init.body));
    expect(body.client_id).toBe(clientId);
    expect(body.scope).toBe("user:inference");
  });
});

describe("refreshIfNeeded writes the new credentials atomically", () => {
  it("replaces only the access token and expiry, byte for byte", async () => {
    const original = JSON.stringify(expiringCredentials());
    writeText(original);
    const { fetch } = fakeFetch(() => granted());

    const result = await refresh(fetch);

    const expiresAt = NOW + 28_800_000;
    expect(result).toEqual({ status: "refreshed", expiresAt });
    const expected = original.replace(FAKE_ACCESS_TOKEN, NEW_ACCESS_TOKEN).replace(String(EXPIRING), String(expiresAt));
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expectNoLeftovers();
    expectNoCanary(result);
  });

  it("keeps an indented layout, its trailing newline and fields it does not know", async () => {
    const credentials = { mcpOAuth: { server: { note: "kept" } }, ...expiringCredentials(), zLast: [1, 2.5, null] };
    const original = `${JSON.stringify(credentials, null, 2)}\n`;
    writeText(original);
    const { fetch } = fakeFetch(() => granted());

    await refresh(fetch);

    const expected = original
      .replace(FAKE_ACCESS_TOKEN, NEW_ACCESS_TOKEN)
      .replace(String(EXPIRING), String(NOW + 28_800_000));
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
  });

  it("stores a rotated refresh token and its new expiry", async () => {
    const original = JSON.stringify(expiringCredentials());
    writeText(original);
    const { fetch } = fakeFetch(() => granted({ refresh_token: NEW_REFRESH_TOKEN, refresh_token_expires_in: 2_592_000 }));

    await refresh(fetch);

    const oauth = JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth;
    expect(oauth.refreshToken).toBe(NEW_REFRESH_TOKEN);
    expect(oauth.refreshTokenExpiresAt).toBe(NOW + 2_592_000_000);
    expect(Object.keys(oauth)).toEqual(Object.keys(JSON.parse(original).claudeAiOauth));
  });

  it("refuses a layout it cannot reproduce before spending the refresh token", async () => {
    const original = JSON.stringify(expiringCredentials()).replace(":", " : ");
    writeText(original);
    const { fetch, calls } = fakeFetch(() => granted());

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "failed", failure: "unrecognized-format", deposited: true });
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });

  it("leaves the old file whole and no temp file when the rename fails", async () => {
    const original = JSON.stringify(expiringCredentials());
    writeText(original);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error(`EXDEV moving ${NEW_ACCESS_TOKEN}`);
    });
    const { fetch } = fakeFetch(() => granted());

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "failed", failure: "io", deposited: true });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expectNoLeftovers();
    expectNoCanary(result);
  });

  it("asks for a new login when a rotated refresh token cannot be stored", async () => {
    const original = JSON.stringify(expiringCredentials());
    writeText(original);
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error(`EXDEV moving ${NEW_REFRESH_TOKEN}`);
    });
    const { fetch } = fakeFetch(() => granted({ refresh_token: NEW_REFRESH_TOKEN }));

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "failed", failure: "write-failed", deposited: true });
    expect(deposits[0]?.context).toContain("Log in again");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expectNoLeftovers();
    expectNoCanary(result);
  });
});

describe("refreshIfNeeded yields to another writer", () => {
  it("yields to a new login another session wrote while the request was in flight", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const theirs = JSON.stringify(
      fakeCredentials({ accessToken: `${FAKE_ACCESS_TOKEN}theirs`, refreshToken: `${FAKE_REFRESH_TOKEN}theirs` }),
    );
    const { fetch } = fakeFetch(() => {
      writeText(theirs);
      return granted({ refresh_token: NEW_REFRESH_TOKEN });
    });

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "refreshed-elsewhere" });
    expect(fs.readFileSync(file, "utf8")).toBe(theirs);
    expectNoLeftovers();
  });

  it("keeps a rotated refresh token when another writer changed an unrelated key in flight", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const theirs = JSON.stringify({ ...expiringCredentials(), mcpOAuth: { server: { note: "theirs" } } });
    const { fetch } = fakeFetch(() => {
      writeText(theirs);
      return granted({ refresh_token: NEW_REFRESH_TOKEN });
    });

    const result = await refresh(fetch);

    const expiresAt = NOW + 28_800_000;
    expect(result).toEqual({ status: "refreshed", expiresAt });
    const expected = theirs
      .replace(FAKE_ACCESS_TOKEN, NEW_ACCESS_TOKEN)
      .replace(FAKE_REFRESH_TOKEN, NEW_REFRESH_TOKEN)
      .replace(String(EXPIRING), String(expiresAt));
    expect(fs.readFileSync(file, "utf8")).toBe(expected);
    expectNoLeftovers();
  });

  it("waits out a file another writer is rewriting in place, then merges onto its result", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const theirs = JSON.stringify({ ...expiringCredentials(), mcpOAuth: {} });
    const { fetch } = fakeFetch(() => {
      writeText(theirs.slice(0, 40));
      setTimeout(() => writeText(theirs), 50);
      return granted({ refresh_token: NEW_REFRESH_TOKEN });
    });

    expect(await refresh(fetch)).toMatchObject({ status: "refreshed" });
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.mcpOAuth).toEqual({});
    expect(stored.claudeAiOauth.refreshToken).toBe(NEW_REFRESH_TOKEN);
  });

  it("files a write-conflict, never overwriting, when the file stays torn", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const torn = JSON.stringify(fakeCredentials()).slice(0, 40);
    const { fetch } = fakeFetch(() => {
      writeText(torn);
      return granted({ refresh_token: NEW_REFRESH_TOKEN });
    });

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "failed", failure: "write-conflict", deposited: true });
    expect(fs.readFileSync(file, "utf8")).toBe(torn);
    expect(deposits[0]?.summary).toBe("Claude token refresh failed for profile default: write-conflict");
    expectNoLeftovers();
    expectNoCanary(result);
  });

  it("does not recreate a credentials file a logout removed in flight", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const { fetch } = fakeFetch(() => {
      fs.rmSync(file);
      return granted();
    });

    expect(await refresh(fetch)).toEqual({ status: "refreshed-elsewhere" });
    expect(fs.readdirSync(profile.configDir)).toEqual([]);
  });

  it("lets only one of two concurrent refreshes send, and leaves one whole file", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const { fetch, calls } = fakeFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return granted();
    });

    const results = await Promise.all([refresh(fetch), refresh(fetch)]);

    expect(calls).toHaveLength(1);
    expect(results.map((result) => result.status).sort()).toEqual(["locked", "refreshed"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).claudeAiOauth.accessToken).toBe(NEW_ACCESS_TOKEN);
    expectNoLeftovers();
  });

  it("does not send while Claude Code holds its refresh lock, and leaves the lock alone", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    fs.mkdirSync(path.join(profile.configDir, REFRESH_LOCK));
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "locked" });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(profile.configDir, REFRESH_LOCK))).toBe(true);
    expect(deposits).toEqual([]);
  });

  it("reclaims a lock this package left behind when its holder has exited", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    leaveOwnLock(deadPid());
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toMatchObject({ status: "refreshed" });
    expect(calls).toHaveLength(1);
    expectNoLeftovers();
  });

  it("keeps a lock this package holds while its holder is alive", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    leaveOwnLock(process.pid);
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "locked" });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(profile.configDir, REFRESH_LOCK))).toBe(true);
  });

  it("keeps the fresh record of an acquirer that takes the lock mid-reclaim", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    leaveOwnLock(deadPid());
    const primary = path.join(profile.configDir, REFRESH_LOCK);
    const realRmdir = fs.rmdirSync;
    const racer: { release?: (() => void) | null } = {};
    const rmdir = vi.spyOn(fs, "rmdirSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      (realRmdir as (...args: unknown[]) => void)(target, ...rest);
      if (String(target) === primary && racer.release === undefined) racer.release = acquireRefreshLock(profile.configDir, uid);
    }) as typeof fs.rmdirSync);
    const { fetch, calls } = fakeFetch(() => granted());

    const result = await refresh(fetch);
    rmdir.mockRestore();

    expect(result).toEqual({ status: "locked" });
    expect(calls).toHaveLength(0);
    const fresh = JSON.parse(fs.readFileSync(holderFile(), "utf8"));
    expect(fresh).toMatchObject({ pid: process.pid, primary: { ino: fs.lstatSync(primary).ino } });
    racer.release?.();
  });

  it("never reclaims a lock whose holder record names a different lock", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    leaveOwnLock(deadPid(), 1);
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "locked" });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(profile.configDir, REFRESH_LOCK))).toBe(true);
  });

  it("does not send while Claude Code holds its legacy lock, and releases its own", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    fs.mkdirSync(`${profile.configDir}.lock`);
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "locked" });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(profile.configDir, REFRESH_LOCK))).toBe(false);
    fs.rmdirSync(`${profile.configDir}.lock`);
  });
});

describe("refreshIfNeeded trusts only its own regular file as the lock holder record", () => {
  let unblocker: ChildProcess | undefined;

  afterEach(() => {
    unblocker?.kill();
    unblocker = undefined;
  });

  it("never writes through a symlink at the record path", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const target = path.join(home, "target.txt");
    writeFileWithMode(target, "keep", 0o600);
    fs.symlinkSync(target, holderFile());
    const { fetch } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toMatchObject({ status: "refreshed" });
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
    expectNoLeftovers();
  });

  it("replaces a record a crash left behind once its lock dirs are gone", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const stale = { pid: deadPid(), primary: { ino: 1, ctimeMs: 1 } };
    writeFileWithMode(holderFile(), JSON.stringify(stale), 0o600);
    const { fetch } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toMatchObject({ status: "refreshed" });
    expectNoLeftovers();
  });

  it.each([
    ["is wider than 0600", () => leaveOwnLock(deadPid(), 0, 0o644)],
    ["has a second name", () => (leaveOwnLock(deadPid()), fs.linkSync(holderFile(), path.join(home, "other")))],
  ])("never reclaims a lock whose record %s", async (_name, leave) => {
    writeText(JSON.stringify(expiringCredentials()));
    leave();
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "locked" });
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(path.join(profile.configDir, REFRESH_LOCK))).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "returns promptly, leaving the lock, when the record is a FIFO",
    async () => {
      writeText(JSON.stringify(expiringCredentials()));
      fs.mkdirSync(path.join(profile.configDir, REFRESH_LOCK));
      makeFifo(holderFile());
      unblocker = unblockFifoLater(holderFile());
      const started = Date.now();

      const result = await refresh(fakeFetch(() => granted()).fetch);

      expect(Date.now() - started).toBeLessThan(500);
      expect(result).toEqual({ status: "locked" });
      expect(fs.existsSync(path.join(profile.configDir, REFRESH_LOCK))).toBe(true);
    },
    15_000,
  );

  it("keeps write-failed, and frees the lock dirs, when removing the record throws", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV");
    });
    const realRm = fs.rmSync;
    vi.spyOn(fs, "rmSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target) === holderFile()) throw new Error("EACCES");
      return (realRm as (...args: unknown[]) => void)(target, ...rest);
    }) as typeof fs.rmSync);
    const { fetch } = fakeFetch(() => granted({ refresh_token: NEW_REFRESH_TOKEN }));

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "failed", failure: "write-failed", deposited: true });
    expect(fs.existsSync(path.join(profile.configDir, REFRESH_LOCK))).toBe(false);
    expect(fs.existsSync(`${profile.configDir}.lock`)).toBe(false);
  });
});

describe("refreshIfNeeded failures are values with no token, and file one deposit", () => {
  it("reports a rejected refresh token without reading the body that echoes it", async () => {
    const original = JSON.stringify(expiringCredentials());
    writeText(original);
    const { fetch } = fakeFetch(() => json({ error: "invalid_grant", echo: FAKE_REFRESH_TOKEN }, { status: 400 }));

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "failed", failure: "http-400", deposited: true });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(deposits).toEqual([refreshFailureDeposit("default", "http-400", NOW)]);
    expect(deposits[0]?.context).toContain("Log in again");
    expectNoLeftovers();
    expectNoCanary(result);
  });

  it("reports login-required for an expired token with no refresh token, without sending", async () => {
    writeText(JSON.stringify(expiringCredentials({ refreshToken: undefined, expiresAt: NOW - HOUR })));
    const { fetch, calls } = fakeFetch(() => granted());

    expect(await refresh(fetch)).toEqual({ status: "failed", failure: "login-required", deposited: true });
    expect(calls).toHaveLength(0);
    expect(deposits[0]?.summary).toBe("Claude token refresh failed for profile default: login-required");
  });

  it.each([
    ["a fetch that throws the token", "network", () => Promise.reject(new Error(`ECONNRESET ${FAKE_REFRESH_TOKEN}`))],
    ["a redirect", "network", () => Object.defineProperty(granted(), "redirected", { value: true })],
    ["a non-JSON body", "malformed", () => new Response(`not json ${FAKE_REFRESH_TOKEN}`, { status: 200 })],
    ["a token with a line break", "malformed", () => json({ access_token: `${NEW_ACCESS_TOKEN}\r\nx: y`, expires_in: 60 })],
    ["no expires_in", "malformed", () => json({ access_token: NEW_ACCESS_TOKEN })],
    ["a 500 that echoes the token", "http-500", () => new Response(FAKE_REFRESH_TOKEN, { status: 500 })],
  ] as const)("reports %s as %s and leaves the file alone", async (_name, failure, respond) => {
    const original = JSON.stringify(expiringCredentials());
    writeText(original);
    const { fetch } = fakeFetch(respond as () => Promise<Response>);

    const result = await refresh(fetch);

    expect(result).toEqual({ status: "failed", failure, deposited: true });
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expectNoLeftovers();
    expectNoCanary(result);
  });

  it("names a token-shaped profile label as unlabelled in the deposit", async () => {
    profile = { label: FAKE_ACCESS_TOKEN, configDir: profile.configDir };
    writeText(JSON.stringify(expiringCredentials()));
    const { fetch } = fakeFetch(() => new Response(null, { status: 401 }));

    await refresh(fetch);

    expect(deposits[0]?.depositId).toBe("token-refresh-unlabelled-relogin-2026-10-08");
    expectNoCanary(deposits);
  });

  it("keeps one depositId per profile per UTC day for each of retry and log in again", () => {
    const morning = refreshFailureDeposit("work", "network", NOW);
    const noon = refreshFailureDeposit("work", "http-500", NOW + 4 * HOUR);
    const evening = refreshFailureDeposit("work", "http-401", NOW + 10 * HOUR);
    const later = refreshFailureDeposit("work", "write-failed", NOW + 7 * HOUR);
    const tomorrow = refreshFailureDeposit("work", "network", NOW + 24 * HOUR);

    expect(morning.depositId).toBe("token-refresh-work-2026-10-08");
    expect(noon.depositId).toBe(morning.depositId);
    expect(evening.depositId).toBe("token-refresh-work-relogin-2026-10-08");
    expect(later.depositId).toBe(evening.depositId);
    expect(tomorrow.depositId).toBe("token-refresh-work-2026-10-09");
    expect(morning).toMatchObject({ asker: "anthropic-account", kind: "do", door: "two-way" });
  });

  it("does not let an earlier retry deposit the same day hide a log-in-again one", async () => {
    // The owner-queue spool keeps the first file it is given for each depositId.
    const spool = new Map<string, RefreshFailureDeposit>();
    const onFailure = (deposit: RefreshFailureDeposit): void => {
      if (!spool.has(deposit.depositId)) spool.set(deposit.depositId, deposit);
    };
    writeText(JSON.stringify(expiringCredentials()));
    await refresh(() => Promise.reject(new Error("ECONNRESET")), { onFailure });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV");
    });

    await refresh(fakeFetch(() => granted({ refresh_token: NEW_REFRESH_TOKEN })).fetch, { onFailure });

    const contexts = [...spool.values()].map((deposit) => deposit.context);
    expect(contexts).toHaveLength(2);
    expect(contexts.some((context) => context.includes("Log in again"))).toBe(true);
  });

  it("returns deposited false when the deposit cannot be filed, and does not throw", async () => {
    writeText(JSON.stringify(expiringCredentials()));
    const { fetch } = fakeFetch(() => new Response(null, { status: 401 }));

    const result = await refresh(fetch, {
      onFailure: () => {
        throw new Error(`spool full ${FAKE_REFRESH_TOKEN}`);
      },
    });

    expect(result).toEqual({ status: "failed", failure: "http-401", deposited: false });
    expectNoCanary(result);
  });

  it.each([
    [{ marginMs: -1 }, /marginMs/],
    [{ now: Number.NaN }, /now/],
    [{ timeoutMs: 60_000 }, /timeoutMs/],
  ])("throws a fixed RangeError for bad options %o", async (options, message) => {
    const { fetch } = fakeFetch(() => granted());

    await expect(refresh(fetch, options)).rejects.toThrow(message);
  });
});
