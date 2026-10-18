import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import { resolveConfig } from "../config.js";
import { startConsoleDaemon } from "../daemon.js";
import { closedPort, send } from "../test-support.js";
import { configSurfacesCommands, type ConfigRow, type ConfigSurfaces } from "./catalog.js";
import { AUTONOMY_DIR_UNSET, coordinatorSurfaces, type CoordinatorRoots } from "./coordinator.js";

const SEAT_SECRET = "hidden-seat-value-7f3a";
const POOL_SECRET = "hidden-pool-note-91c2";
const BURNDOWN_SECRET = "hidden-burndown-value-e04b";

const SEAT = `---
schema: autonomy-seat/v1
name: seat-k
prefix: sk
role: coordinator
pool: pool-a
overflow_pool: pool-b
config_dir: /home/user/cfg/pool-a
cwd: /home/user/work/seat-k
heartbeat_cron: "7,37 * * * *"
spend:
  per_run_points: 40
  per_day_points: 300  # restored by an operator
  per_claim_usd: 5
concurrency:
  reviewers: 6
  implementers: 20  # owner decision 446 (2026-10-18), was 12
  planners: 7
notify_secret: ${SEAT_SECRET}
share_caps: {nit: 0.2}
kind_weights: {security: 1.0}
initiatives: {init-a: 1.0}
scope_tags: [scope-a]
excluded_tags: [tag-a]
grants_extra: [grant-a]
repos:
  - {path: ~/work/repo-1, remote: org-a/repo-1}
surface: surface-k
model: model-k
effort: high
profile: profile-k
---

# seat-k

Prose the read model never parses: implementers: 99
`;

const CHARTER = `---
schema: autonomy-charter/v1
title: Synthetic charter
owner_seat: seat-k
hub: seat-k
charter_owner: seat-k
seats: [seat-k, seat-m]
human_only_initiatives: [init-x]
hard_stops: [npm-publish, deploy]
defaults:
  teleport_k: 3
  worktrees_per_repo_per_seat: 12
  kind_weights:
    security: 1.0
funds:
  monthly_usd: 100
pools:
  pool-a:
    config_dir: /home/user/cfg/pool-a
    reserve_seven_day: 10
    ceiling_five_hour: 90  # owner decision 401
    per_day_points: 500
    sonnet_band_points: 50
    dispatch_five_hour_points: 80
    note: ${POOL_SECRET}
root: /home/user/autonomy
---

# Charter
`;

const BURNDOWN = {
  enabled: true,
  reportTo: "seat-k",
  seats: ["seat-k"],
  maxAgents: 28,
  maxWorktreesPerRepo: 24,
  briefGate: { mode: "warn" },
  handReserve: { points: 10 },
  pushUrl: BURNDOWN_SECRET,
};

const WATCHDOG = {
  stopped: ["seat-m"],
  held: {},
  attended: ["seat-k"],
  pools: { "pool-a": { reading_marker: 41 } },
  lastReadings: { at: "2026-10-18T00:00:00Z" },
};

let root: string;
let roots: CoordinatorRoots;

async function writeTree(): Promise<void> {
  const autonomy = path.join(root, "autonomy");
  await mkdir(path.join(autonomy, "seats"), { recursive: true });
  await mkdir(path.join(root, "agent-chat"), { recursive: true });
  await writeFile(path.join(autonomy, "charter.md"), CHARTER);
  await writeFile(path.join(autonomy, "charter.md.bak-20261001"), CHARTER);
  await writeFile(path.join(autonomy, "charter.md.bak-20261017"), CHARTER);
  await writeFile(path.join(autonomy, "seats", "seat-k.md"), SEAT);
  await writeFile(path.join(autonomy, "seats", "seat-k.md.bak-20261018"), SEAT);
  await writeFile(path.join(root, "agent-chat", "burndown.config.json"), JSON.stringify(BURNDOWN, null, 2));
  await writeFile(path.join(root, "agent-chat", "seat-watchdog.json"), JSON.stringify(WATCHDOG, null, 2));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "config-surfaces-"));
  roots = { autonomyDir: path.join(root, "autonomy"), agentChatDir: path.join(root, "agent-chat") };
  await writeTree();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function row(surfaces: ConfigSurfaces, surface: string, field: string): ConfigRow | undefined {
  return surfaces.rows.find((entry) => entry.surface === surface && entry.field === field);
}

