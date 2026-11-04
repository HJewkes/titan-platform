import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { onTestFinished } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { GATE_DEMOTIONS } from "../shepherd/auto-pass.js";
import { DEAD_END_STEPS } from "../shepherd/dead-end.js";
import { freshFailedRounds } from "../shepherd/failed-rounds-demotion.js";
import { untilLeft } from "../shepherd/leave-land.js";
import type { ShepherdPhases, Verdict, WakeOutcome } from "../shepherd/phases.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import type { ExitNoticePorts, RosterReader } from "../shepherd/ports.js";
import { shepherdPrWorkflow } from "../shepherd/pr.js";
import type { ShepherdServices } from "../shepherd/services.js";
import { fixFirstEscalation, type Escalated } from "../shepherd/route-table.js";
import { routeEscalation } from "../shepherd/routed.js";
import { askAtHead } from "../shepherd/stale-gates.js";
import { shepherdStoreRef, type ShepherdStore } from "../shepherd/store.js";
import { factoryRoutesFor } from "../workflows.js";
import { AWAIT_HEAD_STEPS } from "../workflows/await-head.js";
import { sleep } from "../workflows/land.js";
import { TEST_BRIEF } from "./brief.js";
import { H1, REPO, outsideActions } from "./land.js";
import { liveRow } from "./registrant-routing.js";

/** The seat that registered the PR; it holds a live session unless a world's roster leaves it out. */
export const REGISTRANT = "tc-registrant";

/** Sets TP-4759's seat route for the running test alone; production has it on since S5. */
export function deadEndSeatOn(on = true): void {
  const before = GATE_DEMOTIONS.deadEndSeat;
  GATE_DEMOTIONS.deadEndSeat = on;
  onTestFinished(() => void (GATE_DEMOTIONS.deadEndSeat = before));
}

const exited: WakeOutcome = { kind: "unhandled", exited: true, reason: `impl-a exited without pushing a new head past ${H1}`, wake: { agent: "impl-a", mode: "resume" } };

/** The fixer woken at H1 exits with no push: after a red CI there, or after the fix-proof of a NO_REPRO. */
function exitedAt(kind: "ci-red" | "fix-proof"): ShepherdPhases {
  const merge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });
  const noRepro: Verdict = { kind: "NO_REPRO", headSha: H1, result: { verdict: "vacuous" } };
  return { wake: async () => exited, review: async (_ctx, request) => (kind === "fix-proof" && request.headSha === H1 ? noRepro : merge(request.headSha)) };
}

interface ExitOptions {
  kind: "ci-red" | "fix-proof";
  roster?: readonly AgentRow[];
  hubSeat?: string;
  dbPath?: string;
}

interface ExitWorld {
  host: FactoryHost;
  store: ShepherdStore;
  fake: FakeGitHub;
  sends: string[];
  services: ShepherdServices;
}

/** A roster that always reads `rows`. */
export function rosterOf(rows: readonly AgentRow[]): RosterReader {
  return { read: async () => ({ kind: "known", rows: [...rows] }), rows: async () => [...rows], invalidate: () => undefined };
}

/** No single seat owns the repo, as for titan-design; the registrant's lineage is the only way to a seat. */
export function exitWorld({ kind, roster = [liveRow(REGISTRANT)], hubSeat, dbPath = ":memory:" }: ExitOptions, fake = fakeGitHub()): ExitWorld {
  const red = kind === "ci-red" ? "failure" : "success";
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [outsideActions(successRun("validate", 1, undefined, pr.headSha === H1 ? red : "success")), successRun("dag-check", 2)]);
  const sends: string[] = [];
  const exitNotice: ExitNoticePorts = { seatFor: () => undefined, hubSeat: () => hubSeat, lastReport: async () => undefined, send: async (seat) => void sends.push(seat) };
  const ref = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal), roster: rosterOf(roster), exitNotice });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(exitedAt(kind))], routes, gatePollMs: 5 });
  onTestFinished(() => host.close());
  return { host, store: ref.get(), fake, sends, services: routes.shepherd };
}

export function startExit({ host, store, fake }: ExitWorld): string {
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, registrant: REGISTRANT });
  return runId;
}

const ESCALATIONS = {
  "fix-first-runaway": fixFirstEscalation(3, 0, H1)!,
  "failed-rounds": { escalation: "failed-rounds", detail: `the last at ${H1} ended with an external hold` },
} satisfies Record<string, Escalated>;

const RouteParams = z.object({ escalation: z.enum(["fix-first-runaway", "failed-rounds"]) });

/**
 * A stand-in for shepherd-pr whose one round at H1 escalates: Shepherd's own escalation route runs, and where it goes on to
 * the merge decision the owner's approve-merge opens, as land's would.
 */
export const routeWorkflow = defineWorkflow({
  name: "shepherd-pr",
  steps: [...DEAD_END_STEPS, ...AWAIT_HEAD_STEPS, { id: "sh-seat-notice", kind: "dispatch" }, { id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const { escalation } = RouteParams.parse({ escalation: ctx.param("escalation") });
    const target = { repo: ctx.param("repo")!, pr: Number(ctx.param("pr")) };
    const run = { ctx, target, state: { waits: 0 }, reviews: new Map(), fresh: new Set<string>(), escalations: new Map(), fixFirstTrail: [], ...freshFailedRounds() };
    await untilLeft(async () => {
      if (await routeEscalation(run, H1, ESCALATIONS[escalation])) await askAtHead(ctx, "approve-merge", `Merge PR #${target.pr} in ${target.repo} at head ${H1}?`, { brief: TEST_BRIEF });
      return undefined;
    });
  },
});
