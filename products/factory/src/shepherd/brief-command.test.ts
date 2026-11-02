import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintPrSection } from "@titan-design/decider";
import { fakeSha, successRun } from "@titan-design/github";
import { QuestionSchema, SectionSchema } from "@titan-design/review-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import type { BriefOutput } from "./brief-render.js";
import type { Registered } from "./commands.js";

const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  vi.restoreAllMocks();
});

const OWNER_BRIEF = {
  what: "Adds a widget that counts synthetic sprockets.",
  why: "It changes how every sprocket total is reported.",
  pros: ["Totals agree with the ledger."],
  cons: ["Old totals shift by one."],
  doorType: "two-way",
} as const;

const BODY = "## Summary\nCounts sprockets in one place.\n\n## Test plan\nRan the suite.";

interface World extends ShepherdFixture {
  host: FactoryHost;
  runId: string;
  brief: (args: object) => Promise<{ ok: boolean; data?: BriefOutput; error?: string }>;
}

/** An owner-gated run parked on its approve-merge gate, over a fake GitHub with one PR and two passing checks. */
async function parked(policy?: object): Promise<World> {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH, title: "Count sprockets", body: BODY });
  fixture.fake.prFiles.set(1, [{ path: "src/widget.ts", status: "added", additions: 30, deletions: 2 }, { path: "src/widget.test.ts", status: "added", additions: 12, deletions: 0 }]);
  fixture.routes.shepherd!.tasks = async () => ({ title: "Count sprockets in one place", done_when: "the widget reports one total" });
  const call = async <T>(name: string, args: unknown) => callCommand<T>(host, fixture.routes, name, args);
  const registered = await call<Registered>("shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a", ...(policy && { policy }) });
  if (!registered.ok) throw new Error(registered.error);
  const { runId } = registered.data;
  await gateOpened(host, gateId(runId, "approve-merge"));
  const brief: World["brief"] = async (args) => {
    const envelope = await call<BriefOutput>("shepherd.brief", { repo: REPO, pr: 1, ...args });
    return envelope.ok ? { ok: true, data: envelope.data } : { ok: false, error: envelope.error };
  };
  return { ...fixture, host, runId, brief };
}

/** One verdict step result, as the await-verdict step stores it; the step id's second segment is its head. */
function verdictStep(stepId: string, verdict: "MERGE" | "FIX_FIRST", reviewer: string, completedAt: string) {
  const head = stepId.split(":")[1];
  const result = { kind: "verdict", verdict, head, reviewer: { agentId: reviewer }, ownerBrief: OWNER_BRIEF };
  return { stepId, iteration: 0, agentId: null, signal: null, completedAt, data: { result } };
}

/** The run's status read with these verdict steps recorded. */
function withSteps(w: World, steps: ReturnType<typeof verdictStep>[]): void {
  const status = w.host.runtime.status.bind(w.host.runtime);
  vi.spyOn(w.host.runtime, "status").mockImplementation((id) => {
    const run = status(id);
    if (!run || id !== w.runId) return run;
    return { ...run, stepResults: { ...run.stepResults, ...Object.fromEntries(steps.map((step) => [step.stepId, step])) } };
  });
}

/** The run's status read with a recorded MERGE verdict step at this head. */
function withVerdict(w: World, head: string): void {
  withSteps(w, [verdictStep(`sh-await-verdict:${head}`, "MERGE", "rv-demo", "2026-01-02T00:00:00.000Z")]);
}

