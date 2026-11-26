// TP-6777: the log builder's frames step. Only a visual ship row gets frames; every other row keeps `frames: null`.
import { captureLogFrames, readLogFrames, type FramesCapture } from "./log-frames.js";
import { prKeyOf, type LogRow, type ShipInput } from "./log-rows.js";

/** Each capture downloads an artifact, so one build starts at most this many; the rest wait for a later build. */
export const MAX_CAPTURES_PER_BUILD = 3;

interface FramesStep {
  stateDir: string;
  capture?: FramesCapture;
}

interface Budget {
  left: number;
}

async function framesFor(ship: ShipInput, step: FramesStep, budget: Budget): Promise<{ frames: LogRow["frames"]; gap?: string }> {
  const known = await readLogFrames(step.stateDir, ship.repo, ship.pr);
  if (known !== null || step.capture === undefined || ship.head === undefined || budget.left === 0) return { frames: known };
  budget.left -= 1;
  const outcome = await captureLogFrames({ repo: ship.repo, pr: ship.pr, head: ship.head }, step.stateDir, step.capture);
  const gap = typeof outcome === "object" ? `frames for ${ship.repo}#${ship.pr}: ${outcome.skipped}` : undefined;
  return { frames: await readLogFrames(step.stateDir, ship.repo, ship.pr), ...(gap !== undefined && { gap }) };
}

/** The rows with each visual ship's frames read, captured first when it has none yet; a failure is a gap line, never an error. */
export async function withFrames(rows: readonly LogRow[], ships: readonly ShipInput[], step: FramesStep): Promise<{ rows: LogRow[]; gaps: string[] }> {
  const shipOf = new Map(ships.map((ship) => [prKeyOf(ship.repo, ship.pr), ship]));
  const budget = { left: MAX_CAPTURES_PER_BUILD };
  const gaps: string[] = [];
  const out: LogRow[] = [];
  for (const row of rows) {
    const ship = row.kind === "ship" && row.visual ? shipOf.get(row.key) : undefined;
    if (ship === undefined) {
      out.push(row);
      continue;
    }
    const read = await framesFor(ship, step, budget).catch((error: unknown) => ({ frames: null, gap: `frames for ${ship.repo}#${ship.pr}: ${error instanceof Error ? error.message : String(error)}` }));
    if (read.gap !== undefined) gaps.push(read.gap);
    out.push({ ...row, frames: read.frames });
  }
  return { rows: out, gaps };
}
