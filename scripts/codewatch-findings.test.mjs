import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FINDINGS_SCHEMA_ID, THRESHOLDS, rankFindings, runCli } from "./codewatch-findings.mjs";

const roots = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

const fileRow = (path, overrides = {}) => ({
  path,
  role: "source",
  loc: 100,
  cyclomatic_max: 3,
  cognitive_max: 3,
  nesting_max: 1,
  importers: 0,
  public_symbols: 1,
  private_symbols: 0,
  ...overrides,
});
const symbolRow = (path, symbol, overrides = {}) => ({
  path,
  symbol,
  exported: true,
  line: 1,
  loc: 20,
  cyclomatic_max: 3,
  cognitive_max: 3,
  nesting_max: 1,
  importers: 0,
  ...overrides,
});
const artifact = ({ files = [], symbols = [], indexVersion = "0.18.0", commit = "a".repeat(40) } = {}) => ({
  schema: "codewatch-metrics@1",
  commit,
  indexVersion,
  notes: {},
  files,
  symbols,
});
const oneSymbol = (overrides) => artifact({ files: [fileRow("src/a.ts")], symbols: [symbolRow("src/a.ts", "run", overrides)] });
const byKey = (report, key) => report.findings.find((f) => f.key === key);
const KEY = "tp|cognitive-hotspot|src/a.ts|run#1";

describe("rankFindings statuses", () => {
  it("marks a hit absent from the previous artifact new and scores it with the 1.5 bonus", () => {
    const report = rankFindings(oneSymbol({ cognitive_max: 30, importers: 10 }), oneSymbol({ cognitive_max: 10 }), { repo: "tp" });

    expect(byKey(report, KEY)).toMatchObject({ status: "new", score: 2.7, est: 1, rules: ["cognitive-hotspot"] });
    expect(report.rebaseline).toBe(false);
  });

  it("marks a hit up by at least 10% worsened and one up by less persisting", () => {
    const previous = oneSymbol({ cognitive_max: 30 });

    const worsened = rankFindings(oneSymbol({ cognitive_max: 33 }), previous, { repo: "tp" });
    const persisting = rankFindings(oneSymbol({ cognitive_max: 32 }), previous, { repo: "tp" });

    expect(byKey(worsened, KEY)).toMatchObject({ status: "worsened", score: 1.716, previous_metrics: { cognitive_max: 30 } });
    expect(byKey(persisting, KEY)).toMatchObject({ status: "persisting", score: 1.28 });
  });

  it("lists a cleared or deleted symbol as resolved with score 0 after every live row", () => {
    const previous = artifact({
      files: [fileRow("src/a.ts")],
      symbols: [symbolRow("src/a.ts", "gone", { nesting_max: 6 }), symbolRow("src/a.ts", "fixed", { cognitive_max: 40 })],
    });
    const current = artifact({
      files: [fileRow("src/a.ts")],
      symbols: [symbolRow("src/a.ts", "fixed", { cognitive_max: 12 }), symbolRow("src/a.ts", "hot", { cognitive_max: 25 })],
    });

    const report = rankFindings(current, previous, { repo: "tp" });

    expect(report.findings.map((f) => [f.key, f.status, f.score])).toEqual([
      ["tp|cognitive-hotspot|src/a.ts|hot#1", "new", 1.5],
      ["tp|cognitive-hotspot|src/a.ts|fixed#1", "resolved", 0],
      ["tp|nesting-at-budget|src/a.ts|gone#1", "resolved", 0],
    ]);
    expect(byKey(report, "tp|nesting-at-budget|src/a.ts|gone#1").metrics).toEqual({ loc: null, cyclomatic_max: null, cognitive_max: null, nesting_max: null });
    expect(report.top).toEqual(["tp|cognitive-hotspot|src/a.ts|hot#1"]);
  });

  it("marks every row rebaseline when the indexVersions differ, with no bonus, no resolved row and no file rule", () => {
    const previous = artifact({ indexVersion: "0.17.0", files: [fileRow("src/a.ts")], symbols: [symbolRow("src/a.ts", "old", { cognitive_max: 50 })] });
    const current = artifact({
      files: [fileRow("src/a.ts", { loc: 400 })],
      symbols: [symbolRow("src/a.ts", "run", { cognitive_max: 30 }), symbolRow("src/a.ts", "deep", { nesting_max: 5 })],
    });

    const report = rankFindings(current, previous, { repo: "tp" });

    expect(report.rebaseline).toBe(true);
    expect(report.previous).toMatchObject({ indexVersion: "0.17.0" });
    expect(report.findings.map((f) => [f.key, f.status, f.score])).toEqual([
      ["tp|cognitive-hotspot|src/a.ts|run#1", "rebaseline", 1.2],
      ["tp|nesting-at-budget|src/a.ts|deep#1", "rebaseline", 1],
    ]);
  });

  it("treats a missing previous artifact as a rebaseline", () => {
    const report = rankFindings(oneSymbol({ cognitive_max: 30 }), null, { repo: "tp" });

    expect(report.previous).toBeNull();
    expect(report.rebaseline).toBe(true);
    expect(byKey(report, KEY).status).toBe("rebaseline");
  });
});

