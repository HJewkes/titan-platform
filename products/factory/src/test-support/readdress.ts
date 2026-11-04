import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { DEAD_END_KINDS, DEAD_END_STEPS, deadEndRule, readdressEscalation, type DeadEndKind } from "../shepherd/dead-end.js";
import { LeaveLand, untilLeft } from "../shepherd/leave-land.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import { fixFirstEscalation, type Escalated } from "../shepherd/route-table.js";
import type { ShepherdServices } from "../shepherd/services.js";
import { supersedingGates } from "../shepherd/stale-gates.js";
import { shepherdStoreRef, type ShepherdStore } from "../shepherd/store.js";
import { factoryRoutesFor } from "../workflows.js";
import { AWAIT_HEAD_STEPS } from "../workflows/await-head.js";
import { sleep } from "../workflows/land.js";
import { TEST_BRIEF } from "./brief.js";
import { DEAD_END_SEAT, deadEndRoutes } from "./dead-end.js";
import { rosterOf, servicesOf } from "./dead-end-route.js";
import { H1, REPO } from "./land.js";
import { liveRow } from "./registrant-routing.js";

/** The live seat that registered each synthetic PR whose gate names a registrant. */
export const SHAPE_SEAT = "tc-shape-seat";

const GateParams = z.object({ step: z.enum(["sh-sent-back", "approve-merge"]), prompt: z.string(), ruled: z.enum(DEAD_END_KINDS).optional() });

/** A stand-in for a shepherd-pr run paused on one owner gate, whose step and prompt the test gives, and the dead-end rule it carries if any. */
const gateShapeWorkflow = defineWorkflow({
  name: "shepherd-pr",
  steps: [{ id: "sh-sent-back", kind: "assisted" }, { id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const { step, prompt, ruled } = GateParams.parse({ step: ctx.param("step"), prompt: ctx.param("prompt"), ruled: ctx.param("ruled") });
    await ctx.assisted(step, prompt, { brief: TEST_BRIEF, ...(ruled !== undefined && { rule: deadEndRule(ruled) }) });
  },
});

interface GateShape {
  step: "sh-sent-back" | "approve-merge";
  prompt: string;
  /** Who registered the PR; none records no registrant, as before registrants were recorded. */
  registrant?: string;
  /** The dead-end rule the gate carries; none is a rule-less owner gate. */
  ruled?: DeadEndKind;
}

interface ShapeWorld {
  host: FactoryHost;
  services: ShepherdServices;
  store: ShepherdStore;
}

/** A host whose roster shows SHAPE_SEAT live and no single seat owns the repo. */
export function shapeWorld(): ShapeWorld {
  const ref = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fakeGitHub().wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), roster: rosterOf([liveRow(SHAPE_SEAT)]) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [gateShapeWorkflow], routes, gatePollMs: 5 });
  onTestFinished(() => host.close());
  return { host, services: servicesOf(routes), store: ref.get() };
}

/** Starts one run on PR `pr` paused on `shape`'s gate. */
export function openShape({ host, store }: ShapeWorld, pr: number, shape: GateShape): string {
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(pr), step: shape.step, prompt: shape.prompt, ...(shape.ruled && { ruled: shape.ruled }) });
  store.register({ repo: REPO, pr, runId, task: `demo/${pr}`, implementer: `impl-${pr}`, policy: OWNER_GATE_POLICY, ...(shape.registrant && { registrant: shape.registrant }) });
  return runId;
}

const exitPrompt = (kind: string, pr: number, head: string, unsent = ""): string =>
  `The ${kind} wake of PR #${pr} in ${REPO} at head ${head} ended: impl-${pr} exited without pushing a new head past ${head}${unsent}. Await a new head or abandon?`;

/** Land's approve-merge prompt under a policy row. */
const approvePrompt = (pr: number, head: string, row: string): string => `Merge PR #${pr} in ${REPO} at head ${head}? CI is green. Policy ${row}: a synthetic reason`;

