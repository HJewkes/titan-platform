import { BY_REC_RESOLVER } from "./by-rec-schema.js";
import type { OwnerAnswer } from "./schema.js";

type Answerer = OwnerAnswer["by"];

/** The owner answering from a round, the queue or a terminal; a coordinator delegate or an automation is not one. */
const OWNER_CLASSES: ReadonlySet<string> = new Set(["owner", "owner-remote", "owner-terminal"]);

/** Whether an answer is the owner's own, the only kind that may settle another item or lift a change request. */
export const isOwnerAnswer = (answer: Pick<OwnerAnswer, "by">): boolean => OWNER_CLASSES.has(answer.by.class);

/** feedback@1 does not say who answered; a round answer is the owner's unless its feedback carries the by-rec mark. */
export const ROUND_ANSWERER: Answerer = { class: "owner", id: "owner", channel: "round" };

const BY_REC_ANSWERER: Answerer = { ...BY_REC_RESOLVER, channel: "round" };
const BY_REC_MARK = "auto-by-rec:";

/**
 * The `general` the by-rec sweep's feedback carries (TP-6773). feedback@1 is strict and has no answerer field, so this
 * mark is the one place the file says who answered, and every reader takes the answerer from it through `feedbackAnswerer`.
 */
export const BY_REC_FEEDBACK_GENERAL = `${BY_REC_MARK} every question was answered with its recommendation after the round went unanswered past the by-rec wait`;

/** Who answered a round, read from its feedback's `general`. A mark anyone else wrote only takes the owner's credit away. */
export function feedbackAnswerer(general: string | undefined): Answerer {
  return general?.startsWith(BY_REC_MARK) === true ? BY_REC_ANSWERER : ROUND_ANSWERER;
}
