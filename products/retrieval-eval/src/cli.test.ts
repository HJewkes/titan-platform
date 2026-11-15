import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PathOptions } from "@titan-design/app-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildCli, runCli } from "./cli.js";
import { formatPairs, type EvalPair } from "./pairs.js";
import { freezeSet } from "./set.js";

describe("buildCli path defaults", () => {
  const home = "/fixture-home";

  function defaultOf(paths: PathOptions, command: string, flag: string): unknown {
    const sub = buildCli(paths).commands.find((c) => c.name() === command);
    return sub?.options.find((o) => o.long === flag)?.defaultValue;
  }

  it("moves --active-root and --graph on every verb when ACTIVE_ROOT is set", () => {
    const root = path.resolve("/srv/active");
    const paths: PathOptions = { env: { ACTIVE_ROOT: root }, home, platform: "darwin" };

    for (const command of ["mine", "run", "served"]) expect(defaultOf(paths, command, "--active-root")).toBe(root);
    for (const command of ["mine", "run"]) {
      expect(defaultOf(paths, command, "--graph")).toBe(path.join(root, ".miner", "graph.sqlite3"));
    }
  });

  it("falls back to the platform data dir when ACTIVE_ROOT is unset", () => {
    const paths: PathOptions = { env: {}, home, platform: "linux" };
    const dataRoot = path.join(home, ".local", "share", "active-work");

    expect(defaultOf(paths, "run", "--active-root")).toBe(dataRoot);
    expect(defaultOf(paths, "run", "--graph")).toBe(path.join(dataRoot, ".miner", "graph.sqlite3"));
  });
});

describe("run over a frozen set", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "retrieval-cli-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const pairs: EvalPair[] = [{ arm: "spawn", id: "a", query: "alpha", labels: [{ absolute: "/x/a.md" }], provenance: {} }];
  const snap = {
    takenAt: "2026-01-01T00:00:00.000Z",
    transcripts: 0,
    transcriptRange: {},
    graph: { path: "/g", bytes: 0, modified: "2026-01-01T00:00:00.000Z" },
    activeWorkVersion: "unavailable",
  };

  async function runJson(target: string): Promise<Array<Record<string, unknown>>> {
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const argv = ["run", target, "--candidates", "date-order-notes", "--variants", "heading-lead", "--json", "--active-root", root];
    expect(await runCli(argv)).toBe(0);
    return z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(String(out.mock.calls[0]?.[0])));
  }

  it("stamps every json row with the set id and pair count", async () => {
    const dir = path.join(root, "set");
    const manifest = freezeSet(formatPairs(pairs), dir, snap);
    const rows = await runJson(dir);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.set).toEqual({ id: manifest.id, pairs: 1 });
  });

  it("adds no set field when given a plain pair file", async () => {
    const file = path.join(root, "pairs.jsonl");
    writeFileSync(file, formatPairs(pairs));
    const rows = await runJson(file);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).not.toHaveProperty("set");
  });

  it("exits 1 when the frozen pairs were edited", async () => {
    const dir = path.join(root, "set");
    freezeSet(formatPairs(pairs), dir, snap);
    const file = path.join(dir, "pairs.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace("alpha", "alphb"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCli(["run", dir, "--candidates", "date-order-notes"])).toBe(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("does not match manifest");
  });
});

describe("runCli enum options", () => {
  afterEach(() => vi.restoreAllMocks());

  async function failure(argv: string[]): Promise<{ code: number; message: string }> {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const code = await runCli(argv);
    return { code, message: errors.mock.calls.map((call) => String(call[0])).join("\n") };
  }

  it("rejects an unknown mine --arm and names the allowed arms", async () => {
    const { code, message } = await failure(["mine", "--arm", "spwan"]);
    expect(code).toBe(1);
    expect(message).toContain("spawn, bootstrap, both");
  });

  it("rejects an unknown run --variants and names the allowed variants", async () => {
    const { code, message } = await failure(["run", "pairs.jsonl", "--variants", "bogus"]);
    expect(code).toBe(1);
    expect(message).toContain("heading-lead, top-df");
  });

  it("lists the weekly verb", () => {
    expect(buildCli().commands.map((c) => c.name())).toContain("weekly");
  });

  it("rejects a malformed weekly --week", async () => {
    const { code, message } = await failure(["weekly", "--week", "2026-46"]);
    expect(code).toBe(1);
    expect(message).toContain("--week must look like YYYY-Www");
  });

  it("rejects an unknown run --candidates and names the allowed candidates", async () => {
    const { code, message } = await failure(["run", "pairs.jsonl", "--candidates", "bogus"]);
    expect(code).toBe(1);
    expect(message).toContain("date-order-notes, active-work-search, notes-fts, hybrid-fts-vector, hybrid-bge-small");
  });

  it("rejects an unknown run --embedder and names the allowed backends", async () => {
    const { code, message } = await failure(["run", "pairs.jsonl", "--candidates", "hybrid-fts-vector", "--embedder", "bogus"]);
    expect(code).toBe(1);
    expect(message).toContain("--embedder must be one of hash, ollama, local, got bogus");
  });
});
