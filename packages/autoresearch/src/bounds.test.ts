import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BoundsSchema, preCheck, type Bounds } from "./bounds.js";
import { changedParams, frozenOverlap, postCheck } from "./post-check.js";
import { applyOps } from "./queue.js";
import { QueueOpsSchema, TargetSchema } from "./schemas.js";
import { realDiff, type Change } from "./test-support/diff-repo.js";
import { FIXTURE_BOUNDS, FIXTURE_TARGET, proposal, SEED_FILES } from "./test-support/fake-ports.js";

const CONFIG = "src/config.json";
const GATE = "src/gate/gates.py";
const GATE_TEST = { "tests/test_gate.py": `${SEED_FILES["tests/test_gate.py"]}def test_new():\n    assert True\n` };
const config = (patch: object) => `${JSON.stringify({ ...JSON.parse(SEED_FILES[CONFIG]!), ...patch }, null, 2)}\n`;
const gateLine = (line: string) => ({ [GATE]: `${SEED_FILES[GATE]}${line}\n` });

const withBounds = (patch: (bounds: Bounds) => void): Bounds => {
  const bounds = structuredClone(FIXTURE_BOUNDS);
  patch(bounds);
  return bounds;
};

async function check(className: string, change: Change, options: { bounds?: Bounds; params?: boolean } = {}) {
  const diff = await realDiff(change);
  const paramValues = options.params ? changedParams(diff.at("base", CONFIG), diff.at("head", CONFIG)) : undefined;
  return postCheck({ idea: { class: className }, diff: diff.files, bounds: options.bounds ?? FIXTURE_BOUNDS, frozen: FIXTURE_TARGET.frozen, caseNames: ["t-alpha"], paramValues });
}

describe("bounds post-check on a real diff", () => {
  it("refuses an edit to a frozen evaluator file even inside the class's globs", async () => {
    expect((await check("accept-gate", { write: { "src/gate/measure.py": "def measure(run):\n    return -1\n", ...GATE_TEST } })).code).toBe("frozen-touch");
  });

  it("refuses an edit outside the idea's class", async () => {
    expect((await check("accept-gate", { write: { "src/planner/rank.py": "def rank(tasks):\n    return []\n", ...GATE_TEST } })).code).toBe("outside-class");
  });

  it("refuses a new file outside the class's test globs", async () => {
    expect((await check("accept-gate", { write: { "src/gate/helpers.py": "def helper():\n    return 1\n", ...GATE_TEST } })).code).toBe("new-file-outside-tests");
  });

  it("refuses a rename of a source file outside the class's test globs, but not one into a test glob", async () => {
    expect((await check("accept-gate", { rename: { [GATE]: "src/gate/accept.py" }, write: GATE_TEST })).code).toBe("new-file-outside-tests");
    expect((await check("accept-gate", { rename: { [GATE]: "tests/test_gate_accept.py" } })).code).toBeUndefined();
  });

  it("refuses a gate change with no test change, but not a config-param change", async () => {
    expect((await check("accept-gate", { write: gateLine("# stricter") })).code).toBe("no-test");
    expect((await check("config-param", { write: { [CONFIG]: config({ hot_cc: 12 }) } }, { params: true })).code).toBeUndefined();
  });

  it("refuses an added line naming a case", async () => {
    expect((await check("accept-gate", { write: { ...gateLine("# tuned on t-alpha"), ...GATE_TEST } })).code).toBe("case-name");
  });

  it("refuses a stray numeric literal in source but not an allowed one", async () => {
    expect((await check("accept-gate", { write: { ...gateLine("x = 17"), ...GATE_TEST } })).code).toBe("stray-literal");
    expect((await check("accept-gate", { write: { ...gateLine("x = 2"), ...GATE_TEST } })).code).toBeUndefined();
  });

  it("takes the allowed literals from a data-form ban", async () => {
    const bounds = withBounds((draft) => void (draft.banned.literalsOutsideConfig = { allowed: [0, 1] }));
    expect((await check("accept-gate", { write: { ...gateLine("x = 2"), ...GATE_TEST } }, { bounds })).code).toBe("stray-literal");
  });

  it("refuses a config value out of range that the proposal claimed in range", async () => {
    const claimed = proposal("raise hot", { class: "config-param", targets: [CONFIG], params: { hot_cc: 10 } });
    expect(preCheck(claimed, FIXTURE_BOUNDS, [])).toBeUndefined();
    expect((await check("config-param", { write: { [CONFIG]: config({ hot_cc: 20 }) } }, { params: true })).code).toBe("param-out-of-range");
  });

  it("refuses a fractional integer param after the diff and before any spawn", async () => {
    expect((await check("config-param", { write: { [CONFIG]: config({ hot_cc: 7.5 }) } }, { params: true })).code).toBe("param-not-integer");
    const ops = QueueOpsSchema.parse({ add: [proposal("fractional", { class: "config-param", targets: [CONFIG], params: { hot_cc: 7.5 } })] });
    const applied = applyOps([], ops, { round: 1, bounds: FIXTURE_BOUNDS, caseNames: [], deadEnds: [], seen: new Set(), lineageOf: new Map() });
    expect(applied.rejected.map((entry) => entry.code)).toEqual(["rejected:pre:param-not-integer"]);
  });

  it("matches integer params by prefix as well as by exact key", async () => {
    const bounds = withBounds((draft) => void (draft.classes["config-param"] = { ...draft.classes["config-param"]!, params: { "p5.crossings": [0, 3] }, integerParams: ["p5.*"] }));
    expect((await check("config-param", { write: { [CONFIG]: config({ p5: { crossings: 1.5 } }) } }, { bounds, params: true })).code).toBe("param-not-integer");
  });

  it("refuses a config change that removes a param", async () => {
    const removed = JSON.parse(SEED_FILES[CONFIG]!);
    delete removed.hot_cc;
    expect((await check("config-param", { write: { [CONFIG]: `${JSON.stringify(removed)}\n` } }, { params: true })).code).toBe("param-removed");
  });

  it("refuses an idea whose class the bounds do not name", async () => {
    expect((await check("unknown", { write: GATE_TEST })).code).toBe("unknown-class");
  });

  it("measures the source and test split of the diff and records every check", async () => {
    const checked = await check("accept-gate", { write: { [GATE]: "def accept(task):\n    return False\n", ...GATE_TEST } });
    expect(checked.size).toEqual({ files: 2, lines: 4, srcFiles: 1, srcLines: 2, testLines: 2 });
    expect(checked.checks.map((row) => row.name)).toEqual(["frozen-touch", "outside-class", "new-file", "test-required", "case-name", "stray-literal", "params"]);
    expect(checked.checks.every((row) => row.ok)).toBe(true);
  });
});

