/**
 * Which Shepherd gate a round's merge-bound question answers. The answer relay (`listeners.ts`) posts to it and the inbox
 * (`inbox-blocking.ts`) folds it into the round's row, so both read it here: a gate the inbox hides behind a round is
 * always one the round's answer reaches (TP-4356).
 */
const APPROVE_MERGE = /(^|\/)approve-merge(:\d+)?$/;
const VISUAL_ACCEPT = /(^|\/)sh-visual-accept(:\d+)?$/;

interface PendingGate {
  gateId: string;
  stepId: string;
}

interface Pin {
  repo: string;
  pr: number | null;
}

const isStep = (gate: PendingGate, pattern: RegExp): boolean => pattern.test(gate.stepId) || pattern.test(gate.gateId);

export const isVisualAccept = (gate: PendingGate): boolean => isStep(gate, VISUAL_ACCEPT);

/** The steps a round answer posts to; any other pending gate, an sh-sent-back one included, is not the round's to settle. */
export const roundAnswers = (gate: PendingGate | null | undefined): gate is PendingGate =>
  gate != null && (isStep(gate, APPROVE_MERGE) || isVisualAccept(gate));

/** GitHub names a repo case-insensitively, and Shepherd may spell it otherwise than the round does. */
export const samePr = (row: Pin, pin: Pin): boolean => row.repo.toLowerCase() === pin.repo.toLowerCase() && row.pr === pin.pr;

/** A sha is hex, so case never makes two heads differ. */
export const sameHead = (a: string | null, b: string): boolean => a?.toLowerCase() === b.toLowerCase();

/** The `pr:<repo>#<n>@<head>` key a merge-bound round question carries, lowercased as owner-queue's `prKey` writes it. */
export const pinKey = (repo: string, pr: number, headSha: string): string => `pr:${repo}#${pr}@${headSha}`.toLowerCase();
