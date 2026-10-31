import type {
  LimitsClaim,
  LimitsClock,
  LimitsLedger,
  LimitsPlanInput,
  LimitsPoolReading,
  LimitsSeatInput,
  LimitsShepherdInput,
} from "./report-input.js";
import { bindingOf, firstRefusalPerTask, isBookkeeping, planBlockedSplit, refusalKinds } from "./report-refusals.js";
import type {
  ContradictionReport,
  LimitsReport,
  LimitsRole,
  PoolReport,
  RoleReport,
  SeatReport,
  ShepherdReport,
  SupplyReport,
  WorktreesReport,
} from "./report-schema.js";

const ROLE_OF_PHASE: Readonly<Record<string, LimitsRole>> = {
  planning: "planners",
  implementing: "implementers",
  reviewing: "reviewers",
};

const MINUTE_MS = 60_000;

interface SeatContext {
  claims: readonly LimitsClaim[];
  live: ReadonlySet<string>;
  stamped: boolean;
  now: Date;
}

/** A spawning claim counts toward the role it lands in. */
const roleOf = (claim: LimitsClaim): LimitsRole | undefined =>
  ROLE_OF_PHASE[claim.phase === "spawning" ? (claim.nextPhase ?? "spawning") : claim.phase];

/** CC-1098: a claim holds its slot while spawning, while its agent may run, or while a respawn is under way. */
const holdsSlot = (claim: LimitsClaim, live: ReadonlySet<string>): boolean =>
  claim.phase === "spawning" ||
  claim.respawn !== undefined ||
  (claim.agentName !== undefined && live.has(claim.agentName));

const dispositionOf = (claim: LimitsClaim, stamped: boolean): string | null =>
  stamped ? (claim.disposition ?? null) : null;

function roleReport(role: LimitsRole, seat: LimitsSeatInput, ctx: SeatContext): RoleReport {
  const held = ctx.claims.filter((c) => roleOf(c) === role);
  const holding = held.filter((c) => holdsSlot(c, ctx.live));
  const { cap, used, hand, handReserve } = seat.roles[role];
  return {
    cap,
    used,
    live: holding.length,
    spawning: held.filter((c) => c.phase === "spawning").length,
    hand,
    ledger: held.length,
    handReserve: handReserve === undefined ? null : { reserve: handReserve, remaining: handReserve - hand },
    ledgerOnly: held
      .filter((c) => !holdsSlot(c, ctx.live))
      .map((c) => ({
        initiative: c.initiative,
        task: c.taskId,
        ...(c.slice === undefined ? {} : { slice: c.slice }),
        phase: c.phase,
        ...(c.agentName === undefined ? {} : { agentName: c.agentName }),
        stale: c.stale?.class ?? null,
        disposition: dispositionOf(c, ctx.stamped),
      })),
  };
}

const ageMinutes = (readAt: string, now: Date): number =>
  Math.max(0, Math.round((now.getTime() - Date.parse(readAt)) / MINUTE_MS));

const reading = (r: LimitsPoolReading | undefined, now: Date): PoolReport["fiveHour"] =>
  r === undefined ? null : { value: r.value, ageMinutes: ageMinutes(r.readAt, now) };

function poolReports(seat: LimitsSeatInput, now: Date): PoolReport[] {
  return seat.pools.map((p) => ({
    pool: p.pool,
    fiveHour: reading(p.fiveHour, now),
    sevenDay: reading(p.sevenDay, now),
    band: p.band ?? null,
    pace: p.pace ?? null,
    reserve: p.reserve ?? null,
  }));
}

/** Nearest-rank percentile; null over no samples. */
function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

function supplyReport(seat: LimitsSeatInput): SupplyReport {
  const units = firstRefusalPerTask(seat.refusals);
  const ages = seat.supply.readyAgesMinutes;
  return {
    ready: seat.supply.ready,
    waiting: seat.supply.waiting,
    seeded: units.filter(isBookkeeping).length,
    readyAgeMinutes: { p50: percentile(ages, 50), p90: percentile(ages, 90) },
    outOfScope: units.filter((r) => r.kind === "out-of-scope").length,
  };
}

function worktreesReport(seat: LimitsSeatInput): WorktreesReport {
  const { active, perRepoPerSeat, totalCeiling, leftFree, budget } = seat.worktrees;
  const repos = Object.fromEntries(
    Object.entries(active).map(([repo, n]) => [repo, { active: n, perRepoPerSeat: perRepoPerSeat ?? null }]),
  );
  return {
    repos,
    ceiling: totalCeiling === undefined ? null : totalCeiling - (leftFree ?? 0),
    budget: budget ?? null,
  };
}

function contradictions(ctx: SeatContext): SeatReport["contradictions"] {
  const items: ContradictionReport[] = ctx.claims.flatMap((c) =>
    c.stale === undefined
      ? []
      : [
          {
            initiative: c.initiative,
            task: c.taskId,
            ...(c.slice === undefined ? {} : { slice: c.slice }),
            ...c.stale,
            disposition: dispositionOf(c, ctx.stamped),
          },
        ],
  );
  const undisposed = ctx.stamped ? items.filter((i) => i.disposition === null).length : null;
  return { items, undisposed };
}

function seatReport(seat: LimitsSeatInput, ctx: SeatContext): SeatReport {
  return {
    binding: bindingOf(seat.refusals, seat.supply.ready),
    roles: {
      implementers: roleReport("implementers", seat, ctx),
      reviewers: roleReport("reviewers", seat, ctx),
      planners: roleReport("planners", seat, ctx),
    },
    pools: poolReports(seat, ctx.now),
    refusals: refusalKinds(seat.refusals, seat.prs ?? []),
    planBlocked: planBlockedSplit(seat.refusals),
    supply: supplyReport(seat),
    worktrees: worktreesReport(seat),
    contradictions: contradictions(ctx),
  };
}

function shepherdReport(input: LimitsShepherdInput | undefined): ShepherdReport | null {
  if (input === undefined) return null;
  if ("error" in input) return { error: input.error };
  const runs: Record<string, number> = {};
  for (const run of input.runs) runs[run.phase] = (runs[run.phase] ?? 0) + 1;
  return {
    runs,
    held: input.runs.flatMap((r) => (r.holdReason === undefined ? [] : [{ run: r.id, reason: r.holdReason }])),
    reviews: {
      inFlight: input.runs.filter((r) => r.reviewInFlight === true).length,
      maxConcurrent: input.maxConcurrent ?? null,
    },
  };
}

/**
 * The v1 `/limits` report: every count is a projection of the planner's dry-run result, the claim ledger and the
 * Shepherd read the caller passes in. Nothing here recounts from config, so it cannot drift from what the tick saw.
 */
export function limitsReport(plan: LimitsPlanInput, ledger: LimitsLedger, clock: LimitsClock): LimitsReport {
  const now = clock();
  const live = new Set(plan.liveAgents);
  const held = ledger.claims.filter((c) => c.phase !== "done");
  const seats = Object.fromEntries(
    plan.seats.map((seat) => {
      const claims = held.filter((c) => c.seat === seat.seat);
      return [seat.seat, seatReport(seat, { claims, live, stamped: plan.dispositionsStamped, now })];
    }),
  );
  return { v: 1, at: now.toISOString(), seats, shepherd: shepherdReport(plan.shepherd) };
}