describe("unified diff parser", () => {
  it("reads a rename and a deletion with their old paths", async () => {
    const diff = await realDiff({ rename: { "tests/test_planner.py": "tests/test_planner_rank.py" }, write: { "src/planner/rank.py": null } });
    expect(diff.files.map(({ path, from, status, removed }) => ({ path, from, status, removed }))).toEqual([
      { path: "src/planner/rank.py", from: undefined, status: "D", removed: 2 },
      { path: "tests/test_planner_rank.py", from: "tests/test_planner.py", status: "R", removed: 0 },
    ]);
  });
});

describe("frozen overlap", () => {
  it("finds a class glob that names a frozen file", () => {
    const bounds = withBounds((draft) => void draft.classes["accept-gate"]!.paths.push("src/gate/{measure,gates}.py"));
    expect(frozenOverlap(bounds, FIXTURE_TARGET.frozen)).toEqual(["src/gate/{measure,gates}.py"]);
  });

  it("finds a wildcard class glob that reaches a frozen file only through the file list", () => {
    const bounds = withBounds((draft) => void (draft.classes["regrade"] = { paths: ["bench/suite/regrade/*.py"], tests: [], integerParams: [] }));
    const files = ["bench/suite/regrade/score.py", "src/gate/gates.py"];
    expect(frozenOverlap(bounds, ["bench/suite/regrade/**"], files)).toEqual(["bench/suite/regrade/*.py"]);
  });
});

describe("dead ends", () => {
  it("needs a non-blank differsFrom for an idea in a dead-end cell", () => {
    const deadEnds = [{ ideaId: "i-earlier", round: 1, cell: "accept-gate:retry", targets: ["src/gate/gates.py"], rungFailed: "L2" }];
    const context = { round: 2, bounds: FIXTURE_BOUNDS, caseNames: [], deadEnds, seen: new Set<string>(), lineageOf: new Map<string, string>() };
    const codes = (differsFrom?: string) => applyOps([], QueueOpsSchema.parse({ add: [proposal("retry", { differsFrom })] }), context).rejected.map((entry) => entry.code);
    expect(codes()).toEqual(["rejected:pre:dead-end"]);
    expect(codes("  ")).toEqual(["rejected:pre:dead-end"]);
    expect(codes("gates on module CC, not file CC")).toEqual([]);
  });
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "test-support", "fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

describe("a target adapter's own config", () => {
  it.each(["bounds.json", "bounds-data.json"])("parses %s with every key the engine reads", (name) => {
    const bounds = BoundsSchema.parse(fixture(name));
    expect(bounds.classes["config-param"]!.integerParams).toContain("p5.crossings");
    expect(bounds.test).toEqual({ required: true, mustFailOnBase: true, exceptClasses: ["config-param"] });
    expect(Object.keys(bounds.banned).sort()).toEqual(["frozenTouch", "literalsOutsideConfig", "newFiles", "seedNames"]);
  });

  it("parses target.json with its frozen globs and guards", () => {
    const target = TargetSchema.parse(fixture("target.json"));
    expect(target.frozen).toContain("bench/suite/gate/measure.py");
    expect(target.metric.guards).toEqual({ single_caller_delta: 1 });
    expect(frozenOverlap(BoundsSchema.parse(fixture("bounds.json")), target.frozen)).toEqual([]);
  });

  it("keeps the repo, case sets, test commands and rung templates the ports read", () => {
    const target = TargetSchema.parse(fixture("target.json"));
    expect(target).toMatchObject({ repo: "example/target", runnerRoot: ".", caseSets: { "train-1": "suite-a" } });
    expect(target.unitTests[0]).toBe("python3");
    expect(target.testProof).toContain("{head}");
    expect(Object.keys(target.rungs).sort()).toEqual(["L1-cluster", "L1-replay", "seed"]);
    expect(target.rungs.seed).toMatchObject({ maxUsd: 1, timeoutMin: 45 });
  });
});
