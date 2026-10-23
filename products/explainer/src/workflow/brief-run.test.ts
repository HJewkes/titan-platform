import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAuditionModel } from "../audition-fakes.test-helpers.js";
import { fakeEdges, fakeGh, gate, HEAD, REPO, VIEW } from "../presets/pr-overview/pr-fakes.test-helpers.js";
import { runPrVideoTrigger } from "../presets/pr-overview/trigger.js";
import { briefRunStart } from "./brief-run.js";
import type { ReadAt } from "./run-gather.js";
import { fakeBridge, fakeHost, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;
afterEach(() => fx.cleanup());

/** A synthetic clone: each file at a head reads as one line naming both. */
const fakeClone: ReadAt = async (_clone, head, file) => `export const at = "${file}@${head.slice(0, 7)}";\n`;

function sweep(options: { view?: typeof VIEW } = {}) {
  const host = fakeHost(fx, fakeAuditionModel(), fakeBridge(), { gather: { prGh: fakeGh(options.view), callEdges: fakeEdges(), readAt: fakeClone } });
  const waiting = { owner: [gate()], seat: [] };
  return runPrVideoTrigger({ dataDir: fx.dataDir, readWaiting: async () => waiting, start: briefRunStart(host, (repo) => (repo === REPO ? "/clone/widgets" : undefined)) });
}

const runJson = (dir: string) => JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));

describe("a triggered decision-brief run", () => {
  it("runs the gather stage, then the audition on the facts.jsonl it gathered", async () => {
    fx = fixture();

    const [row] = await sweep();
    const run = runJson(row!.dir);

    expect(row?.outcome, run.error).toBe("started");
    expect(run.stages.filter((s: { status: string }) => s.status !== "not run")).toEqual([{ stage: "gather", status: "ran" }, { stage: "audition", status: "ran" }]);
    expect(existsSync(path.join(row!.dir, "facts.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(row!.dir, "brief.json"), "utf8"))).toMatchObject({ cut: "decision-brief", head: HEAD });
  });

  it("leaves a code artifact holding each changed file the head still has", async () => {
    fx = fixture();

    const [row] = await sweep();
    const report = JSON.parse(readFileSync(path.join(fx.dataDir, "runs", runJson(row!.dir).runId, "run-report.json"), "utf8"));
    const gather = report.rows.find((r: { stage: string }) => r.stage === "gather");
    const code = JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", gather.outputs.code), "utf8"));

    expect(Object.keys(code.files).sort()).toEqual(["docs/b.md", "src/api.ts", "src/cache.ts"]);
    expect(code.files["src/cache.ts"]).toBe(`export const at = "src/cache.ts@${HEAD.slice(0, 7)}";\n`);
  });

  it("starts each head once: a second sweep finds the brief", async () => {
    fx = fixture();
    await sweep();

    const again = await sweep();

    expect(again.map((r) => r.outcome)).toEqual(["already"]);
  });

  it("fails the gather and stops when gh reads a head other than the one the gate named", async () => {
    fx = fixture();

    const [row] = await sweep({ view: { ...VIEW, headRefOid: "b".repeat(40) } });
    const run = runJson(row!.dir);

    expect(row?.outcome).toBe("refused");
    expect(run.error).toContain("head moved");
    expect(run.stages.find((s: { stage: string }) => s.stage === "audition").status).toBe("not run");
  });

  it("refuses with E-NO-CLONE and starts no run when no clone is configured for the repo", async () => {
    fx = fixture();

    const none = await runPrVideoTrigger({
      dataDir: fx.dataDir, readWaiting: async () => ({ owner: [gate()], seat: [] }),
      start: briefRunStart(fakeHost(fx, fakeAuditionModel(), fakeBridge()), () => undefined),
    });

    expect(none.map((r) => r.outcome)).toEqual(["refused"]);
    expect(JSON.parse(readFileSync(path.join(none[0]!.dir, "gather.json"), "utf8")).diagnostics[0].code).toBe("E-NO-CLONE");
    expect(existsSync(path.join(none[0]!.dir, "run.json"))).toBe(false);
  });
});
