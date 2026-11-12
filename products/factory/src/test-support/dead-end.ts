import type { StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow } from "../definition.js";
import { DEAD_END_KINDS, DEAD_END_STEPS, deadEndAddressRoute, deadEndGate } from "../shepherd/dead-end.js";
import { replanRoute } from "../shepherd/replan.js";
import type { ReplanPorts } from "../shepherd/spawn-ports.js";
import { liveRow } from "./registrant-routing.js";
import { AWAIT_HEAD_STEPS } from "../workflows/await-head.js";
import { codeRoute, step } from "../workflows/land.js";

/** The synthetic seat a dead-end gate is addressed to unless a test names none. */
export const DEAD_END_SEAT = "tc-synthetic";

const Params = z.object({
  ...{ heads: z.array(z.string()), kind: z.enum(DEAD_END_KINDS), waivable: z.boolean().optional() },
  ...{ sessions: z.array(z.object({ agent: z.string(), sessionId: z.string().optional() })).optional(), trail: z.array(z.string()).optional() },
  failing: z.array(z.object({ name: z.string() })).optional(),
});

/**
 * A stand-in for shepherd-pr that reaches a dead end at each head in turn: once a gate's respawn sees a new head, the next
 * head asks again, and an outcome is recorded as `sh-stopped`. `heads`, `kind`, `waivable` and a ci-red exit's `failing`
 * arrive as the JSON `deadEnd` param; the PR is the run's `repo` and `pr`.
 */
export const deadEndWorkflow = defineWorkflow({
  name: "shepherd-pr",
  steps: [...DEAD_END_STEPS, ...AWAIT_HEAD_STEPS, { id: "sh-seat-notice", kind: "dispatch" }, { id: "sh-stopped", kind: "dispatch" }],
  run: async (ctx) => {
    const { heads, kind, waivable, sessions, trail, failing } = Params.parse(JSON.parse(ctx.param("deadEnd")!));
    const replan = { task: "synthetic/T-1", ...(sessions && { sessions }), ...(trail && { trail }) };
    const run = { ctx, target: { repo: ctx.param("repo")!, pr: Number(ctx.param("pr")) }, state: { waits: 0 } };
    for (const headSha of heads) {
      const outcome = await deadEndGate(run, { kind, headSha, situation: "the fixer exited without pushing a new head", ...(waivable && { waivable }), ...(failing && { red: failing }), ...replan }, async () => undefined);
      if (outcome) return void (await step(ctx, "sh-stopped", outcome, z.unknown()));
    }
  },
});

const stubAbandon = codeRoute("sh-abandon", () => 0, async (input: { headSha: string }) => ({ outcome: "closed", task: "no-task", headSha: input.headSha }));

/** The routes a test swaps in: its own `sh-abandon` route, and the spawn port a replan answer uses. */
interface DeadEndOverrides {
  abandon?: StepRoute;
  replan?: ReplanPorts;
}

/**
 * The address step names `seat` (none when null), the seat notice goes out and records its `why` as its detail, a wait for
 * a new head returns at once, an abandon reads as closed, and a replan spawns through no port unless a test passes one.
 */
export function deadEndRoutes(seat: string | null = DEAD_END_SEAT, { abandon = stubAbandon, replan }: DeadEndOverrides = {}): StepRoute[] {
  const now = (): number => 0;
  return [
    abandon,
    deadEndAddressRoute(now, { lineage: () => undefined, roster: async () => (seat === null ? [] : [liveRow(seat)]), repoSeat: () => seat ?? undefined }),
    codeRoute("sh-seat-notice", now, async (input: { why: string }) => ({ sent: true, detail: input.why })),
    replanRoute({ now, ...(replan && { replan }) }),
    codeRoute("sh-stopped", now, async (outcome: object) => outcome),
    codeRoute("await-new-head", now, async (input: { headSha: string }) => ({ headSha: `${input.headSha.slice(0, 39)}f`, state: "open" })),
  ];
}

/** The `deadEnd` param of one stand-in run. */
export const deadEndParam = (heads: readonly string[], kind: (typeof DEAD_END_KINDS)[number] = "exited-without-push", waivable = false, replan: Pick<z.infer<typeof Params>, "sessions" | "trail" | "failing"> = {}): string =>
  JSON.stringify({ heads, kind, ...(waivable && { waivable }), ...replan });
