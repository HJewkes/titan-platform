import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { botAccess, openBotIdentity, type BotAccess } from "./bot-identity.js";
import { BOT_FINGERPRINT_FILE, tokenFingerprint } from "./bot-token-fingerprint.js";
import { defineWorkflow } from "./definition.js";
import type { FactoryRoutes } from "./host.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";

const SENTINEL = `ghp_${"SYNTHETICsentinel".padEnd(36, "0")}`;
const NO_ROUTES: FactoryRoutes = [];
const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-serve-bot-"));
  dirs.push(dir);
  return dir;
}

function tokenFile(mode: number): string {
  const file = join(scratch(), "bot.token");
  writeFileSync(file, `${SENTINEL}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

/** A bot step in miniature: it asks the capability for the bot and records what it got. */
function botProbe(seen: BotAccess[]) {
  return defineWorkflow({
    name: "bot-probe",
    steps: [],
    run: async (ctx) => {
      seen.push(botAccess(ctx));
    },
  });
}

async function serveWithBot(path: string, seen: BotAccess[], stateDir = join(scratch(), "state"), open = () => openBotIdentity({ path })): Promise<FactoryServer> {
  const server = await startFactoryServer({
    dbPath: join(stateDir, "factory.sqlite3"),
    workflows: [botProbe(seen)],
    routes: NO_ROUTES,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    bot: open,
  });
  servers.push(server);
  return server;
}

async function botHealth(server: FactoryServer): Promise<unknown> {
  const health: unknown = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
  return z.object({ bot: z.unknown() }).parse(health).bot;
}

async function runProbe(server: FactoryServer, seen: BotAccess[]): Promise<BotAccess | undefined> {
  const runId = server.host.runtime.start("bot-probe");
  await vi.waitFor(() => expect(server.host.runtime.status(runId)?.status).toBe("completed"));
  return seen.at(-1);
}

describe("serve's bot identity (V5)", () => {
  it("starts with an absent token file, reports the bot absent, and blocks bot steps", async () => {
    const seen: BotAccess[] = [];
    const server = await serveWithBot(join(scratch(), "missing.token"), seen);

    expect(await botHealth(server)).toEqual({ state: "absent" });
    expect(await runProbe(server, seen)).toEqual({ state: "blocked", reason: "absent" });
  });

  it("starts with a mode-0644 token file, reports it refused for its mode, and blocks bot steps", async () => {
    const seen: BotAccess[] = [];
    const server = await serveWithBot(tokenFile(0o644), seen);

    expect(await botHealth(server)).toEqual({ state: "refused", problem: "mode" });
    expect(await runProbe(server, seen)).toEqual({ state: "blocked", reason: "refused" });
  });

  it("hands a readable token's client to bot steps through the capability, and /health never shows the token", async () => {
    const seen: BotAccess[] = [];
    const server = await serveWithBot(tokenFile(0o600), seen);

    expect(await botHealth(server)).toEqual({ state: "ok", expiresAt: null });
    expect((await runProbe(server, seen))?.state).toBe("ok");
    expect(JSON.stringify(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json())).not.toContain(SENTINEL);
  });
});

describe("serve's bot token expiry (V7)", () => {
  it("shows the expiry a bot response carried as /health.bot.expiresAt", async () => {
    const path = tokenFile(0o600);
    const expiring: typeof fetch = async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "github-authentication-token-expiration": "2099-01-02 03:04:05 UTC" } });
    const bot = openBotIdentity({ path, fetch: expiring, alarmed: new Set() });
    const server = await serveWithBot(path, [], join(scratch(), "state"), () => bot);

    const access = botAccess({ capability: () => bot.capabilities["github-bot"]!.handle });
    if (access.state !== "ok") throw new Error(`bot is ${access.state}`);
    await access.client.request("GET /rate_limit");

    expect(await botHealth(server)).toEqual({ state: "ok", expiresAt: "2099-01-02T03:04:05.000Z" });
  });
});

describe("serve's bot-token fingerprint for the A17 scan (V6)", () => {
  it("writes the SHA-256 of a readable token to its state dir, mode 0600", async () => {
    const stateDir = join(scratch(), "state");
    await serveWithBot(tokenFile(0o600), [], stateDir);

    const file = join(stateDir, BOT_FINGERPRINT_FILE);
    expect(readFileSync(file, "utf8")).toBe(`${tokenFingerprint(SENTINEL)}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([["absent", () => join(scratch(), "missing.token")], ["refused", () => tokenFile(0o644)]])("writes no fingerprint for an %s token and removes a stale one", async (_state, path) => {
    const stateDir = join(scratch(), "state");
    await serveWithBot(tokenFile(0o600), [], stateDir).then((server) => server.close());

    await serveWithBot(path(), [], stateDir);

    expect(existsSync(join(stateDir, BOT_FINGERPRINT_FILE))).toBe(false);
  });
});