/** The eleven pending dead-end owner gates TP-4759 found, as synthetic shapes: five fix-proof exits, three ci-red exits where no single seat owns the repo, two runaways registered before registrants were, and one failed-rounds. */
export function elevenShapes(): GateShape[] {
  const head = (n: number): string => fakeSha(`readdress-shape-${n}`);
  const fixProof = [1, 2, 3, 4, 5].map((n) => ({ step: "sh-sent-back" as const, prompt: exitPrompt("fix-proof", n, head(n)), registrant: SHAPE_SEAT }));
  const ciRed = [6, 7, 8].map((n) => ({ step: "sh-sent-back" as const, prompt: exitPrompt("ci-red", n, head(n), ` (no single seat owns ${REPO})`), registrant: SHAPE_SEAT }));
  const runaways = [9, 10].map((n) => ({ step: "approve-merge" as const, prompt: approvePrompt(n, head(n), "shepherd-route/fix-first-runaway") }));
  return [...fixProof, ...ciRed, ...runaways, { step: "approve-merge", prompt: approvePrompt(11, head(11), "shepherd-route/failed-rounds"), registrant: SHAPE_SEAT }];
}

/** Owner gates that are no dead end, each registered by a live seat: the verb must leave every one of them alone. */
export function otherShapes(): GateShape[] {
  const head = (n: number): string => fakeSha(`readdress-other-${n}`);
  const approve = (n: number, row: string): GateShape => ({ step: "approve-merge", prompt: approvePrompt(n, head(n), row), registrant: SHAPE_SEAT });
  return [
    approve(21, "authority/MRG-AU"),
    approve(22, "shepherd-merge-guard/ci-policy-weakened"),
    approve(23, "shepherd-route/no-progress"),
    approve(24, "shepherd-route/conflict"),
    { ...approve(25, "shepherd-route/failed-rounds"), ruled: "failed-rounds" },
    { step: "sh-sent-back", prompt: `The ci-red wake of PR #26 in ${REPO} at head ${head(26)} ended: no fixer could start. Await a new head or abandon?`, registrant: SHAPE_SEAT },
  ];
}

const ESCALATIONS = {
  "fix-first-runaway": fixFirstEscalation(3, 0, H1)!,
  "failed-rounds": { escalation: "failed-rounds", detail: `the last at ${H1} ended with an external hold` },
} satisfies Record<string, Escalated>;

const RouteParams = z.object({ escalation: z.enum(["fix-first-runaway", "failed-rounds"]) });

/**
 * A stand-in for shepherd-pr paused on a pre-TP-4759 route approve-merge at H1, asked through Shepherd's own superseding
 * wrapper, so a readdressed cancel takes the run's real path to the seat.
 */
const readdressRouteWorkflow = defineWorkflow({
  name: "shepherd-pr",
  steps: [...DEAD_END_STEPS, ...AWAIT_HEAD_STEPS, { id: "sh-seat-notice", kind: "dispatch" }, { id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const { escalation } = RouteParams.parse({ escalation: ctx.param("escalation") });
    const target = { repo: ctx.param("repo")!, pr: Number(ctx.param("pr")) };
    const run = { ctx, target, state: { waits: 0 }, escalations: new Map([[H1, ESCALATIONS[escalation]]]) };
    const assisted = supersedingGates(ctx, () => new LeaveLand(), undefined, (gated, reask) => readdressEscalation(run, gated, reask));
    await untilLeft(async () => {
      await assisted("approve-merge", approvePrompt(target.pr, H1, `shepherd-route/${escalation}`), { brief: TEST_BRIEF });
      return undefined;
    });
  },
});

/** A run paused on the owner's route approve-merge, registered by DEAD_END_SEAT, whose address step names that seat. */
export function routeShapeWorld(escalation: "fix-first-runaway" | "failed-rounds"): ShapeWorld & { runId: string } {
  const ref = shepherdStoreRef();
  const factory = factoryRoutesFor({ port: githubPort(fakeGitHub().wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), roster: rosterOf([liveRow(DEAD_END_SEAT)]) });
  // The stand-in's own routes, over the factory's store tenant, so the registration and the verb's services share one database.
  const routes = Object.assign(deadEndRoutes(), { database: factory.database });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [readdressRouteWorkflow], routes, gatePollMs: 5 });
  const services = servicesOf(factory);
  onTestFinished(() => host.close());
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", escalation });
  ref.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, registrant: DEAD_END_SEAT });
  return { host, services, store: ref.get(), runId };
}
