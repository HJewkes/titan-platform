import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { octokitClient, sharedRateBudget, type GhExecOptions, type GitExec } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { BOT_CAPABILITY, BOT_LOGIN, BOT_TOKEN_PATH, botAccess, botTokenPathIn, openBotIdentity, type BotHandle, type BotIdentity } from "./bot-identity.js";
import { runCommand } from "./service-ports.js";

/** Built, not written out, so no source line carries a token-shaped literal. */
const SENTINEL = `ghp_${"SYNTHETICsentinel".padEnd(36, "0")}`;
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HOUR_S = 3600;
const DAY_MS = 24 * HOUR_S * 1000;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-bot-"));
  dirs.push(dir);
  return dir;
}

function tokenFile(mode = 0o600, text = `${SENTINEL}\n`): string {
  const file = join(scratch(), "bot.token");
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
  return file;
}

interface Seen {
  authorization: string | null;
}

/** Answers every call with the given rate headers and status, and records the authorization it was sent. */
function fakeGitHub(seen: Seen[], status = 200, remaining = 4999, extra: Record<string, string> = {}): typeof fetch {
  return async (_url, init) => {
    seen.push({ authorization: new Headers(init?.headers).get("authorization") });
    const reset = Math.floor(Date.now() / 1000) + HOUR_S;
    const headers = { "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(remaining), "x-ratelimit-used": "1", "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core", ...extra };
    return new Response(JSON.stringify(status === 200 ? {} : { message: "API rate limit exceeded" }), { status, headers });
  };
}

const handle = (bot: BotIdentity): BotHandle => bot.capabilities[BOT_CAPABILITY]!.handle;

function okAccess(bot: BotIdentity) {
  const access = handle(bot).access();
  if (access.state !== "ok") throw new Error(`bot is ${access.state}`);
  return access;
}

const okClient = (bot: BotIdentity) => okAccess(bot).client;

const printEnv = ["-e", "process.stdout.write(JSON.stringify(process.env))"];

describe("bot identity: the token never reaches an env (V3)", () => {
  it("a child spawned through runCommand after the bot has used its token has no sentinel in its env", async () => {
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([]) });
    await okClient(bot).request("GET /rate_limit");

    const bare = await runCommand(process.execPath, printEnv);
    const withEnv = await runCommand(process.execPath, printEnv, { FACTORY_PROBE: "1" });

    expect(bare?.code).toBe(0);
    expect(withEnv?.stdout).toContain("FACTORY_PROBE");
    expect(bare?.stdout).not.toContain(SENTINEL);
    expect(withEnv?.stdout).not.toContain(SENTINEL);
    expect(JSON.stringify(process.env)).not.toContain(SENTINEL);
  });

  it("the bot client sends the file's token over its own fetch", async () => {
    const seen: Seen[] = [];
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub(seen) });

    await okClient(bot).request("GET /rate_limit");

    expect(seen).toEqual([{ authorization: `bearer ${SENTINEL}` }]);
  });

  it("the module reaches GitHub only through octokitClient and the bot's ls-remote: no gh wire, no GH_TOKEN, no process env", () => {
    const source = readFileSync(fileURLToPath(new URL("./bot-identity.ts", import.meta.url)), "utf8");
    const github = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"@titan-design\/github";/g)].flatMap(([, names = ""]) => names.split(",").map((name) => name.trim().replace(/^type\s+/, "")));

    expect(github.filter((name) => name !== "").sort()).toEqual(["GitExec", "GitHubClient", "octokitClient", "parseGitHubToken", "rateBudget"]);
    expect(source).not.toMatch(/GH_TOKEN|process\.env|child_process|ghCliWire|execGh/);
  });
});

describe("bot identity: its own throttle and budget (V4)", () => {
  it("a bot near its rate floor leaves the user login's budget untouched and its client free", async () => {
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([], 200, 0) });
    await okClient(bot).request("GET /rate_limit");
    const sharedAfterBot = sharedRateBudget.remaining;

    const user = octokitClient({ token: async () => "user-fixture", fetch: fakeGitHub([]) });
    const answered = await Promise.race([user.request("GET /rate_limit").then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("waited"), 1000))]);

    expect(sharedAfterBot).toBeNull();
    expect(answered).toBe("answered");
  });

  it("a primary rate limit on the bot cools down only the bot", async () => {
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([], 403, 0) });
    const user = octokitClient({ token: async () => "user-fixture", fetch: fakeGitHub([]) });

    await okClient(bot).request("GET /repos/{owner}/{repo}", { owner: "fixture-org", repo: "fixture-repo" }).catch(() => undefined);
    await user.request("GET /rate_limit");

    expect(okClient(bot).budget().cooldowns).toMatchObject([{ lane: "rest", class: "primary" }]);
    expect(user.budget().cooldowns).toEqual([]);
  });
});