describe("rankFindings rows", () => {
  it("skips test, barrel and generated files and their symbols", () => {
    const current = artifact({
      files: ["test", "barrel", "generated"].map((role) => fileRow(`src/${role}.ts`, { role, loc: 900 })),
      symbols: ["test", "barrel", "generated"].map((role) => symbolRow(`src/${role}.ts`, "big", { cognitive_max: 90 })),
    });

    expect(rankFindings(current, artifact(), { repo: "tp" }).findings).toEqual([]);
  });

  it("reads a null cyclomatic_max as no function, never as a zero to compare against", () => {
    const previous = artifact({ files: [fileRow("src/a.ts", { cyclomatic_max: null })], symbols: [symbolRow("src/a.ts", "run", { cyclomatic_max: null })] });
    const current = oneSymbol({ cyclomatic_max: 26 });

    const report = rankFindings(current, previous, { repo: "tp" });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ key: "tp|cyclomatic-near-budget|src/a.ts|run#1", status: "new" });
    expect(report.findings[0].previous_metrics.cyclomatic_max).toBeNull();
  });

  it("numbers same-named symbols in one file by line order and diffs each against its own ordinal", () => {
    const rows = (first, second) => [symbolRow("src/a.ts", "get", { line: 80, ...second }), symbolRow("src/a.ts", "get", { line: 10, ...first })];
    const previous = artifact({ files: [fileRow("src/a.ts")], symbols: rows({ cognitive_max: 30 }, { cognitive_max: 30 }) });
    const current = artifact({ files: [fileRow("src/a.ts")], symbols: rows({ cognitive_max: 30 }, { cognitive_max: 40 }) });

    const report = rankFindings(current, previous, { repo: "tp" });

    expect(report.findings.map((f) => [f.key, f.line, f.status])).toEqual([
      ["tp|cognitive-hotspot|src/a.ts|get#2", 80, "worsened"],
      ["tp|cognitive-hotspot|src/a.ts|get#1", 10, "persisting"],
    ]);
  });

  it("lists a symbol with several rule hits once, keyed by its highest-scoring rule", () => {
    const report = rankFindings(oneSymbol({ cognitive_max: 26, cyclomatic_max: 30, nesting_max: 5 }), oneSymbol({}), { repo: "tp" });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      key: "tp|cyclomatic-near-budget|src/a.ts|run#1",
      rules: ["cognitive-hotspot", "cyclomatic-near-budget", "nesting-at-budget"],
      score: 1.875,
    });
  });

  it("flags a file at the loc threshold only when it is new or worsened", () => {
    const files = (a, b, c) => [fileRow("src/a.ts", { loc: a }), fileRow("src/b.ts", { loc: b }), fileRow("src/c.ts", { loc: c, importers: 20 })];

    const report = rankFindings(artifact({ files: files(300, 400, 340) }), artifact({ files: files(290, 360, 320) }), { repo: "tp" });

    expect(report.findings.map((f) => [f.key, f.status, f.est, f.symbol, f.line])).toEqual([
      ["tp|file-near-loc-budget|src/b.ts|", "worsened", 2, null, null],
      ["tp|file-near-loc-budget|src/a.ts|", "new", 2, null, null],
    ]);
    expect(report.thresholds).toEqual(THRESHOLDS);
  });
});

