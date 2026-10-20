import type { OwnerItemDeposit } from "@titan-design/owner-queue";

export type FailureStage = "build" | "smoke" | "restart" | "rollback";

export interface UpdateFailure {
  stage: FailureStage;
  target: string;
  /** The sha still serving, or that should be after a rollback. */
  serving: string;
  why: string;
}

const SUMMARY_MAX = 280;
const CONTEXT_MAX = 1500;

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const short = (sha: string): string => sha.slice(0, 7);

function lead(failure: UpdateFailure): string {
  if (failure.stage === "rollback") return `ALERT: the console update to ${short(failure.target)} failed and the rollback to ${short(failure.serving)} did not answer /health; the console may be down.`;
  if (failure.stage === "restart") return `The console update to ${short(failure.target)} did not answer /health after its restart, so ${short(failure.serving)} was put back.`;
  return `The console update to ${short(failure.target)} failed its ${failure.stage}; ${short(failure.serving)} keeps serving.`;
}

/**
 * The owner-queue item the factory's deploy incident also files. Keyed on the target and stage, so the
 * timer's retries of one broken sha file one item, and a newer main sha files its own.
 */
export function failureDeposit(failure: UpdateFailure): OwnerItemDeposit {
  return {
    depositId: `console-update-${short(failure.target)}-${failure.stage}`,
    asker: "titan-console",
    kind: "do",
    door: "two-way",
    summary: oneLine(`${failure.stage === "rollback" ? "CONSOLE MAY BE DOWN: " : ""}console update to ${short(failure.target)} failed (${failure.stage})`, SUMMARY_MAX),
    context: oneLine(`${lead(failure)} Why: ${failure.why}. The updater holds this sha until a newer main commit lands.`, CONTEXT_MAX),
    command: "journalctl --user -u titan-console-update.service -n 200",
    keys: ["console-update"],
  };
}
