/**
 * A sitting is one deposit holding ordered owner steps. Its asker records each step done or skipped as the owner works
 * through them: `<id>.step-<n>` beside the deposit, written once, so a second record keeps the first outcome. Every record
 * appends a line to `sittings.jsonl`. When the last step is recorded, the sitting closes with an answer file naming the
 * tally, so every reader that already treats an answered deposit as closed (the asker cap, the inbox, `inbox answer`)
 * treats a finished sitting the same way. That answer is class `asker`, which `recheck` never lets settle another item.
 *
 * `as` is self-declared, as in withdraw: the check stops a seat recording steps on another seat's sitting by mistake.
 */
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveDepositRef } from "./deposit-ref.js";
import { errno } from "./errno.js";
import { ASKER_ANSWER_CLASS, STEP_OUTCOMES, type OwnerItem, type StepOutcome } from "./schema.js";
import { readAnswer, readSpool, stepFileName, writeAnswer } from "./spool.js";
import { readWithdrawal } from "./withdraw.js";

export const SITTING_LOG = "sittings.jsonl";
/** The answer's `by.channel` on a sitting closed by its last step, so no reader mistakes it for an owner's pick. */
export const SITTING_CLOSE_CHANNEL = "inbox-step";

const stepRecordSchema = z.strictObject({
  outcome: z.enum(STEP_OUTCOMES),
  by: z.string().min(1),
  actor: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
});
type StepRecord = z.infer<typeof stepRecordSchema>;

/** `unknown`: no deposit matches this id. `refused`: not a sitting, not this asker's, no such step, or already closed. */
export class StepRefusedError extends Error {
  constructor(
    message: string,
    readonly kind: "unknown" | "refused",
  ) {
    super(message);
    this.name = "StepRefusedError";
  }
}

export interface StepRequest {
  outcome: StepOutcome;
  /** Must equal the sitting's asker. */
  as: string;
  /** Who runs the verb; recorded beside the asker. */
  actor: string;
  now?: Date;
}
export interface StepResult {
  id: string;
  step: number;
  /** The step's outcome as filed: on `already-recorded`, the first one, which may differ from the request. */
  outcome: StepOutcome;
  result: "recorded" | "already-recorded";
  /** True once every step is done or skipped, so the sitting is answered and closed. */
  closed: boolean;
}

const refused = (message: string): StepRefusedError => new StepRefusedError(message, "refused");

async function readStep(dir: string, id: string, step: number): Promise<StepRecord | undefined> {
  try {
    return stepRecordSchema.parse(JSON.parse(await readFile(join(dir, stepFileName(id, step)), "utf8")));
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** The item with each step's recorded outcome; an item with no steps comes back as it was. Throws on a malformed marker. */
export async function withStepOutcomes(dir: string, item: OwnerItem): Promise<OwnerItem> {
  if (item.steps === undefined) return item;
  const steps = await Promise.all(
    item.steps.map(async (step, index) => {
      const record = await readStep(dir, item.id, index + 1);
      return record === undefined ? step : { ...step, outcome: record.outcome };
    }),
  );
  return { ...item, steps };
}

async function ownSitting(dir: string, ref: string, as: string): Promise<OwnerItem & { steps: NonNullable<OwnerItem["steps"]> }> {
  const found = resolveDepositRef((await readSpool(dir)).items, ref);
  if (found.kind === "unknown") throw new StepRefusedError(`unknown id ${ref}; full form is deposit:<32 hex>`, "unknown");
  if (found.kind === "ambiguous") throw refused(`ambiguous id ${ref} matches ${found.ids.join(", ")}`);
  if (found.kind === "not-deposit") throw refused(`${ref} is not a deposit`);
  const { item } = found;
  if (item.asker !== as) throw refused(`${item.id} was filed by ${item.asker ?? "no asker"}, not ${as}`);
  if (item.steps === undefined) throw refused(`${item.id} is not a sitting; it has no steps`);
  return { ...item, steps: item.steps };
}

async function assertOpen(dir: string, id: string): Promise<void> {
  if ((await readWithdrawal(dir, id)) !== undefined) throw refused(`${id} is withdrawn`);
  if ((await readAnswer(dir, id)) !== undefined) throw refused(`${id} is already closed`);
}

/** False when the step already has a marker, so the first outcome stands. */
async function createStepMarker(dir: string, id: string, step: number, record: StepRecord): Promise<boolean> {
  try {
    await writeFile(join(dir, stepFileName(id, step)), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (errno(error) === "EEXIST") return false;
    throw error;
  }
}

/** Answers the sitting once every step has an outcome; true when it is closed. */
async function closeWhenSat(dir: string, item: OwnerItem, as: string, at: string): Promise<boolean> {
  const outcomes = ((await withStepOutcomes(dir, item)).steps ?? []).map((step) => step.outcome);
  if (outcomes.some((outcome) => outcome === undefined)) return false;
  const tally = STEP_OUTCOMES.map((outcome) => `${outcomes.filter((each) => each === outcome).length} ${outcome}`).join(", ");
  await writeAnswer(dir, item.id, { text: `sitting complete: ${tally}`, by: { class: ASKER_ANSWER_CLASS, id: as, channel: SITTING_CLOSE_CHANNEL }, at });
  return true;
}

/**
 * Records step `step` (1-based) of the sitting `ref` names, which `as` filed, as done or skipped. Throws StepRefusedError
 * on an unknown id or a refusal. The last outcome closes the sitting.
 */
export async function recordStep(dir: string, ref: string, step: number, { outcome, as, actor, now = new Date() }: StepRequest): Promise<StepResult> {
  if (actor.trim() === "") throw refused("an actor is required: name the seat running this");
  const item = await ownSitting(dir, ref, as);
  const { id } = item;
  if (!Number.isInteger(step) || step < 1 || step > item.steps.length) throw refused(`step ${step} is not one of ${id}'s steps 1-${item.steps.length}`);
  await assertOpen(dir, id);
  const record = { outcome, by: as, actor, at: now.toISOString() };
  if (!(await createStepMarker(dir, id, step, record))) {
    const first = (await readStep(dir, id, step)) ?? record;
    return { id, step, outcome: first.outcome, result: "already-recorded", closed: await closeWhenSat(dir, item, as, record.at) };
  }
  await appendFile(join(dir, SITTING_LOG), `${JSON.stringify({ op: "step", id, step, ...record })}\n`, { mode: 0o600 });
  return { id, step, outcome, result: "recorded", closed: await closeWhenSat(dir, item, as, record.at) };
}