/** GitHub's secondary limit on the first call, with a one-second retry-after; every later call answers 200. */
function secondaryThenOk(calls: string[]): typeof fetch {
  return async (url) => {
    calls.push(String(url));
    if (calls.length > 1) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), { status: 403, headers: { "content-type": "application/json", "retry-after": "1" } });
  };
}

describe("bot identity: the reconciler's pool owns rate-limit waits (TP-3431)", () => {
  it("answers a secondary-limited read at once, unretried, so Octokit's throttle never sleeps under the pool", async () => {
    const calls: string[] = [];
    const bot = openBotIdentity({ path: tokenFile(), fetch: secondaryThenOk(calls) });

    const answer = await okClient(bot).request("GET /rate_limit").then(
      () => "answered",
      (error: { status?: number }) => error.status,
    );

    expect(answer).toBe(403);
    expect(calls).toHaveLength(1);
  });
});

function recordingGit(answer: string): { exec: GitExec; calls: { args: readonly string[]; env: GhExecOptions["env"] }[] } {
  const calls: { args: readonly string[]; env: GhExecOptions["env"] }[] = [];
  const exec: GitExec = async (args, options) => (calls.push({ args, env: options?.env }), { code: 0, stdout: answer, stderr: "" });
  return { exec, calls };
}

