import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkA17Report, type VitestJson } from "./report.js";

const meta = { sha: "f".repeat(40), generatedAt: "2026-10-20T12:00:00.000Z" };
const run = (...results: Array<[title: string, status: string]>): VitestJson => ({
  testResults: [{ assertionResults: results.map(([title, status]) => ({ title, fullName: title, ancestorTitles: [], status })) }],
});
const check = (json: VitestJson, notEvent: string[] = []) => checkA17Report(json, { ...meta, notEvent: notEvent.map((title) => ({ title })) });

describe("checkA17Report", () => {
  it("is ok when both modes of a case passed", () => {
    const report = check(run(["A17: a stale head read moves no epoch [webhook]", "passed"], ["A17: a stale head read moves no epoch [polling]", "passed"]));

    expect(report).toMatchObject({
      schema: "a17-report/v1",
      ...meta,
      cases: [{ title: "a stale head read moves no epoch", webhook: "passed", polling: "passed" }],
      oneMode: [],
      ok: true,
    });
  });

  it("names a case whose polling sibling was never registered and is not ok", () => {
    const report = check(run(["A17: x [webhook]", "passed"], ["A17: y [webhook]", "passed"], ["A17: y [polling]", "passed"]));

    expect(report.oneMode).toEqual(["x"]);
    expect(report.cases.find((c) => c.title === "x")).toMatchObject({ webhook: "passed", polling: "missing" });
    expect(report.ok).toBe(false);
  });

  it.each(["skipped", "todo", "pending", "failed"])("is not ok when the polling sibling is %s", (status) => {
    const report = check(run(["A17: x [webhook]", "passed"], ["A17: x [polling]", status]));

    expect(report.ok).toBe(false);
    expect(report.oneMode).toEqual(["x"]);
  });

  it("pairs siblings by their describe path as well as the title", () => {
    const json: VitestJson = {
      testResults: [
        {
          assertionResults: [
            { title: "A17: x [webhook]", fullName: "one A17: x [webhook]", ancestorTitles: ["one"], status: "passed" },
            { title: "A17: x [polling]", fullName: "two A17: x [polling]", ancestorTitles: ["two"], status: "passed" },
          ],
        },
      ],
    };

    expect(check(json).oneMode).toEqual(["x", "x"]);
  });

  it("is not ok when the run holds no A17 case, so a mistyped filter cannot pass", () => {
    expect(check(run(["unrelated", "passed"]))).toMatchObject({ cases: [], ok: false });
  });

  it("reports an allow-listed title under notEvent and does not require a sibling", () => {
    const report = check(run(["A17: a rate-limited probe never rolls back", "passed"], ["A17: x [webhook]", "passed"], ["A17: x [polling]", "passed"]), [
      "a rate-limited probe never rolls back",
    ]);

    expect(report.notEvent).toEqual(["a rate-limited probe never rolls back"]);
    expect(report.ok).toBe(true);
  });

  it("matches an allow-listed describe title that is a prefix of the full test name", () => {
    const json: VitestJson = {
      testResults: [
        { assertionResults: [{ title: "A17: probe stays quiet", fullName: "systemDeployPorts healthWithin (A17: probe stays quiet", ancestorTitles: ["systemDeployPorts healthWithin (A17: probe"], status: "passed" }] },
      ],
    };

    const report = check(json, ["systemDeployPorts healthWithin (A17:"]);

    expect(report).toMatchObject({ notEvent: ["systemDeployPorts healthWithin (A17:"], oneMode: [] });
  });

  it("matches an allow-listed describe whose cases carry no A17 prefix of their own", () => {
    const title = "systemDeployPorts healthWithin (A17: a rate-limited probe never rolls back)";
    const json: VitestJson = {
      testResults: [{ assertionResults: [{ title: "answers without a rollback", fullName: `${title} answers without a rollback`, ancestorTitles: [title], status: "passed" }] }],
    };

    expect(check(json, [title])).toMatchObject({ notEvent: [title], cases: [] });
  });

  it("treats a suffix-less A17 title outside the allow-list as a one-mode case", () => {
    const report = check(run(["A17: bypassed the helper", "passed"], ["A17: x [webhook]", "passed"], ["A17: x [polling]", "passed"]));

    expect(report.oneMode).toEqual(["bypassed the helper"]);
    expect(report.ok).toBe(false);
  });
});

describe("a17.mjs", () => {
  it("exits 1 over a fixture holding one one-mode case, and writes the report", () => {
    // Outside the factory tree, whose structure guard would otherwise see the deliberately one-mode fixture.
    const dir = mkdtempSync(join(fileURLToPath(new URL("../../../../../scripts/", import.meta.url)), "a17-smoke-"));
    try {
      writeFileSync(join(dir, "one-mode.test.mjs"), `import { it } from "vitest";\nit("A17: lonely [webhook]", () => undefined);\n`);
      mkdirSync(join(dir, "out"));
      const out = join(dir, "out", "report.json");
      const script = fileURLToPath(new URL("../../../scripts/a17.mjs", import.meta.url));

      const result = spawnSync(process.execPath, [script, "--out", out, dir], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ ok: false, oneMode: ["lonely"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
