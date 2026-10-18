import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as OsModule from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestAuth } from "@titan-design/daemon";
import { invokeCommand, type CommandRegistry } from "@titan-design/registry";
import { resolveConfig } from "./config.js";
import type { ClassedCommand, ConsoleContext } from "./owner-guard.js";
import { createConsoleRegistry } from "./registry.js";
import { closedPort } from "./test-support.js";
import { createSources } from "./upstreams.js";

/**
 * Agents must never change their own caps or permissions, so the only console route that may
 * write a config surface is an owner-write command. Both checks walk the registry the daemon
 * serves, so a command added anywhere is covered without editing this file.
 */

// A worker thread's HOME stub never reaches libuv, so `os.homedir()` would still name the real home.
const sandbox = vi.hoisted(() => ({ home: null as string | null }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof OsModule>();
  const homedir = () => sandbox.home ?? actual.homedir();
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const CONFIG_NAMESPACE = "config.";
/** Verbs that only read or prepare a change; any other `config.*` command must be owner-write. */
const NON_WRITING_CONFIG_VERBS = new Set(["surfaces", "prepare"]);

// Synthetic config surfaces, one per kind the console reads or will edit.
const FIXTURE_FILES: Record<string, string> = {
  ".agent-chat/config.json": JSON.stringify({ worktreeBudget: 4, agentSlots: 6 }),
  ".agent-chat/burndown.config.json": JSON.stringify({ enabled: true, seats: ["seat-k"], maxAgents: 3 }),
  ".agent-chat/seat-watchdog.json": JSON.stringify({ stopped: [], held: [], attended: ["seat-k"] }),
  ".config/titan-factory/config.json": JSON.stringify({ spawnGate: { load5: 8 } }),
  ".config/titan-coordinator/coordinator.json": JSON.stringify({ schema: "titan-coordinator/v1", seats: {} }),
  ".claude/settings.json": JSON.stringify({ permissions: { allow: [] } }),
  "autonomy/charter.md": "---\nschema: autonomy-charter/v1\nseats: [seat-k]\n---\n# charter\n",
  "autonomy/seats/seat-k.md": "---\nschema: autonomy-seat/v1\nconcurrency:\n  implementers: 2\n---\n# seat-k\n",
};

const SESSION_AUTH: RequestAuth = { credential: "session", issuedAt: 1_000, peerLocal: false };

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "console-config-writers-"));
  for (const [file, body] of Object.entries(FIXTURE_FILES)) {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), body);
  }
  sandbox.home = home;
  vi.stubEnv("HOME", home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
});

afterEach(async () => {
  sandbox.home = null;
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/** The daemon's registry over the synthetic home, with every upstream on a port nothing listens on. */
async function servedRegistry(): Promise<CommandRegistry<ConsoleContext>> {
  const closed = String(await closedPort());
  const env = {
    TITAN_CONSOLE_PORT: "0",
    TITAN_CONSOLE_STATE: path.join(home, "state"),
    TITAN_CONSOLE_ACTIVE_WORK_PORT: closed,
    TITAN_CONSOLE_AGENT_CHAT_PORT: closed,
    TITAN_CONSOLE_FACTORY_PORT: closed,
    TITAN_CONSOLE_AUTONOMY_DIR: path.join(home, "autonomy"),
    AGENT_CHAT_HOME: path.join(home, ".agent-chat"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  return createConsoleRegistry(createSources(resolveConfig(env, home)));
}

function classed(registry: CommandRegistry<ConsoleContext>): ClassedCommand[] {
  return registry.list() as ClassedCommand[];
}

/** The widest context a request can carry, so a deposit runs as it would on the LAN. */
function ownerSessionContext(): ConsoleContext {
  return { warnings: [], format: "json", surface: "http", auth: SESSION_AUTH, ownerWrites: true };
}

/** Every file under the synthetic home with its bytes; a created, changed or removed file shows. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const bodies = await Promise.all(files.map(async (file) => [path.relative(dir, file), await readFile(file, "utf8")] as const));
  return Object.fromEntries(bodies.sort(([a], [b]) => a.localeCompare(b)));
}

describe("config-writing console commands are owner-write", () => {
  it("walks a registry that serves reads, a deposit and an owner-write", async () => {
    const classes = new Set(classed(await servedRegistry()).map((command) => command.commandClass));

    expect([...classes].sort()).toEqual(["deposit", "owner-write", "read"]);
  });

  it("classes every config.* command owner-write unless its verb only reads", async () => {
    const commands = classed(await servedRegistry()).filter((command) => command.name.startsWith(CONFIG_NAMESPACE));

    const unguarded = commands
      .filter((command) => command.commandClass !== "owner-write")
      .filter((command) => !NON_WRITING_CONFIG_VERBS.has(command.name.slice(CONFIG_NAMESPACE.length)))
      .map((command) => `${command.name} (${command.commandClass})`);

    expect(unguarded).toEqual([]);
  });

  it("leaves every config file unchanged after each read and deposit that runs with no arguments", async () => {
    const runnable = classed(await servedRegistry())
      .filter((command) => command.commandClass !== "owner-write")
      .filter((command) => command.args.safeParse({}).success);
    const writers: string[] = [];

    for (const command of runnable) {
      const before = await snapshot(home);
      await invokeCommand(command, {}, ownerSessionContext());
      if (JSON.stringify(await snapshot(home)) !== JSON.stringify(before)) writers.push(`${command.name} (${command.commandClass})`);
    }

    expect(runnable.map((command) => command.name)).toContain("upstreams.health");
    expect(writers).toEqual([]);
  });
});