describe("rankFindings top", () => {
  it("sorts by score, then path, then symbol", () => {
    const current = artifact({
      files: [fileRow("src/a.ts"), fileRow("src/b.ts")],
      symbols: [symbolRow("src/b.ts", "x", { cognitive_max: 50 }), symbolRow("src/b.ts", "a", { nesting_max: 5 }), symbolRow("src/a.ts", "z", { nesting_max: 5 })],
    });

    const keys = rankFindings(current, null, { repo: "tp" }).findings.map((f) => f.key);

    expect(keys).toEqual(["tp|cognitive-hotspot|src/b.ts|x#1", "tp|nesting-at-budget|src/a.ts|z#1", "tp|nesting-at-budget|src/b.ts|a#1"]);
  });

  it("holds at most 6 keys for the one repo, at most 2 of them file-rule rows", () => {
    const fat = ["f1", "f2", "f3"].map((name) => fileRow(`src/${name}.ts`, { loc: 900 }));
    const hot = Array.from({ length: 8 }, (_, i) => symbolRow("src/s.ts", `s${i}`, { cognitive_max: 30 - i }));
    const current = artifact({ files: [...fat, fileRow("src/s.ts")], symbols: hot });

    const report = rankFindings(current, artifact(), { repo: "tp" });

    expect(report.top).toEqual([
      "tp|file-near-loc-budget|src/f1.ts|",
      "tp|file-near-loc-budget|src/f2.ts|",
      "tp|cognitive-hotspot|src/s.ts|s0#1",
      "tp|cognitive-hotspot|src/s.ts|s1#1",
      "tp|cognitive-hotspot|src/s.ts|s2#1",
      "tp|cognitive-hotspot|src/s.ts|s3#1",
    ]);
    expect(report.findings).toHaveLength(9);
  });
});

describe("runCli", () => {
  function tempDir() {
    const root = mkdtempSync(join(tmpdir(), "codewatch-findings-"));
    roots.push(root);
    return root;
  }
  function writeJson(dir, name, value) {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify(value));
    return { file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  }

  it("writes codewatch-findings@1 with both inputs' content hashes", () => {
    const dir = tempDir();
    const current = writeJson(dir, "current.json", oneSymbol({ cognitive_max: 30 }));
    const previous = writeJson(dir, "previous.json", oneSymbol({}));
    const out = join(dir, "findings.json");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runCli(["--repo", "tp", "--current", current.file, "--previous", previous.file, "--previous-sha256", previous.sha256, "--out", out]);

    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(code).toBe(0);
    expect(report).toMatchObject({ schema: FINDINGS_SCHEMA_ID, repo: "tp", top: [KEY] });
    expect(report.current.sha256).toBe(current.sha256);
    expect(report.previous.sha256).toBe(previous.sha256);
  });

  it("exits 2 without writing when the previous file's content does not match --previous-sha256", () => {
    const dir = tempDir();
    const current = writeJson(dir, "current.json", oneSymbol({}));
    const previous = writeJson(dir, "previous.json", oneSymbol({}));
    const out = join(dir, "findings.json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = runCli(["--repo", "tp", "--current", current.file, "--previous", previous.file, "--previous-sha256", "0".repeat(64), "--out", out]);

    expect(code).toBe(2);
    expect(existsSync(out)).toBe(false);
    expect(error.mock.calls[0][0]).toContain(`has sha256 ${previous.sha256}, but --previous-sha256 pins ${"0".repeat(64)}`);
  });

  it("exits 2 on a missing pin, a missing --repo or an input of another schema", () => {
    const dir = tempDir();
    const current = writeJson(dir, "current.json", oneSymbol({}));
    const other = writeJson(dir, "other.json", { schema: "codewatch-pr-report@1" });
    const out = join(dir, "findings.json");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(runCli(["--repo", "tp", "--current", current.file, "--previous", current.file, "--out", out])).toBe(2);
    expect(runCli(["--current", current.file, "--out", out])).toBe(2);
    expect(runCli(["--repo", "tp", "--current", other.file, "--out", out])).toBe(2);
    expect(existsSync(out)).toBe(false);
  });
});
