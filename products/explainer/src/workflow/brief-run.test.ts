import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAuditionModel } from "../audition-fakes.test-helpers.js";
import { fakeEdges, fakeGh, gate, HEAD, REPO, VIEW } from "../presets/pr-overview/pr-fakes.test-helpers.js";
import { runPrVideoTrigger } from "../presets/pr-overview/trigger.js";
import { BRIEF_LAST_STAGE, briefRunStart } from "./brief-run.js";
import { STAGES } from "./records.js";
import type { ReadAt } from "./run-gather.js";
import { fakeBridge, fakeBriefModels, fakeHost, fixture, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture;

/** A synthetic clone: each file at a head reads as one line naming both. */
const fakeClone: ReadAt = async (_clone, head, file) => `export const at = "${file}@${head.slice(0, 7)}";\n`;

function sweep(options: { view?: typeof VIEW; models?: ReturnType<typeof fakeBriefModels> } = {}) {
  const models = options.models ?? fakeBriefModels();
  const host = fakeHost(fx, models, fakeBridge(), { gather: { prGh: fakeGh(options.view), callEdges: fakeEdges(), readAt: fakeClone } });
  const waiting = { owner: [gate()], seat: [] };
  return runPrVideoTrigger({ dataDir: fx.dataDir, readWaiting: async () => waiting, start: briefRunStart(host, (repo) => (repo === REPO ? "/clone/widgets" : undefined)) });
}

const runJson = (dir: string) => JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));

describe("the decision brief's stage list", () => {
  it("stops at the script stage, before any stage that spends again or needs the renderer", () => {
    expect(STAGES.slice(0, STAGES.indexOf(BRIEF_LAST_STAGE) + 1)).toEqual(["gather", "audition", "script"]);
  });
});

describe("a triggered decision-brief run", () => {
  afterEach(() => fx.cleanup());

  it("runs gather, the audition on the facts.jsonl it gathered, then the script on the audition's spine", async () => {
    fx = fixture();

    const [row] = await sweep();
    const run = runJson(row!.dir);

    expect(row?.outcome, run.error).toBe("started");
    expect(run.stages.filter((s: { status: string }) => s.status !== "not run")).toEqual([
      { stage: "gather", status: "ran" }, { stage: "audition", status: "ran" }, { stage: "script", status: "ran" },
    ]);
    expect(existsSync(path.join(row!.dir, "facts.jsonl"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(row!.dir, "brief.json"), "utf8"))).toMatchObject({ cut: "decision-brief", head: HEAD });
  });

  it("hands the script model the audition pick as its story spine", async () => {
    fx = fixture();
    const models = fakeBriefModels();

    const [row] = await sweep({ models });
    const report = JSON.parse(readFileSync(path.join(fx.dataDir, "runs", runJson(row!.dir).runId, "run-report.json"), "utf8"));
    const audition = report.rows.find((r: { stage: string }) => r.stage === "audition");
    const { pick } = JSON.parse(readFileSync(path.join(fx.dataDir, "artifacts", audition.outputs.audition), "utf8"));

    expect(models.script.prompts[0]).toContain(`# Story spine: pr-overview-${pick.structure}`);
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
