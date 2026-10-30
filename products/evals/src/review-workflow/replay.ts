import { lineSourceFromTexts } from "@titan-design/evidence";
import { gateMigration, gateResolverMigration, SqliteGateStore } from "@titan-design/hitl/sqlite";
import { reviewRunner, type ReviewBodyPorts, type ReviewHeadPolicy, type ReviewOutcome } from "@titan-design/review-workflow";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { workflowMigration, workflowOwnershipMigration } from "@titan-design/workflow";
import { caseHash, hashCanonical } from "../hash.js";
import type { EvalCase } from "../spec/index.js";
import { replayExpectedSchema, replayInputSchema, type ReplayInput } from "./scenario.js";
import { scoreReplay, type ReplayScore } from "./score.js";

/** One hill-climbing candidate: the rule files `reviewHead` reads, never the recipe. */
export interface ReplayVariant {
  id: string;
  policy: ReviewHeadPolicy;
}

/** The ports one case runs over, and how many reviewer agents they spawned. */
export interface ReplayWorld {
  ports: ReviewBodyPorts;
  sessions(): number;
}

export interface ReplayResult extends ReplayScore {
  caseId: string;
  caseHash: string;
  variantHash: string;
}

const variantHashOf = (variant: ReplayVariant): string => hashCanonical(variant.policy);

/** A fresh in-memory run store per case, so no case sees another's runs and nothing touches disk. */
async function runOnce(input: ReplayInput, variant: ReplayVariant, world: ReplayWorld): Promise<ReviewOutcome> {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  try {
    const runner = reviewRunner({ ports: world.ports, policy: variant.policy, runtime: { db, gates: new SqliteGateStore(db, { migrate: false }) } });
    const { target, kind } = input;
    return await runner.outcome(runner.start({ target, kind, brief: { checkoutRoot: "reviews" } }));
  } finally {
    db.close();
  }
}

/** Replays one case through `reviewWorkflow` under one variant and scores it; `worldFor` supplies the ports. */
export async function replayCase(evalCase: EvalCase, variant: ReplayVariant, worldFor: (input: ReplayInput) => ReplayWorld): Promise<ReplayResult> {
  const input = replayInputSchema.parse(evalCase.input);
  const expected = replayExpectedSchema.parse(evalCase.expected);
  const world = worldFor(input);
  const outcome = await runOnce(input, variant, world);
  const score = scoreReplay(expected, outcome, lineSourceFromTexts(input.sources), world.sessions());
  return { caseId: evalCase.id, caseHash: caseHash(evalCase), variantHash: variantHashOf(variant), ...score };
}

/** Every case under every variant, in order; cases run one at a time so their reviewer counts stay their own. */
export async function replaySuite(cases: readonly EvalCase[], variants: readonly ReplayVariant[], worldFor: (input: ReplayInput) => ReplayWorld): Promise<ReplayResult[]> {
  const results: ReplayResult[] = [];
  for (const variant of variants) for (const evalCase of cases) results.push(await replayCase(evalCase, variant, worldFor));
  return results;
}
