import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import FileTiming, { summaryMarkdown } from "./vitest-file-timing.mjs";

const moduleAt = (path, { collect = 0, setup = 0, test = 0, tests = 1 } = {}) => ({
  project: { name: "threads" },
  moduleId: join(process.cwd(), path),
  state: () => "passed",
  children: { allTests: () => Array.from({ length: tests }, (_, i) => ({ id: `t${i}` }))[Symbol.iterator]() },
  diagnostic: () => ({ environmentSetupDuration: 1, prepareDuration: 2, collectDuration: collect, setupDuration: setup, duration: test }),
});

const git = (args) => ({ "rev-parse HEAD": "c0ffee0", "rev-parse --abbrev-ref HEAD": "feat/demo" })[args.join(" ")] ?? null;

function reporter({ env = { VITEST_FILE_TIMING: "timing.json", GITHUB_STEP_SUMMARY: "summary.md" }, loads = [0], clock } = {}) {
  const write = vi.fn();
  const append = vi.fn();
  const load = vi.fn(() => loads.shift() ?? 0);
  const fakeClock = clock ?? { setInterval: vi.fn(() => ({ unref() {} })), clearInterval: vi.fn() };
  let ms = 1_000_000;
  const now = () => (ms += 500);
  return { timing: new FileTiming({ env, git, clock: fakeClock, load, now, write, append }), write, append, clock: fakeClock, load };
}

function runRecord(options, modules = [moduleAt("a.test.ts")], reason = "passed") {
  const handles = reporter(options);
  handles.timing.onTestRunStart();
  for (const testModule of modules) handles.timing.onTestModuleEnd(testModule);
  handles.timing.onTestRunEnd([], [], reason);
  const [path, body] = handles.write.mock.calls[0] ?? [];
  return { ...handles, path, record: body && JSON.parse(body) };
}

const PR_ENV = {
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_SHA: "merge111",
  GITHUB_REF: "refs/pull/42/merge",
  GITHUB_REPOSITORY: "acme/widgets",
  GITHUB_RUN_ID: "9001",
  GITHUB_RUN_ATTEMPT: "2",
  HEAD_SHA: "head222",
  BASE_SHA: "base333",
  HEAD_REF: "feat/demo",
};

