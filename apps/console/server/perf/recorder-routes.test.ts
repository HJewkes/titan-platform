import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeLogDir, removeDir } from "../perf-recorder.test-helpers.js";
import { createPerfRecorder } from "./recorder.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");

let logDir: string;
beforeEach(() => {
  logDir = makeLogDir();
});
afterEach(() => removeDir(logDir));

describe("route timing summary", () => {
  it("a detail route is summarised apart from its list route", async () => {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });
    recorder.recordClient([
      { kind: "route", view: "tasks", detail: false, ms: 100, queries: 2 },
      { kind: "route", view: "tasks", detail: false, ms: 300, queries: 2 },
      { kind: "route", view: "tasks", detail: true, ms: 900, queries: 3 },
    ]);

    const routes = await recorder.routes("15m");
    await recorder.close();

    expect(routes).toEqual([
      { name: "tasks", count: 2, p50: 100, p95: 300, max: 300 },
      { name: "tasks (detail)", count: 1, p50: 900, p95: 900, max: 900 },
    ]);
  });

  it("a route row reported today is read back from the log for the 24 h window", async () => {
    const recorder = createPerfRecorder({ dir: logDir, now: () => NOW });
    recorder.recordClient([{ kind: "route", view: "home", detail: false, ms: 250, queries: 1 }]);

    const routes = await recorder.routes("24h");
    await recorder.close();

    expect(routes).toEqual([{ name: "home", count: 1, p50: 250, p95: 250, max: 250 }]);
  });
});