function shownFields(surfaces: ConfigSurfaces, surface: string): string[] {
  return surfaces.rows.filter((entry) => entry.surface === surface && !entry.hidden).map((entry) => entry.field);
}

describe("config.surfaces over the daemon's RPC", () => {
  let handle: DaemonHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  it("shows the seat's implementers cap as 20 on line 17 with decision 446 from its comment", async () => {
    const closed = String(await closedPort());
    const env = {
      TITAN_CONSOLE_STATE: path.join(root, "state"),
      TITAN_CONSOLE_PORT: "0",
      TITAN_CONSOLE_ACTIVE_WORK_PORT: closed,
      TITAN_CONSOLE_AGENT_CHAT_PORT: closed,
      TITAN_CONSOLE_FACTORY_PORT: closed,
      TITAN_CONSOLE_AUTONOMY_DIR: roots.autonomyDir ?? "",
      AGENT_CHAT_HOME: roots.agentChatDir,
    };
    handle = await startConsoleDaemon({ config: resolveConfig(env, root), logger: silentLogger });
    const host = `127.0.0.1:${handle.port}`;

    const reply = await send("127.0.0.1", handle.port, "POST", "/rpc/config.surfaces", { host, "content-type": "application/json", "x-titan-client": "test" }, "{}");

    expect(reply.status).toBe(200);
    const { data } = JSON.parse(reply.body) as { data: ConfigSurfaces };
    expect(row(data, "seat:seat-k", "concurrency.implementers")).toEqual({
      surface: "seat:seat-k",
      file: path.join(root, "autonomy", "seats", "seat-k.md"),
      field: "concurrency.implementers",
      line: 17,
      hidden: false,
      value: 20,
      comment: "owner decision 446 (2026-10-18), was 12",
      decisions: ["446"],
    });
    expect(data.gaps).toEqual([]);
  });
});

