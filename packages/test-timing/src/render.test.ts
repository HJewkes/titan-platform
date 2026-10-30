import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { timingArtifact, timingFile } from "./fixtures.test-helpers.js";
import { renderReportMarkdown, renderSlowerMarkdown } from "./render.js";
import { slowerSince, timingReport } from "./report.js";
import { ingestArtifact, openTimingStore } from "./store.js";

let db: Db;
beforeEach(() => {
  db = openTimingStore(":memory:");
  for (let index = 0; index < 7; index += 1) {
    const testMs = index >= 4 ? 3000 : 1000;
    const startedAt = new Date(Date.parse("2026-01-01T00:00:00Z") + index * 3_600_000).toISOString();
    ingestArtifact(db, timingArtifact({ id: `gha:${index}:1:1`, event: "push", startedAt }, [timingFile({ collectMs: 0, setupMs: 0, testMs, totalMs: testMs })]));
  }
});
afterEach(() => db.close());

describe("renderReportMarkdown", () => {
  it("lists a grown file with its baseline, current level and the run where the rise began", () => {
    const markdown = renderReportMarkdown(timingReport(db, { now: Date.parse("2026-01-02T00:00:00Z") }));

    expect(markdown).toContain("| file | gha-4c | unit | packages/example/src/a.test.ts | 1.0 | 3.0 | +2.0 | +200.0% | aaaaaaaaa |");
    expect(markdown).toContain("## Project trends");
  });

  it("says none when nothing grew", () => {
    db.prepare("UPDATE files SET total_ms = 1000").run();

    expect(renderReportMarkdown(timingReport(db))).toMatch(/## Growth[^\n]*\n\nNone\./);
  });
});

describe("renderSlowerMarkdown", () => {
  it("names the cut and lists each slower series", () => {
    const markdown = renderSlowerMarkdown(slowerSince(db, Date.parse("2026-01-01T04:00:00Z")), "abc1234");

    expect(markdown.split("\n")[0]).toBe("# Slower since abc1234");
    expect(markdown).toContain("| suite | gha-4c | - | - | 1.0 | 3.0 | +2.0 | +200.0% | 3 |");
  });
});
