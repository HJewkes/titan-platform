import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOW, fakeCredentials } from "../fixtures/fake-tokens.js";
import { makeTempHome, removeTempHome, writeFileWithMode } from "../fixtures/temp-home.js";
import { runCli, type CliContext } from "../cli/cli.js";
import { redactSecrets } from "../redact.js";
import { readAccounts } from "./accounts.js";
import { accountIdentity } from "./identity.js";
import { keychainService, type KeychainExec } from "./keychain.js";
import { CREDENTIALS_FILE } from "./login.js";
import { sessionsDir } from "./usage-file.js";

const SECONDS = Math.floor(NOW / 1000);
const WEEK_RESET = SECONDS + 3 * 86_400;
const uid = process.getuid?.() ?? 0;

let home: string;

beforeEach(() => {
  home = makeTempHome();
});

afterEach(() => removeTempHome(home));

const dir = (label: string): string => (label === "default" ? path.join(home, ".claude") : path.join(home, ".claude-profiles", label));

function loginAs(label: string, user: string | null): void {
  writeFileWithMode(path.join(dir(label), CREDENTIALS_FILE), JSON.stringify(fakeCredentials()), 0o600);
  if (user === null) return;
  const file = label === "default" ? path.join(home, ".claude.json") : path.join(dir(label), ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: user, organizationUuid: "org-1" } }));
}

function reading(label: string, session: string, ageSeconds: number, weekly: number): void {
  fs.mkdirSync(sessionsDir(dir(label)), { recursive: true });
  const rate_limits = { seven_day: { used_percentage: weekly, resets_at: WEEK_RESET } };
  const body = { session_id: session, written_at: SECONDS - ageSeconds, rate_limits };
  fs.writeFileSync(path.join(sessionsDir(dir(label)), `${session}.json`), JSON.stringify(body));
}

// default and personal share one login; agents has its own; workout's login cannot be read.
function arrangeFleet(): void {
  loginAs("default", "user-a");
  loginAs("personal", "user-a");
  loginAs("agents", "user-b");
  loginAs("workout", null);
  reading("default", "usage-poll", 60, 40);
  reading("personal", "session-p", 30, 38);
  reading("agents", "session-a", 30, 12);
  reading("workout", "usage-poll", 90, 7);
}

async function cli(argv: string[], env: Record<string, string> = {}): Promise<string[]> {
  const out: string[] = [];
  const context: CliContext = { env, home, uid, now: () => NOW, out: (line) => out.push(line), err: () => undefined };
  await runCli(argv, context);
  return out;
}

describe("readAccounts", () => {
  it("gives two config dirs on one login a single row naming both dirs", () => {
    arrangeFleet();

    const rows = readAccounts({ home, env: {}, now: NOW, uid });

    const shared = rows.filter((row) => row.identity === "user-a/org-1");
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ account: "personal", config_dirs: [dir("default"), dir("personal")] });
    expect(shared[0]?.windows.seven_day?.used_pct).toBe(40);
  });

  it("keeps each dir whose identity cannot be read as its own row", () => {
    arrangeFleet();
    loginAs("server", null);

    const rows = readAccounts({ home, env: {}, now: NOW, uid, identify: (configDir) => accountIdentity(configDir, home) });

    expect(rows.map((row) => row.config_dirs)).toEqual([[dir("default"), dir("personal")], [dir("agents")], [dir("server")], [dir("workout")]]);
    expect(rows.filter((row) => row.identity === undefined).map((row) => row.account)).toEqual(["server", "workout"]);
  });

  it("dates a status line redrawing old figures by its last API response and marks it stale", () => {
    loginAs("agents", "user-b");
    const lastResponse = SECONDS - 35 * 3600;
    fs.mkdirSync(sessionsDir(dir("agents")), { recursive: true });
    const body = {
      session_id: "session-a",
      written_at: SECONDS - 10,
      rate_limits: { seven_day: { used_percentage: 12, resets_at: WEEK_RESET } },
      prompt_cache: { ttl: "5m", expires_at: lastResponse + 300 },
    };
    fs.writeFileSync(path.join(sessionsDir(dir("agents")), "session-a.json"), JSON.stringify(body));

    const [row] = readAccounts({ home, env: {}, now: NOW, uid });

    expect(row).toMatchObject({ source: "status-line", age_seconds: 35 * 3600, stale: true });
  });
});

type LoginKind = "healthy" | "refused" | "expired-no-refresh" | "missing";
type Platform = "darwin" | "linux";

// Only darwin lets a missing login pass, because Claude Code keeps it in the Keychain there.
const FAILS: Record<LoginKind, Record<Platform, boolean>> = {
  healthy: { darwin: false, linux: false },
  refused: { darwin: true, linux: true },
  "expired-no-refresh": { darwin: true, linux: true },
  missing: { darwin: false, linux: true },
};

function credentialsFor(kind: LoginKind): string {
  if (kind === "expired-no-refresh") return JSON.stringify(fakeCredentials({ expiresAt: NOW - 3_600_000, refreshToken: undefined }));
  return JSON.stringify(fakeCredentials());
}

