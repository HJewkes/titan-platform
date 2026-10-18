import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentChatSurfaces } from "./agent-chat.js";
import type { ConfigRow, ConfigSurfaces } from "./catalog.js";

const DECIDER_SECRET = "decider-key-value-19ab";
const MACHINE_SECRET = "machine-host-value-2c4d";
const PROFILE_ENV = "profile-env-value-8e31";
const MCP_ENV = "mcp-env-value-a7f0";

const CONFIG = {
  worktreeBudget: 32,
  agentSlots: 48,
  machineHeadlessAgents: 40,
  machineStopLoad5: 48,
  poolPick: "enforce",
  seatSpawnGate: "warn",
  seatStewards: { "seat-k": "steward-a" },
  decider: { agentId: "decider-a", key: DECIDER_SECRET },
  machines: { "host-b": { ssh: MACHINE_SECRET } },
};

const PROFILE = {
  name: "worker-a",
  description: "A synthetic worker",
  model: "model-a",
  allowedTools: ["Read", "Bash"],
  disallowedTools: ["WebFetch"],
  isolation: "worktree",
  env: { SERVICE_TOKEN: PROFILE_ENV },
  mcpServers: { "server-a": { command: "server-a", env: { KEY: MCP_ENV } } },
  promptPrelude: "Work in your own worktree.",
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "agent-chat-surfaces-"));
  await mkdir(path.join(root, "profiles"), { recursive: true });
  await writeFile(path.join(root, "config.json"), JSON.stringify(CONFIG, null, 2));
  await writeFile(path.join(root, "config.json.bak-20261018"), "{}");
  await writeFile(path.join(root, "profiles", "worker-a.json"), JSON.stringify(PROFILE, null, 2));
  await writeFile(path.join(root, "profiles", "worker-a.json.bak-1"), "{}");
  await writeFile(path.join(root, "ui.token"), "broker-token");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const row = (surfaces: ConfigSurfaces, surface: string, field: string): ConfigRow | undefined =>
  surfaces.rows.find((entry) => entry.surface === surface && entry.field === field);

describe("agentChatSurfaces", () => {
  it("shows config.json machine limits and each profile, skipping backups and token files", async () => {
    const surfaces = await agentChatSurfaces(root)();

    expect(surfaces.files.map((file) => [file.surface, file.inventory, file.newestBackup])).toEqual([
      ["agent-chat-config", 7, "config.json.bak-20261018"],
      ["profile:worker-a", 8, "worker-a.json.bak-1"],
    ]);
    expect(row(surfaces, "agent-chat-config", "worktreeBudget")).toMatchObject({ value: 32, line: 2, hidden: false });
    expect(row(surfaces, "agent-chat-config", "seatStewards.seat-k")?.value).toBe("steward-a");
    expect(row(surfaces, "agent-chat-config", "decider.agentId")?.value).toBe("decider-a");
    expect(row(surfaces, "profile:worker-a", "allowedTools")?.value).toEqual(["Read", "Bash"]);
  });

  it("names a profile's MCP servers without their bodies and hides its env", async () => {
    const surfaces = await agentChatSurfaces(root)();

    expect(row(surfaces, "profile:worker-a", "mcpServers")?.value).toEqual(["server-a"]);
    expect(row(surfaces, "profile:worker-a", "env")).toMatchObject({ hidden: true });
    expect(row(surfaces, "agent-chat-config", "decider.key")).toMatchObject({ hidden: true });
    expect(row(surfaces, "agent-chat-config", "machines")).toMatchObject({ hidden: true });
    const payload = JSON.stringify(surfaces);
    for (const secret of [DECIDER_SECRET, MACHINE_SECRET, PROFILE_ENV, MCP_ENV, "broker-token"]) expect(payload).not.toContain(secret);
  });

  it("answers config.json and a gap when there is no profiles dir", async () => {
    await rm(path.join(root, "profiles"), { recursive: true });

    const surfaces = await agentChatSurfaces(root)();

    expect(surfaces.gaps).toEqual([`${path.join(root, "profiles")}: not readable`]);
    expect(surfaces.files.map((file) => file.surface)).toEqual(["agent-chat-config"]);
  });
});
