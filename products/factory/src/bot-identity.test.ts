import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { octokitClient, sharedRateBudget } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { BOT_CAPABILITY, BOT_TOKEN_PATH, openBotIdentity, type BotHandle, type BotIdentity } from "./bot-identity.js";
import { runCommand } from "./service-ports.js";

/** Built, not written out, so no source line carries a token-shaped literal. */
const SENTINEL = `ghp_${"SYNTHETICsentinel".padEnd(36, "0")}`;
const HOUR_S = 3600;
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
function fakeGitHub(seen: Seen[], status = 200, remaining = 4999): typeof fetch {
  return async (_url, init) => {
    seen.push({ authorization: new Headers(init?.headers).get("authorization") });
    const reset = Math.floor(Date.now() / 1000) + HOUR_S;
    const headers = { "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(remaining), "x-ratelimit-used": "1", "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core" };
    return new Response(JSON.stringify(status === 200 ? {} : { message: "API rate limit exceeded" }), { status, headers });
  };
}

const handle = (bot: BotIdentity): BotHandle => bot.capabilities[BOT_CAPABILITY]!.handle;

function okClient(bot: BotIdentity) {
  const access = handle(bot).access();
  if (access.state !== "ok") throw new Error(`bot is ${access.state}`);
  return access.client;
}

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

  it("the module reaches GitHub only through octokitClient: no gh wire, no GH_TOKEN, no process env", () => {
    const source = readFileSync(fileURLToPath(new URL("./bot-identity.ts", import.meta.url)), "utf8");
    const github = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"@titan-design\/github";/g)].flatMap(([, names = ""]) => names.split(",").map((name) => name.trim().replace(/^type\s+/, "")));

    expect(github.filter((name) => name !== "").sort()).toEqual(["GitHubClient", "octokitClient", "parseGitHubToken", "rateBudget"]);
    expect(source).not.toMatch(/GH_TOKEN|process\.env|child_process|ghCliWire|execGh/);
  });
});

describe("bot identity: its own throttle and budget (V4)", () => {
  it("a bot near its rate floor leaves the HJewkes budget untouched and the HJewkes client free", async () => {
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

describe("bot identity: an absent or refused file disables only the bot (V5)", () => {
  it("ships with no token path, so serve looks nowhere until the option slice fills it", () => {
    expect(BOT_TOKEN_PATH).toBeUndefined();
    expect(openBotIdentity().health()).toEqual({ state: "absent" });
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

    expect(bot.health()).toEqual({ state: "ok" });
    expect(bot.capabilities[BOT_CAPABILITY]!.secrets).toEqual([SENTINEL]);
  });
});