// A linux login is a file in the dir; a darwin login is a stubbed Keychain item, never the real one.
function provision(platform: Platform, keychain: Map<string, { status: number; text: string }>, label: string, user: string, kind: LoginKind): void {
  fs.mkdirSync(dir(label), { recursive: true });
  const file = label === "default" ? path.join(home, ".claude.json") : path.join(dir(label), ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: user, organizationUuid: "org-1" } }));
  if (platform === "linux") {
    if (kind === "missing") return;
    writeFileWithMode(path.join(dir(label), CREDENTIALS_FILE), credentialsFor(kind), kind === "refused" ? 0o644 : 0o600);
    return;
  }
  const item = kind === "missing" ? { status: 44, text: "" } : { status: 0, text: kind === "refused" ? "not json" : credentialsFor(kind) };
  keychain.set(keychainService(dir(label), home), item);
}

describe.each<Platform>(["darwin", "linux"])("readAccounts auth_fail on %s", (platform) => {
  const keychain = new Map<string, { status: number; text: string }>();
  const keychainExec: KeychainExec = (_file, args) => {
    const item = keychain.get(args[2] ?? "") ?? { status: 44, text: "" };
    return { status: item.status, stdout: Buffer.from(item.text), stderr: Buffer.alloc(0) };
  };
  const read = () => readAccounts({ home, env: {}, now: NOW, uid, platform, keychainExec });
  const rowOf = (identity: string) => read().find((row) => row.identity === identity);

  beforeEach(() => keychain.clear());

  it.each<LoginKind>(["refused", "expired-no-refresh", "missing"])("fails a row whose only login is %s", (kind) => {
    provision(platform, keychain, "default", "user-a", "healthy");
    provision(platform, keychain, "agents", "user-b", kind);

    expect(rowOf("user-b/org-1")?.auth_fail).toBe(FAILS[kind][platform]);
    expect(rowOf("user-a/org-1")?.auth_fail).toBe(false);
  });

  it.each<LoginKind>(["refused", "expired-no-refresh", "missing"])("fails the shared row when one member's login is %s", (kind) => {
    provision(platform, keychain, "default", "user-a", "healthy");
    provision(platform, keychain, "personal", "user-a", kind);

    const rows = read();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ config_dirs: [dir("default"), dir("personal")], auth_fail: FAILS[kind][platform] });
  });

  it("keeps a shared row healthy when every member's login is healthy", () => {
    provision(platform, keychain, "default", "user-a", "healthy");
    provision(platform, keychain, "personal", "user-a", "healthy");

    expect(read().map((row) => row.auth_fail)).toEqual([false]);
  });
});

describe("accountIdentity for the default dir (CLAUDE_CONFIG_DIR=~/.claude)", () => {
  const write = (file: string, user: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: user, organizationUuid: "org-1" } }));
  };

  it("reads ~/.claude.json first, as Claude Code does with CLAUDE_CONFIG_DIR unset", () => {
    write(path.join(home, ".claude.json"), "user-home");
    write(path.join(home, ".claude", ".claude.json"), "user-inside");

    expect(accountIdentity(path.join(home, ".claude"), home)).toBe("user-home/org-1");
  });

  it("falls back to ~/.claude/.claude.json, where Claude Code writes it once CLAUDE_CONFIG_DIR names the dir", () => {
    write(path.join(home, ".claude", ".claude.json"), "user-inside");

    expect(accountIdentity(path.join(home, ".claude"), home)).toBe("user-inside/org-1");
  });

  it("ignores ~/.claude.json for any other dir", () => {
    write(path.join(home, ".claude.json"), "user-home");

    expect(accountIdentity(dir("personal"), home)).toBeUndefined();
  });
});

describe("status --json schema 2", () => {
  it("prints one row per login in the schema 2 golden shape", async () => {
    arrangeFleet();

    const printed = JSON.parse((await cli(["status", "--json"])).join(""));

    const row = (account: string, dirs: string[], identity: string | undefined, rest: object) => ({
      account,
      // Printed dirs pass through redaction, which a long random temp-dir segment can trip.
      config_dirs: dirs.map((label) => redactSecrets(dir(label))),
      ...(identity === undefined ? {} : { identity }),
      auth_fail: false,
      stale: false,
      ...rest,
    });
    const weekly = (used: number) => ({ seven_day: { used_pct: used, resets_at: WEEK_RESET } });
    expect(printed).toEqual({
      schema: 2,
      accounts: [
        row("personal", ["default", "personal"], "user-a/org-1", { source: "oauth-usage", windows: weekly(40), age_seconds: 60 }),
        row("agents", ["agents"], "user-b/org-1", { source: "status-line", windows: weekly(12), age_seconds: 30 }),
        row("workout", ["workout"], undefined, { source: "oauth-usage", windows: weekly(7), age_seconds: 90 }),
      ],
    });
  });
});

describe("status --statusline over readAccounts", () => {
  it("renders default and personal as one cell under the personal label", async () => {
    arrangeFleet();

    const lines = await cli(["status", "--statusline"], { CLAUDE_CONFIG_DIR: dir("agents") });

    expect(lines).toEqual([`|12||${WEEK_RESET}|||||30`, "other|personal||40|60|", "other|workout||7|90|"]);
  });

  it("shows no other cell for the login the current default dir shares", async () => {
    arrangeFleet();

    const lines = await cli(["status", "--statusline"]);

    expect(lines).toEqual([`|40||${WEEK_RESET}|||||60`, "other|agents||12|30|", "other|workout||7|90|"]);
  });
});
