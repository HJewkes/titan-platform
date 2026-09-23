import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { parseFile, type ParsedFile } from "@titan-design/code-parser";
import { computeDeadCodeMetrics } from "./dead-code.js";
import { createProject, disposeProject, runIndex, type Project } from "../incremental.test-helpers.js";

const idOf = (p: string): string => p;
async function parsePy(code: string, fp = "f.py"): Promise<ParsedFile> {
  return parseFile(code, fp, "python");
}
async function metricOf(code: string, name: string): Promise<number> {
  const metrics = computeDeadCodeMetrics([await parsePy(code)], idOf);
  return metrics.find((m) => m.name === name)?.value ?? 0;
}
const lines = (...ls: string[]): string => `${ls.join("\n")}\n`;

describe("computeDeadCodeMetrics on Python — unreachable statements (TP-318)", () => {
  it("counts every statement after a return", async () => {
    const code = lines("def a():", "    return 1", "    x = 2", "    print(x)");
    expect(await metricOf(code, "unreachable_statements")).toBe(2);
  });

  it("counts code after raise, break and continue in the same block", async () => {
    const code = lines(
      "def a(xs):",
      "    for x in xs:",
      "        if x:",
      "            continue",
      "            skipped()",
      "        break",
      "        after_break()",
      "    raise ValueError()",
      "    after_raise()",
    );
    expect(await metricOf(code, "unreachable_statements")).toBe(3);
  });

  it("does not flag code after a conditional return or a trailing comment", async () => {
    const code = lines("def a(x):", "    if x:", "        return 1", "    return 2", "    # done");
    expect(computeDeadCodeMetrics([await parsePy(code)], idOf)).toEqual([]);
  });

  it("counts a def after a return, which Python does not hoist", async () => {
    const code = lines("def a():", "    return 1", "    def h():", "        return 2");
    expect(await metricOf(code, "unreachable_statements")).toBe(1);
  });
});

describe("computeDeadCodeMetrics on Python — unused locals (TP-318)", () => {
  it("counts one unused local", async () => {
    const code = lines("def k():", "    used = 1", "    dead = 2", "    return used");
    expect(await metricOf(code, "unused_locals")).toBe(1);
  });

  it("emits no rows for a clean file", async () => {
    const code = lines("X = 1", "", "def k(a):", "    b = a + X", "    b = b * 2", "    return b");
    expect(computeDeadCodeMetrics([await parsePy(code)], idOf)).toEqual([]);
  });

  it("counts a name assigned twice and never read once", async () => {
    const code = lines("def k():", "    dead = 1", "    dead = 2", "    return 0");
    expect(await metricOf(code, "unused_locals")).toBe(1);
  });

  it("does not flag a local read in a nested closure", async () => {
    const code = lines("def k():", "    x = 1", "    return lambda: x");
    expect(await metricOf(code, "unused_locals")).toBe(0);
  });

  it("skips a name also bound in a nested scope", async () => {
    const code = lines("def k():", "    x = 1", "    def g():", "        x = 2", "        return x", "    return g()");
    expect(await metricOf(code, "unused_locals")).toBe(0);
  });

  it("skips tuple unpacking, _-prefixed names and global or nonlocal names", async () => {
    const code = lines(
      "def k(t):",
      "    global g",
      "    a, b = t",
      "    _ignored = 1",
      "    g = 2",
      "    return 0",
    );
    expect(await metricOf(code, "unused_locals")).toBe(0);
  });

  it("attributes a method's unused local to the method", async () => {
    const code = lines("class C:", "    def m(self):", "        dead = 1", "        return self");
    expect(await metricOf(code, "unused_locals")).toBe(1);
  });
});

describe("computeDeadCodeMetrics on Python — unused params (TP-318)", () => {
  it("counts a trailing unused parameter but not a leading one", async () => {
    const code = lines("def f(a, b, c):", "    return b");
    expect(await metricOf(code, "unused_params")).toBe(1);
  });

  it("counts the whole trailing run, defaults and annotations included", async () => {
    const code = lines("def f(a, b: int, c=1, d: str = 'x'):", "    return a");
    expect(await metricOf(code, "unused_params")).toBe(3);
  });

  it("ignores self, cls and _-prefixed parameters", async () => {
    const code = lines(
      "class C:",
      "    def m(self):",
      "        return 1",
      "    @classmethod",
      "    def n(cls, _x):",
      "        return 2",
    );
    expect(await metricOf(code, "unused_params")).toBe(0);
  });

  it("stops the run at *args or **kwargs", async () => {
    const code = lines("def f(a, *args, b, **kwargs):", "    return 0");
    expect(await metricOf(code, "unused_params")).toBe(0);
  });

  it("does not flag the parameters of an overload, abstract or docstring-only stub", async () => {
    const code = lines(
      "@overload",
      "def f(a: int, b: int) -> int: ...",
      "def g(a, b):",
      '    """Subclasses implement this."""',
      "    raise NotImplementedError",
      "def h(a):",
      "    pass",
    );
    expect(await metricOf(code, "unused_params")).toBe(0);
  });

  it("does not flag a parameter read only in a nested closure", async () => {
    const code = lines("def f(a):", "    return lambda: a");
    expect(await metricOf(code, "unused_params")).toBe(0);
  });
});

describe("Python dead-code metrics through a full index (TP-318)", () => {
  const JOBS_PY = lines(
    "def run(job, verbose):",
    "    scratch = job.prepare()",
    "    return job.go()",
    "    job.cleanup()",
  );
  let project: Project;

  beforeEach(async () => {
    project = await createProject();
    await fs.writeFile(path.join(project.rootDir, "src/jobs.py"), JOBS_PY);
  });

  afterEach(() => disposeProject(project));

  const deadCodeRows = async (options: { incremental?: boolean }): Promise<string[]> => {
    const { snapshotId } = await runIndex(project.store, project.rootDir, options);
    return project.store
      .listMetrics(snapshotId)
      .filter((m) => m.nodeId.startsWith("src/jobs.py") && /^un/.test(m.name))
      .map((m) => `${m.nodeId} ${m.name}=${m.value}`)
      .sort();
  };

  it("writes the three counts on the Python file node and keeps them on an incremental run", async () => {
    const full = await deadCodeRows({ incremental: false });
    expect(full).toEqual([
      "src/jobs.py unreachable_statements=1",
      "src/jobs.py unused_locals=1",
      "src/jobs.py unused_params=1",
    ]);
    expect(await deadCodeRows({})).toEqual(full);
  });
});
