import type { Db, Migration } from "@titan-design/store-sqlite";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { fixProofRoute } from "./fix-proof.js";
import type { ShepherdDeps } from "./phases.js";

const WAIVE_PROOF_STEP = "sh-fix-proof-waive";
const PROOF_WAIVER_STEP = "sh-fix-proof-waived";

export const PROOF_WAIVER_STEPS: readonly StepDeclaration[] = [
  { id: WAIVE_PROOF_STEP, kind: "dispatch" },
  { id: PROOF_WAIVER_STEP, kind: "dispatch" },
];

const PROOF_WAIVER_DDL = `
  CREATE TABLE shepherd_proof_waiver (
    run_id TEXT NOT NULL,
    head   TEXT NOT NULL,
    at     TEXT NOT NULL,
    PRIMARY KEY (run_id, head)
  );`;

/** The owner's fix-proof waivers, one per run and head. */
export function proofWaiverMigration(version = 32): Migration {
  return { version, name: "factory:shepherd_proof_waiver", up: (db) => db.exec(PROOF_WAIVER_DDL) };
}

export interface ProofWaivers {
  /** A repeat at the same run and head keeps the first row. */
  waive(runId: string, head: string): void;
  waivedAt(runId: string, head: string): boolean;
}

export function proofWaiverTable(db: Db, stamp: () => string): ProofWaivers {
  return {
    waive: (runId, head) => void db.prepare("INSERT OR IGNORE INTO shepherd_proof_waiver (run_id, head, at) VALUES (?, ?, ?)").run(runId, head, stamp()),
    waivedAt: (runId, head) => db.prepare("SELECT 1 FROM shepherd_proof_waiver WHERE run_id = ? AND head = ?").get(runId, head) !== undefined,
  };
}

const WaiverInput = z.object({ runId: z.string().min(1), head: z.string().min(1) });
const Waived = z.looseObject({ waived: z.boolean() });

/** The fix-proof read and the waiver steps that can let a NO_REPRO head past it. */
export const fixProofRoutes = (deps: ShepherdDeps): StepRoute[] => [
  fixProofRoute(deps),
  codeRoute(WAIVE_PROOF_STEP, deps.now, async (raw: unknown) => {
    const { runId, head } = WaiverInput.parse(raw);
    deps.store.get().proofWaivers().waive(runId, head);
    return { waived: true };
  }),
  codeRoute(PROOF_WAIVER_STEP, deps.now, async (raw: unknown) => {
    const { runId, head } = WaiverInput.parse(raw);
    return { waived: deps.store.get().proofWaivers().waivedAt(runId, head) };
  }),
];

/** Records the owner's waiver of `head`'s fix-proof for this run. */
export async function waiveProof(ctx: WorkflowContext, head: string): Promise<void> {
  await step(ctx, WAIVE_PROOF_STEP, { runId: ctx.runId, head }, Waived);
}

/**
 * Whether the owner waived `head`'s fix-proof in this run. A run that never waived reads nothing, so the history of a run
 * recorded before waivers existed replays without a step it does not hold.
 */
export async function proofWaivedAt(ctx: WorkflowContext, head: string): Promise<boolean> {
  if (ctx.iteration(WAIVE_PROOF_STEP) === 0) return false;
  return (await step(ctx, `${PROOF_WAIVER_STEP}:${head}`, { runId: ctx.runId, head }, Waived)).waived;
}
