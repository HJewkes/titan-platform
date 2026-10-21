import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { botAccess, openBotIdentity, type BotAccess } from "./bot-identity.js";
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

async function serveWithBot(path: string, seen: BotAccess[]): Promise<FactoryServer> {
  const server = await startFactoryServer({
    dbPath: join(scratch(), "state", "factory.sqlite3"),
    workflows: [botProbe(seen)],
    routes: NO_ROUTES,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    bot: () => openBotIdentity({ path }),
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

    expect(await botHealth(server)).toEqual({ state: "ok" });
    expect((await runProbe(server, seen))?.state).toBe("ok");
    expect(JSON.stringify(await (await fetch(`http://127.0.0.1:${server.port}/health`)).json())).not.toContain(SENTINEL);
  });
});
