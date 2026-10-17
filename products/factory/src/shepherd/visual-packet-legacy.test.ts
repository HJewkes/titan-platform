import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase } from "@titan-design/store-sqlite";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";

const H2 = fakeSha("head2");
const SET = { fromHead: H1, files: [{ path: "packages/ui/__screenshots__/a.png" }] };
const VISUAL: EffectivePolicy = { ...OWNER_GATE_POLICY, ownerGateReason: "gate-2-visual", seat: "design-seat" };
const SEAT = { name: "ui", remotes: [REPO.toLowerCase()], paths: {}, grants: [], visualPaths: ["packages/ui/**"], visualBaselines: { check: "visual", paths: ["**/__screenshots__/**"] } };
const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => { try { host.close(); } catch { /* already closed */ } });
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function openHost(fake: FakeGitHub, ref: ShepherdStoreRef, phases: ShepherdPhases, dbPath: string, stuck?: string): FactoryHost {
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: tick, visualPacket: { mode: "shadow", profile: "review-packager", stateDir: tmpdir() }, seats: () => ({ seats: [SEAT], denied: [] }) });
  const hang = (route: (typeof routes)[number]) => (route.match === stuck ? { ...route, runner: { run: () => new Promise<never>(() => undefined) } } : route);
  const wired = stuck ? Object.assign(routes.map(hang), { database: routes.database, shepherd: routes.shepherd }) : routes;
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes: wired, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

const StoredRun = z.object({ step_results: z.string() });

/** Rewrites the stored record as a build from before the packet step wrote it. */
function stripPacketSteps(dbPath: string, runId: string): string[] {
  const db = openDatabase(dbPath);
  const row = StoredRun.parse(db.prepare("SELECT step_results FROM workflow_run WHERE id = ?").get(runId));
  const all = z.record(z.string(), z.unknown()).parse(JSON.parse(row.step_results));
  const kept = Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith("sh-visual-packet:")));
  db.prepare("UPDATE workflow_run SET step_results = ? WHERE id = ?").run(JSON.stringify(kept), runId);
  db.close();
  return Object.keys(all).filter((key) => key.startsWith("sh-visual-packet:"));
}

describe("a run answered on a record from before the visual packet step", () => {
  it("replays past the answered approve-merge gate and lands without recording a packet step", async () => {
    const dir = mkdtempSync(join(tmpdir(), "visual-packet-legacy-"));
    dirs.push(dir);
    const dbPath = join(dir, "factory.sqlite3");
    const fake = fakeGitHub();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, pr.headSha === H1 ? [successRun("visual", 1, undefined, "failure")] : [successRun("validate", 7), successRun("dag-check", 8), successRun("visual", 9)]);
    fake.addPr({ headSha: H1 });
    const phases: ShepherdPhases = {
      review: async (_ctx, request) => ({ kind: "MERGE", headSha: request.headSha, evidence: {} }),
      wake: async () => (fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
      visualSetCarry: () => "on",
    };
    const ref = shepherdStoreRef();
    const first = openHost(fake, ref, phases, dbPath, "merge");
    const runId = first.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: VISUAL });
    await gateOpened(first, gateId(runId, "sh-visual-accept"), 20_000);
    first.gates.resolve(gateId(runId, "sh-visual-accept"), { decision: "accept-set", headSha: H1, approvedSet: SET, note: "Commit this set." }, OWNER);
    const approve = gateId(runId, "approve-merge");
    await gateOpened(first, approve, 20_000);
    first.gates.resolve(approve, { decision: "merge", headSha: H2 }, OWNER);
    await vi.waitFor(() => expect(Object.keys(first.runtime.status(runId)?.activeSteps ?? {}).some((id) => id.startsWith("merge"))).toBe(true), { timeout: 20_000 });
    first.close();
    expect(stripPacketSteps(dbPath, runId)).not.toEqual([]);

    const second = openHost(fake, ref, phases, dbPath);
    await second.adopt();
    await vi.waitFor(() => expect(Object.keys(second.runtime.status(runId)?.stepResults ?? {})).toContain("sh-landed:0"), { timeout: 20_000 });

    const after = second.runtime.status(runId)!;
    expect(after.status).not.toBe("recovery_required");
    expect(Object.keys(after.stepResults).filter((key) => key.startsWith("sh-visual-packet:"))).toEqual([]);
  }, 60_000);
});