describe("bot identity: ls-remote as the bot (TP-3431)", () => {
  const A = "a".repeat(40);

  it("ships with no login, as it ships with no token path", () => {
    expect(BOT_LOGIN).toBeUndefined();
  });

  it("hands the reconciler the bot's login and an ls-remote that sends the bot's own token, off argv", async () => {
    const git = recordingGit(`${A}\trefs/heads/main\n`);
    const bot = openBotIdentity({ path: tokenFile(), login: "synthetic-bot", git: git.exec });
    const access = okAccess(bot);

    const tip = await access.lsRemote("example-org/widgets", { branch: "main" });

    expect([tip, access.login]).toEqual([A, "synthetic-bot"]);
    expect(git.calls[0]!.args).toEqual(["ls-remote", "--", "https://github.com/example-org/widgets.git", "refs/heads/main"]);
    expect(git.calls[0]!.args.join(" ")).not.toContain(SENTINEL);
    const header = Buffer.from(`x-access-token:${SENTINEL}`).toString("base64");
    expect(git.calls[0]!.env).toMatchObject({ GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${header}`, GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "" });
  });
});

describe("bot identity: an absent or refused file disables only the bot (V5)", () => {
  it("reads the token from the owner's 0700 secrets dir under the passwd home, outside the repo", () => {
    expect(BOT_TOKEN_PATH).toBe(join(userInfo().homedir, ".config", "titan-factory", "secrets", "github-bot.token"));
    expect(relative(REPO_ROOT, BOT_TOKEN_PATH!).startsWith("..")).toBe(true);
  });

  it("places the token under whatever home it is given, so a test never meets the real file", () => {
    expect(botTokenPathIn("/srv/synthetic-home")).toBe("/srv/synthetic-home/.config/titan-factory/secrets/github-bot.token");
  });

  it("a token at the fixed layout under a scratch home is read", () => {
    const home = scratch();
    mkdirSync(dirname(botTokenPathIn(home)), { recursive: true, mode: 0o700 });
    writeFileSync(botTokenPathIn(home), `${SENTINEL}\n`, { mode: 0o600 });

    expect(openBotIdentity({ path: botTokenPathIn(home) }).health()).toEqual({ state: "ok", expiresAt: null });
  });

  it("a missing file is absent, and bot steps are blocked with no client to fall back on", () => {
    const bot = openBotIdentity({ path: join(scratch(), "missing.token") });

    expect(bot.health()).toEqual({ state: "absent" });
    expect(handle(bot).access()).toEqual({ state: "blocked", reason: "absent" });
    expect(bot.capabilities[BOT_CAPABILITY]!.secrets).toEqual([]);
  });

  it("a mode-0644 file is refused for its mode, and bot steps are blocked", () => {
    const bot = openBotIdentity({ path: tokenFile(0o644) });

    expect(bot.health()).toEqual({ state: "refused", problem: "mode" });
    expect(handle(bot).access()).toEqual({ state: "blocked", reason: "refused" });
    expect(JSON.stringify(bot.health())).not.toContain(SENTINEL);
  });

  it("a file that is not a GitHub token shape is refused as malformed", () => {
    const bot = openBotIdentity({ path: tokenFile(0o600, "not-a-token\n") });

    expect(bot.health()).toEqual({ state: "refused", problem: "malformed" });
  });

  it("a readable token is ok and is listed as the capability's secret", () => {
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([]) });

    expect(bot.health()).toEqual({ state: "ok", expiresAt: null });
    expect(bot.capabilities[BOT_CAPABILITY]!.secrets).toEqual([SENTINEL]);
  });
});

/** GitHub's own shape for the header: `YYYY-MM-DD HH:MM:SS UTC`, so it is cut to the second. */
function expiresIn(days: number): Record<string, string> {
  const at = new Date(Date.now() + days * DAY_MS).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  return { "github-authentication-token-expiration": at };
}

describe("bot identity: the token's expiry header (V7)", () => {
  it.each([
    [15, 0],
    [14, 1],
  ])("a bot response with %i days left raises %i ops alarms", async (days, alarms) => {
    const lines: string[] = [];
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([], 200, 4999, expiresIn(days)), log: (line) => lines.push(line), alarmed: new Set() });

    await okClient(bot).request("GET /rate_limit");
    await okClient(bot).request("GET /rate_limit");

    expect(lines.filter((line) => line.startsWith("factory: ops-alarm bot-token-expiry "))).toHaveLength(alarms);
    expect(lines.join("\n")).not.toContain(SENTINEL);
  });

  it("an error response still carries the header, so a refused call is read too", async () => {
    const lines: string[] = [];
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([], 403, 0, expiresIn(2)), log: (line) => lines.push(line), alarmed: new Set() });

    await okClient(bot).request("GET /repos/{owner}/{repo}", { owner: "fixture-org", repo: "fixture-repo" }).catch(() => undefined);

    expect(lines).toHaveLength(1);
  });

  it("puts the header's expiry on health once a response carried it", async () => {
    const header = expiresIn(30);
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([], 200, 4999, header), alarmed: new Set() });

    await okClient(bot).request("GET /rate_limit");

    const expected = new Date(Date.parse(header["github-authentication-token-expiration"]!.replace(" UTC", "Z").replace(" ", "T"))).toISOString();
    expect(bot.health()).toEqual({ state: "ok", expiresAt: expected });
  });
});

describe("bot identity: the F11 usage meter", () => {
  it("feeds every bot response's rate-limit headers to the meter, refused calls included", async () => {
    const bot = openBotIdentity({ path: tokenFile(), fetch: fakeGitHub([], 403, 0, { "x-ratelimit-used": "4321" }), alarmed: new Set() });

    await okClient(bot).request("GET /repos/{owner}/{repo}", { owner: "fixture-org", repo: "fixture-repo" }).catch(() => undefined);

    expect(bot.usage?.current().map(({ resource, used, limit }) => ({ resource, used, limit }))).toEqual([{ resource: "core", used: 4321, limit: 5000 }]);
  });

  it("has no meter when the token was not read", () => {
    expect(openBotIdentity({ path: undefined }).usage).toBeUndefined();
  });
});

describe("botAccess", () => {
  it("is blocked, not a throw, in a runtime built without serve's capabilities", () => {
    const bare = { capability: (name: string) => { throw new Error(`unknown capability: ${name}`); } };

    expect(botAccess(bare)).toEqual({ state: "blocked", reason: "absent" });
  });

  it("refuses a look-alike handle that this module did not make", () => {
    const client = octokitClient({ token: async () => "user-fixture", fetch: fakeGitHub([]) });
    const impostor = { capability: () => ({ access: () => ({ state: "ok", client }) }) };

    expect(botAccess(impostor)).toEqual({ state: "blocked", reason: "absent" });
  });
});
