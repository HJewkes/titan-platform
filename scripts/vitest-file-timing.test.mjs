import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import FileTiming, { summaryMarkdown } from "./vitest-file-timing.mjs";

const moduleAt = (path, { collect = 0, setup = 0, test = 0 } = {}) => ({
  project: { name: "threads" },
  moduleId: join(process.cwd(), path),
  state: () => "passed",
  diagnostic: () => ({ environmentSetupDuration: 1, prepareDuration: 2, collectDuration: collect, setupDuration: setup, duration: test }),
});

function reporter({ summary = "summary.md" } = {}) {
  const write = vi.fn();
  const append = vi.fn();
  return { timing: new FileTiming({ out: "timing.json", summary, write, append }), write, append };
}

describe("the file timing reporter", () => {
  it("writes every file's collect, setup and test time to the artifact", () => {
    const { timing, write } = reporter();
    timing.onTestModuleEnd(moduleAt("products/demo/src/heavy.test.ts", { collect: 4200.4, setup: 30, test: 15 }));
    timing.onTestModuleEnd(moduleAt("products/demo/src/slow.test.ts", { collect: 80, setup: 20, test: 61000.6 }));

    timing.onTestRunEnd();

    expect(write).toHaveBeenCalledOnce();
    const [path, body] = write.mock.calls[0];
    expect(path).toBe("timing.json");
    expect(JSON.parse(body).files).toEqual([
      { project: "threads", file: "products/demo/src/heavy.test.ts", state: "passed", environmentMs: 1, prepareMs: 2, collectMs: 4200, setupMs: 30, testMs: 15 },
      { project: "threads", file: "products/demo/src/slow.test.ts", state: "passed", environmentMs: 1, prepareMs: 2, collectMs: 80, setupMs: 20, testMs: 61001 },
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
    const { timing, write, append } = reporter({ summary: "" });
    timing.onTestModuleEnd(moduleAt("a.test.ts"));

    timing.onTestRunEnd();

    expect(write).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
  });
});