describe("the file timing reporter", () => {
  it("writes every file's collect, setup and test time to the artifact", () => {
    const { timing, write } = reporter();
    timing.onTestModuleEnd(moduleAt("products/demo/src/heavy.test.ts", { collect: 4200.4, setup: 30, test: 15 }));
    timing.onTestModuleEnd(moduleAt("products/demo/src/slow.test.ts", { collect: 80, setup: 20, test: 61000.6 }));

    timing.onTestRunEnd();

    expect(write).toHaveBeenCalledOnce();
    const [path, body] = write.mock.calls[0];
    expect(path).toBe("timing.json");
    expect(JSON.parse(body).schema).toBe("titan.test-timing/v1");
    expect(JSON.parse(body).files).toEqual([
      { project: "threads", file: "products/demo/src/heavy.test.ts", state: "passed", environmentMs: 1, prepareMs: 2, collectMs: 4200, setupMs: 30, testMs: 15, totalMs: 4245, tests: 1 },
      { project: "threads", file: "products/demo/src/slow.test.ts", state: "passed", environmentMs: 1, prepareMs: 2, collectMs: 80, setupMs: 20, testMs: 61001, totalMs: 61101, tests: 1 },
    ]);
  });

  it("puts the slowest files by each phase in the step summary", () => {
    const { timing, append } = reporter();
    timing.onTestModuleEnd(moduleAt("a.test.ts", { collect: 9000, test: 100 }));
    timing.onTestModuleEnd(moduleAt("b.test.ts", { collect: 100, test: 9000 }));

    timing.onTestRunEnd();

    const [path, markdown] = append.mock.calls[0];
    expect(path).toBe("summary.md");
    const collect = markdown.split("#### ")[1];
    const test = markdown.split("#### ")[3];
    expect(collect).toMatch(/by collect \(9\.1 s over 2 files\)/);
    expect(collect.indexOf("a.test.ts")).toBeLessThan(collect.indexOf("b.test.ts"));
    expect(test.indexOf("b.test.ts")).toBeLessThan(test.indexOf("a.test.ts"));
  });

  it("lists no more than the top count in each table", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ project: "threads", file: `f${i}.test.ts`, collectMs: i, setupMs: i, testMs: i }));

    const markdown = summaryMarkdown(rows, 3);

    expect(markdown.match(/f4\.test\.ts/g)).toHaveLength(3);
    expect(markdown).not.toContain("f1.test.ts");
  });

  it("writes the artifact but no summary outside Actions", () => {
    const { timing, write, append } = reporter({ env: { VITEST_FILE_TIMING: "timing.json" } });
    timing.onTestModuleEnd(moduleAt("a.test.ts"));

    timing.onTestRunEnd();

    expect(write).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });

  it("counts each file's tests", () => {
    const { record } = runRecord({}, [moduleAt("a.test.ts", { tests: 7 }), moduleAt("b.test.ts", { tests: 0 })]);

    expect(record.files.map((row) => row.tests)).toEqual([7, 0]);
  });

  it("records the pull request's head commit, not the merge commit GitHub tests", () => {
    const { record, path } = runRecord({ env: PR_ENV });

    expect(path).toBe("vitest-file-timing.json");
    expect(record.run).toMatchObject({
      id: "gha:9001:2:1", runner: "gha", repo: "acme/widgets", commit: "head222", mergeSha: "merge111", baseSha: "base333",
      branch: "feat/demo", pr: 42, event: "pull_request", shard: null, exit: "passed",
    });
  });

  it("samples the load average through the run and stops sampling at its end", () => {
    const { timing, clock, write } = reporter({ env: { CI: "true" }, loads: [1, 3, 8] });
    timing.onTestRunStart();
    const [sample, everyMs] = clock.setInterval.mock.calls[0];
    sample();
    sample();

    timing.onTestRunEnd([], [], "passed");

    expect(everyMs).toBe(5000);
    expect(clock.clearInterval).toHaveBeenCalledWith(clock.setInterval.mock.results[0].value);
    expect(JSON.parse(write.mock.calls[0][1]).run.load).toEqual({ start: 1, mean: 4, max: 8 });
  });

  it("writes nothing for a plain local run with no spool", () => {
    const { write } = runRecord({ env: {} });

    expect(write).not.toHaveBeenCalled();
  });

  it("spools a local run under its run id, tagged with runner and host", () => {
    const env = { TITAN_TEST_TIMING_SPOOL: "/spool", TITAN_TEST_TIMING_RUNNER: "basement-suite", TITAN_TEST_TIMING_HOST: "box" };
    const { record, path } = runRecord({ env }, undefined, "failed");

    expect(record.run).toMatchObject({ runner: "basement-suite", host: "box", commit: "c0ffee0", branch: "feat/demo", event: "local", exit: "failed" });
    expect(record.run.id).toMatch(/^basement-suite:box:\d{4}-\d\d-\d\dT[\d:.]+Z:\d+$/);
    expect(path).toBe(join("/spool", `${record.run.id.replace(/[^\w.-]+/g, "_")}.json`));
    expect(record.run.wallMs).toBeGreaterThan(0);
  });

  it("reads the scope from vitest's file filters", () => {
    const scoped = reporter({ env: { CI: "true" } });
    scoped.timing.onInit({ version: "4.1.11", filenamePattern: ["packages/demo"], config: { maxWorkers: 4 } });
    scoped.timing.onTestRunStart();
    scoped.timing.onTestRunEnd([], [], "passed");

    const run = JSON.parse(scoped.write.mock.calls[0][1]).run;
    expect(run).toMatchObject({ scope: { mode: "scoped", filters: ["packages/demo"] }, maxWorkers: 4, vitest: "4.1.11" });
  });
});