describe("coordinatorSurfaces", () => {
  it("keeps each block's values apart: concurrency reads its own lines, not spend's", async () => {
    const surfaces = await coordinatorSurfaces(roots)();

    expect(["reviewers", "implementers", "planners"].map((key) => row(surfaces, "seat:seat-k", `concurrency.${key}`)?.value)).toEqual([6, 20, 7]);
    expect(["per_run_points", "per_day_points", "per_claim_usd"].map((key) => row(surfaces, "seat:seat-k", `spend.${key}`)?.value)).toEqual([40, 300, 5]);
    expect(row(surfaces, "seat:seat-k", "spend.per_day_points")).toMatchObject({ line: 13, comment: "restored by an operator", decisions: [] });
  });

  it("shows every inventory #1, #3, #9 and #10 field the catalog declares", async () => {
    const surfaces = await coordinatorSurfaces(roots)();

    expect(shownFields(surfaces, "charter")).toEqual([
      "schema", "owner_seat", "hub", "charter_owner", "seats", "human_only_initiatives", "hard_stops",
      "defaults.teleport_k", "defaults.worktrees_per_repo_per_seat", "defaults.kind_weights.security", "funds.monthly_usd",
      ...["config_dir", "reserve_seven_day", "ceiling_five_hour", "per_day_points", "sonnet_band_points", "dispatch_five_hour_points"].map((key) => `pools.pool-a.${key}`),
    ]);
    expect(shownFields(surfaces, "seat:seat-k")).toEqual([
      "schema", "name", "prefix", "role", "pool", "overflow_pool", "config_dir", "heartbeat_cron",
      "spend.per_run_points", "spend.per_day_points", "spend.per_claim_usd", "concurrency.reviewers", "concurrency.implementers", "concurrency.planners",
      "share_caps.nit", "kind_weights.security", "initiatives.init-a", "scope_tags", "excluded_tags", "grants_extra", "repos", "surface", "model", "effort", "profile",
    ]);
    expect(shownFields(surfaces, "burndown")).toEqual(["enabled", "reportTo", "seats", "maxAgents", "maxWorktreesPerRepo", "briefGate.mode", "handReserve.points"]);
    expect(shownFields(surfaces, "seat-watchdog")).toEqual(["stopped", "held", "attended"]);
    expect(row(surfaces, "charter", "pools.pool-a.ceiling_five_hour")).toMatchObject({ value: 90, decisions: ["401"] });
    expect(row(surfaces, "seat-watchdog", "held")?.value).toEqual({});
    expect(row(surfaces, "burndown", "maxAgents")).toMatchObject({ value: 28, line: 7 });
  });

  it("lists an undeclared key as hidden, with no value anywhere in the response", async () => {
    const surfaces = await coordinatorSurfaces(roots)();
    const body = JSON.stringify(surfaces);

    expect(row(surfaces, "seat:seat-k", "notify_secret")).toEqual({ surface: "seat:seat-k", file: expect.any(String), field: "notify_secret", line: 19, hidden: true, decisions: [] });
    expect(row(surfaces, "charter", "pools.pool-a.note")).toMatchObject({ hidden: true });
    expect(row(surfaces, "seat-watchdog", "lastReadings")).toMatchObject({ hidden: true });
    for (const secret of [SEAT_SECRET, POOL_SECRET, BURNDOWN_SECRET, "/home/user/work/seat-k", "reading_marker"]) expect(body).not.toContain(secret);
  });

  it("names each file with its newest hand backup and skips backups as seats", async () => {
    const surfaces = await coordinatorSurfaces(roots)();

    expect(surfaces.files.map((file) => [file.surface, file.inventory, file.newestBackup])).toEqual([
      ["charter", 1, "charter.md.bak-20261017"],
      ["seat:seat-k", 3, "seat-k.md.bak-20261018"],
      ["burndown", 9, null],
      ["seat-watchdog", 10, null],
    ]);
  });

  it("answers the agent-chat files and one gap when no autonomy tree is configured", async () => {
    const surfaces = await coordinatorSurfaces({ ...roots, autonomyDir: null })();

    expect(surfaces.gaps).toEqual([AUTONOMY_DIR_UNSET]);
    expect(surfaces.files.map((file) => file.surface)).toEqual(["burndown", "seat-watchdog"]);
  });

  it("reports an unparsable file by error code and line without quoting its text", async () => {
    await writeFile(path.join(root, "agent-chat", "burndown.config.json"), `{\n  "pushUrl": "${BURNDOWN_SECRET}",\n  "maxAgents": [\n}`);

    const surfaces = await coordinatorSurfaces(roots)();

    const gap = surfaces.gaps.find((entry) => entry.includes("burndown.config.json"));
    expect(gap).toMatch(/not valid json \([A-Z_]+ at line \d+\)$/);
    expect(JSON.stringify(surfaces)).not.toContain(BURNDOWN_SECRET);
  });

  it("reports a missing file and a seat without front matter as gaps", async () => {
    await rm(path.join(root, "agent-chat", "seat-watchdog.json"));
    await writeFile(path.join(root, "autonomy", "seats", "seat-m.md"), "# seat-m\n");

    const surfaces = await coordinatorSurfaces(roots)();

    expect(surfaces.gaps).toEqual([`${path.join(root, "autonomy", "seats", "seat-m.md")}: no front matter`, `${path.join(root, "agent-chat", "seat-watchdog.json")}: missing`]);
  });
});

describe("configSurfacesCommands", () => {
  it("concatenates every reader's files, rows and gaps", async () => {
    const extra = async (): Promise<ConfigSurfaces> => ({ files: [], rows: [], gaps: ["other host: not reported"] });
    const command = configSurfacesCommands([coordinatorSurfaces({ ...roots, autonomyDir: null }), extra])["config.surfaces"];

    const result = await command.run({}, { warnings: [], format: "json", surface: "in-process", auth: null, ownerWrites: false });

    expect(result.gaps).toEqual([AUTONOMY_DIR_UNSET, "other host: not reported"]);
    expect(result.files).toHaveLength(2);
  });
});
