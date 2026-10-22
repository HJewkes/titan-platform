import type { WorkflowRun } from "@titan-design/workflow";
import { OutcomeSchema, type Outcome } from "../schemas.js";

/** Every idea's recorded `ar-stop` outcome, by idea id. */
export function stopOutcomes(run: WorkflowRun | undefined): Map<string, Outcome> {
  const stops = Object.entries(run?.stepResults ?? {}).filter(([key]) => key.startsWith("ar-stop:"));
  return new Map(stops.map(([, result]) => OutcomeSchema.parse(JSON.parse(result.output!))).map((outcome) => [outcome.ideaId, outcome]));
}

/** A run key's repeat label: the key itself is unique per run and ladder. */
export const runLabel = (key: string) => key.split("-").at(-1)!;

export async function until(done: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${what} not reached within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function latch() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}
