import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha } from "@titan-design/github";
import type { GateResolver } from "@titan-design/hitl";
import type { StepRoute } from "@titan-design/workflow";
import { expect, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { factoryContext } from "../registry.js";
import { TEST_BRIEF } from "../test-support/brief.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import { restartDivergedRuns } from "./diverged-sweep.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { SHEPHERD_WORKFLOW } from "./services.js";

const hosts: FactoryHost[] = [];
export const closers: Array<() => Promise<void>> = [];

export async function closeDeploys(): Promise<void> {
  hosts.splice(0).forEach((host) => host.close());
  await Promise.all(closers.splice(0).map((close) => close()));
}

export const HEAD_B = H1;
export const HEAD_A = fakeSha("head-a");
const STEPS = [
  { id: "ci-wait", kind: "dispatch" },
  { id: "park-here", kind: "dispatch" },
  { id: "extra-ask", kind: "assisted" },
] as const;

/** Build N reads CI then waits; build N+1 asks a question before the recorded ci-wait. */
export function build(asksFirst: boolean): WorkflowDefinition {
  return defineWorkflow({
    name: SHEPHERD_WORKFLOW,
    steps: STEPS,
    run: async (ctx) => {
      if (asksFirst) {
        const brief = { summary: "A question the old build never asked.", evidenceRef: "$ gh pr view 1" };
        await ctx.assisted("extra-ask", "Ask?", { schema: z.object({ ok: z.literal(true) }), brief });
      }
      await ctx.dispatch("ci-wait", "ci-wait");
      await ctx.dispatch("park-here", "park-here");
    },
  });
}

const stubRoutes: StepRoute[] = [
  { match: "ci-wait", onRestart: "repeat", runner: { run: () => Promise.resolve({ ok: true, output: JSON.stringify({ result: { headSha: HEAD_A } }) }) } },
  { match: "park-here", onRestart: "repeat", runner: { run: () => new Promise(() => undefined) } },
];

export interface Deploy extends ShepherdFixture {
  host: FactoryHost;
  routes: FactoryRoutes;
}

export function deploy(dbPath: string, definition: WorkflowDefinition): Deploy {
  const fixture = shepherdFixture();
  const routes = Object.assign([...stubRoutes], { shepherd: fixture.routes.shepherd, database: fixture.routes.database, bindHost: fixture.routes.bindHost }) as FactoryRoutes;
  const host = openFactoryHost({ dbPath, workflows: [definition], routes, gatePollMs: 5 });
  hosts.push(host);
  return { ...fixture, routes, host };
}

const branchOf = (pr: number): string => `${BRANCH}-${pr}`;
export const ctxOf = (next: Deploy) => factoryContext(next.host, next.routes, "agent");

/** Registered runs recorded on build N, one per pull request number; nothing adopts them yet. */
export async function recorded(dbPath: string, prs: number[], base?: string): Promise<string[]> {
  const first = deploy(dbPath, build(false));
  const ids = prs.map((pr) => first.host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: String(pr), branch: branchOf(pr), policy: JSON.stringify(OWNER_GATE_POLICY), task: "demo/T-1" }));
  for (const id of ids) await vi.waitFor(() => expect(first.host.runtime.status(id)?.stepResults).toHaveProperty(["ci-wait:0"]));
  const store = first.routes.shepherd!.store.get();
  const facts = { repo: REPO, task: "demo/T-1", implementer: "impl-a", kind: "feature" as const, policy: OWNER_GATE_POLICY, ...(base !== undefined && { base }) };
  prs.forEach((pr, i) => store.register({ ...facts, pr, branch: branchOf(pr), runId: ids[i]! }));
  first.host.close();
  return ids;
}

export interface Parked {
  next: Deploy;
  dbPath: string;
  oldRunIds: string[];
}

/** Registered runs parked by strictReplay when build N+1 adopts them. */
export async function parkedRuns(prs: number[] = [1], prState: "open" | "closed" = "open", base?: string): Promise<Parked> {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tp2697b-")), "factory.db");
  const oldRunIds = await recorded(dbPath, prs, base);
  const next = deploy(dbPath, build(true));
  prs.forEach((pr) => next.fake.addPr({ headSha: HEAD_B, headRef: branchOf(pr), state: prState }));
  await next.host.adopt();
  for (const id of oldRunIds) await next.host.runtime.wait(id);
  return { next, dbPath, oldRunIds };
}

export const OWNER: GateResolver = { class: "owner-terminal", id: "owner", channel: "factory-cli" };
export const landPrompt = (head: string, base = "main", table = "authority"): string => `Merge PR #1 in ${REPO} at head ${head} into ${base}? CI is green. Policy ${table}/MRG-OW: owner gate`;

export interface Answered extends Parked {
  runId: string;
  gateId: string;
}

/** A diverged run the sweep kept for its land gate, then answered by `resolver` while it stays parked. */
export async function answeredWhileParked(payload: Record<string, unknown> | undefined, prompt = landPrompt(HEAD_B), resolver = OWNER): Promise<Answered> {
  const parked = await parkedRuns();
  const runId = parked.oldRunIds[0]!;
  const gateId = `${runId}/approve-merge`;
  parked.next.host.gates.create({ id: gateId, prompt, ...TEST_BRIEF });
  expect((await restartDivergedRuns(ctxOf(parked.next))).kept).toEqual([{ runId, gateId }]);
  if (payload) parked.next.host.runtime.signal(runId, "approve-merge", payload, resolver);
  return { ...parked, runId, gateId };
}

