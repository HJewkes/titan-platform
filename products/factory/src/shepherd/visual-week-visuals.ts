// TP-4761 C3: the weekly batch with each PR's pr-visual pairs written into the round directory and a packet line per PR.
import { writeRoundVisuals, type RoundVisuals } from "./pr-visual-round.js";
import type { PrVisualGh } from "./pr-visual-evidence.js";
import { visualWeekBatch, type VisualWeekBatch } from "./visual-week.js";

/** One read per batched PR, written under `roundDir`; the questions and their bound heads are the plain batch's own. */
export async function visualWeekWithVisuals(base: Parameters<typeof visualWeekBatch>[0], roundDir: string, gh?: PrVisualGh): Promise<VisualWeekBatch> {
  const visuals = new Map<number, RoundVisuals>();
  for (const { merge } of visualWeekBatch(base).questions) visuals.set(merge.pr, await writeRoundVisuals({ repo: merge.repo, pr: merge.pr, head: merge.headSha }, roundDir, gh));
  return visualWeekBatch({ ...base, visuals });
}
