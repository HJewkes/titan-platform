import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigRow, ConfigSurfaces } from "./catalog.js";
import { coordinatorSurfaces } from "./coordinator.js";
import { configDriftCommands, deriveDrift, type DuplicateRow } from "./drift.js";
import { hostSurfaceRootsFrom, hostSurfaces } from "./host.js";

interface Caps {
  claudeMd: number;
  charter: number;
  worktreeBudget: number;
  maxWorktreesPerRepo: number;
}

let home: string;

async function write(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(path.join(home, file)), { recursive: true });
  await writeFile(path.join(home, file), body);
}

/** A synthetic host whose four worktree-cap copies hold the given values. */
async function writeHost(caps: Caps): Promise<void> {
  await write("CLAUDE.md", `# Rules\n\nWorktrees: (${caps.claudeMd} per repo, two kept free)\n`);
  await write("autonomy/charter.md", `---\nschema: autonomy-charter/v1\ndefaults:\n  worktrees_per_repo_per_seat: ${caps.charter}\n---\n# Charter\n`);
  await write("autonomy/seats/seat-k.md", "---\nschema: autonomy-seat/v1\nconcurrency:\n  implementers: 28\n---\n# seat-k\n");
  await write(".agent-chat/config.json", JSON.stringify({ worktreeBudget: caps.worktreeBudget, machineStopLoad5: 48 }, null, 2));
  await write(".agent-chat/burndown.config.json", JSON.stringify({ seats: ["seat-k"], maxAgents: 28, maxWorktreesPerRepo: caps.maxWorktreesPerRepo }, null, 2));
  await write(".config/titan-factory/config.json", JSON.stringify({ shepherd: { spawnGate: { load5: 48 } } }));
}

function driftCommand() {
  const readers = [coordinatorSurfaces({ autonomyDir: path.join(home, "autonomy"), agentChatDir: path.join(home, ".agent-chat") }), ...hostSurfaces(hostSurfaceRootsFrom({}, home))];
  return configDriftCommands(readers)["config.drift"];
}

async function driftRows(caps: Caps): Promise<DuplicateRow[]> {
  await writeHost(caps);
  return (await driftCommand().run({}, { warnings: [], format: "json" })).rows;
}

const worktreeRow = (rows: readonly DuplicateRow[]): DuplicateRow | undefined => rows.find((row) => row.id === "worktrees-per-repo");

function shown(surface: string, field: string, value: unknown): ConfigRow {
  return { surface, file: `/cfg/${surface}`, field, line: 3, hidden: false, value, decisions: [] };
}

const surfacesOf = (rows: ConfigRow[]): ConfigSurfaces => ({ files: [], rows, gaps: [] });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "config-drift-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("config.drift", () => {
  it("shows the four worktree caps as one drift row listing every source with its file and line", async () => {
    const rows = await driftRows({ claudeMd: 12, charter: 12, worktreeBudget: 32, maxWorktreesPerRepo: 24 });

    expect(worktreeRow(rows)).toEqual({
      id: "worktrees-per-repo",
      label: "Worktree cap per repo",
      status: "drift",
      values: [12, 32, 24],
      sources: [
        { surface: "claude-md", field: "worktreesPerRepo", file: path.join(home, "CLAUDE.md"), line: 3, value: 12 },
        { surface: "charter", field: "defaults.worktrees_per_repo_per_seat", file: path.join(home, "autonomy", "charter.md"), line: 4, value: 12 },
        { surface: "agent-chat-config", field: "worktreeBudget", file: path.join(home, ".agent-chat", "config.json"), line: 2, value: 32 },
        { surface: "burndown", field: "maxWorktreesPerRepo", file: path.join(home, ".agent-chat", "burndown.config.json"), line: 6, value: 24 },
      ],
      absent: [],
    });
    expect(rows.filter((row) => row.status === "drift").map((row) => row.id)).toEqual(["worktrees-per-repo"]);
  });

  it("finds no drift when every copy holds the same value, and lists the agreeing duplicates", async () => {
    const rows = await driftRows({ claudeMd: 12, charter: 12, worktreeBudget: 12, maxWorktreesPerRepo: 12 });

    expect(rows.filter((row) => row.status === "drift")).toEqual([]);
    expect(rows.map((row) => [row.id, row.status, row.values])).toEqual([
      ["worktrees-per-repo", "agree", [12]],
      ["load-hold", "agree", [48]],
      ["implementers:seat-k", "agree", [28]],
    ]);
  });

  it("flags a lone copy that moved even when the first copies agree", async () => {
    const rows = await driftRows({ claudeMd: 12, charter: 12, worktreeBudget: 12, maxWorktreesPerRepo: 24 });

    expect(worktreeRow(rows)).toMatchObject({ status: "drift", values: [12, 24] });
  });
});

describe("deriveDrift", () => {
  it("is drift on a three-way mismatch where two of the three copies are equal", () => {
    const rows = deriveDrift(surfacesOf([shown("charter", "defaults.worktrees_per_repo_per_seat", 12), shown("agent-chat-config", "worktreeBudget", 12), shown("burndown", "maxWorktreesPerRepo", 24)]));

    expect(worktreeRow(rows)).toMatchObject({ status: "drift", values: [12, 24], absent: [{ surface: "claude-md", field: "worktreesPerRepo" }] });
  });

  it("makes no row for a value held in only one file, and never compares a hidden copy", () => {
    const hidden: ConfigRow = { surface: "burndown", file: "/cfg/burndown", field: "maxWorktreesPerRepo", line: 2, hidden: true, decisions: [] };

    const rows = deriveDrift(surfacesOf([shown("agent-chat-config", "worktreeBudget", 32), hidden]));

    expect(rows).toEqual([]);
  });

  it("pairs the implementer cap with maxAgents only while the burndown roster names one seat", () => {
    const seatRows = [shown("seat:seat-k", "concurrency.implementers", 28), shown("seat:seat-m", "concurrency.implementers", 6), shown("burndown", "maxAgents", 20)];

    const alone = deriveDrift(surfacesOf([...seatRows, shown("burndown", "seats", ["seat-k"])]));
    const shared = deriveDrift(surfacesOf([...seatRows, shown("burndown", "seats", ["seat-k", "seat-m"])]));

    expect(alone.map((row) => [row.id, row.status, row.values])).toEqual([["implementers:seat-k", "drift", [28, 20]]]);
    expect(shared).toEqual([]);
  });

  it("lists drift rows before agreeing ones", () => {
    const rows = deriveDrift(
      surfacesOf([
        shown("agent-chat-config", "worktreeBudget", 12),
        shown("burndown", "maxWorktreesPerRepo", 12),
        shown("agent-chat-config", "machineStopLoad5", 48),
        shown("factory-config", "shepherd.spawnGate.load5", 40),
      ]),
    );

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["load-hold", "drift"],
      ["worktrees-per-repo", "agree"],
    ]);
  });
});
