import path from "node:path";
import type { PathOptions } from "@titan-design/app-paths";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCli, runCli } from "./cli.js";

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

  it("rejects an unknown run --candidates and names the allowed candidates", async () => {
    const { code, message } = await failure(["run", "pairs.jsonl", "--candidates", "bogus"]);
    expect(code).toBe(1);
    expect(message).toContain("date-order-notes, active-work-search, notes-fts, hybrid-fts-vector");
  });
});