describe("shepherd.brief", () => {
  it("prints the owner section as markdown with the pending gate's rule, the verdict's owner brief, the task and CI", async () => {
    const w = await parked();
    w.fake.setRuns(H1, [successRun("validate", 1), successRun("dag-check", 2)]);
    withVerdict(w, H1);

    const envelope = await w.brief({ format: "md" });

    expect(envelope.ok).toBe(true);
    const markdown = envelope.data?.format === "md" ? envelope.data.markdown : "";
    expect(markdown).toContain("Rule `shepherd-route/failed-rounds`.");
    expect(markdown).toContain("3 review rounds failed at this task");
    expect(markdown).toContain(`head ${H1.slice(0, 7)} · +42/-2 in 2 files · CI green at head`);
    expect(markdown).toContain(OWNER_BRIEF.what);
    expect(markdown).toContain("Counts sprockets in one place.");
    expect(markdown).toContain("Task T-1: Count sprockets in one place. Done when: the widget reports one total");
    expect(markdown).toContain("- Totals agree with the ledger.");
    expect(lintPrSection(markdown)).toEqual([]);
  });

  it("prints a round@2 section and a pick-one question for the review harness", async () => {
    const w = await parked();
    withVerdict(w, H1);

    const envelope = await w.brief({ format: "round-section" });

    const data = envelope.data;
    if (data?.format !== "round-section") throw new Error(`expected round-section, got ${JSON.stringify(envelope)}`);
    expect(SectionSchema.parse(data.section).context).toContain("#### Why it reaches you");
    expect(QuestionSchema.parse(data.question)).toMatchObject({ kind: "pick-one", recommendation: { answer: "Approve merge", by: "rv-demo" } });
  });

  it("recommends changes when a panel member gave FIX_FIRST at the head beside a later MERGE", async () => {
    const w = await parked();
    w.fake.setRuns(H1, [successRun("validate", 1), successRun("dag-check", 2)]);
    withSteps(w, [
      verdictStep(`sh-await-verdict:${H1}`, "MERGE", "rv-demo", "2026-01-01T00:00:00.000Z"),
      verdictStep(`sh-await-verdict:${H1}:correctness`, "FIX_FIRST", "rv-correctness", "2026-01-02T00:00:00.000Z"),
      verdictStep(`sh-await-verdict:${H1}:adversary`, "MERGE", "rv-adversary", "2026-01-03T00:00:00.000Z"),
    ]);

    const envelope = await w.brief({ format: "round-section" });

    const data = envelope.data;
    if (data?.format !== "round-section") throw new Error(`expected round-section, got ${JSON.stringify(envelope)}`);
    expect(data.question.recommendation).toMatchObject({ answer: "Changes needed", by: "rv-correctness" });
  });

  it("reads CI as pending, not green, when a required check has no run at the head", async () => {
    const w = await parked();
    w.fake.onGetPr = (pr) => w.fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("optional-lint", 2)]);
    withVerdict(w, H1);

    const envelope = await w.brief({ format: "round-section" });

    const data = envelope.data;
    if (data?.format !== "round-section") throw new Error(`expected round-section, got ${JSON.stringify(envelope)}`);
    expect(data.section.context).toContain("CI pending at head");
    expect(data.question.recommendation?.answer).toBe("Defer");
  });

  it("says no reviewer has read the head when the run recorded no verdict", async () => {
    const w = await parked();

    const envelope = await w.brief({ format: "md" });

    expect(envelope.data).toMatchObject({ format: "md", markdown: expect.stringContaining("(not reviewed)") });
  });

  it("states an unreadable task instead of failing the brief", async () => {
    const w = await parked();
    w.routes.shepherd!.tasks = async () => Promise.reject(new Error("no task demo/T-1"));

    const envelope = await w.brief({ format: "md" });

    expect(envelope.data).toMatchObject({ markdown: expect.stringContaining("Task T-1 is unreadable: no task demo/T-1.") });
  });

  it("writes nothing to GitHub or to Shepherd", async () => {
    const w = await parked();
    withVerdict(w, H1);
    const store = w.routes.shepherd!.store.get();
    const before = { events: store.eventsOf(w.runId).length, registration: store.byRun(w.runId) };
    await new Promise((settle) => setTimeout(settle, 50));
    const effects = { ...w.fake.effects };
    const callsBefore = w.fake.calls.length;

    await w.brief({ format: "md" });
    await w.brief({ format: "round-section" });

    expect(w.fake.effects).toEqual(effects);
    expect(w.fake.calls.slice(callsBefore).filter((call) => /^(put|post|patch|delete|create|merge|update|close|rerun|push)/i.test(call))).toEqual([]);
    expect({ events: store.eventsOf(w.runId).length, registration: store.byRun(w.runId) }).toEqual(before);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.status).toBe("pending");
  });

  it("refuses a PR that is not registered", async () => {
    const w = await parked();

    expect(await w.brief({ pr: 7 })).toMatchObject({ ok: false, error: expect.stringContaining("is not registered with shepherd") });
  });

  it("adds before and after variants from the manifest for a UI PR", async () => {
    const w = await parked({ merge: "owner-gate", ownerGateReason: "gate-2-visual" });
    const dir = mkdtempSync(join(tmpdir(), "brief-images-"));
    mkdirSync(join(dir, "pr-1"));
    const shot = { story: "Widget/Default", width: "375", before: "w-before.png", after: "w-after.png" };
    writeFileSync(join(dir, "pr-1", "manifest.json"), JSON.stringify({ v: 1, repo: REPO, pr: 1, baseSha: fakeSha("base"), headSha: H1, rendered: true, shots: [shot] }));

    const envelope = await w.brief({ format: "round-section", images: dir });

    const data = envelope.data;
    if (data?.format !== "round-section") throw new Error(`expected round-section, got ${JSON.stringify(envelope)}`);
    expect(data.section.variantKeys).toEqual([join(dir, "pr-1", "w-before.png"), join(dir, "pr-1", "w-after.png")]);
  });
});
