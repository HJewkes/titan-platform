import type { Question } from "../../server/round-schema.js";
import type { Verdict } from "./frame-feedback.js";
import type { QuestionAnswer } from "./RoundQuestion.js";

/**
 * A port of the review harness's pick and verdict link (titan-design review-harness `page/state.ts`, `linkPick` and
 * `linkVerdict`): an option that picks a frame and that frame's Chosen verdict stay in step, whichever one the owner sets.
 */
export interface VerdictChange {
  key: string;
  verdict: Verdict | null;
}

type FrameKeys = { has: (key: string) => boolean };
type VerdictOf = (key: string) => Verdict | null;

/** The variant key picking `option` picks: its `optionVariants` entry, or the option itself when it is a frame key. */
export function optionKey(question: Question, option: string, keys: FrameKeys): string | undefined {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return undefined;
  const key = question.optionVariants?.[option] ?? option;
  return keys.has(key) ? key : undefined;
}

/** Each option that picks a frame, with that frame; the round's revision option picks none. */
function optionFrames(question: Question, keys: FrameKeys): [string, string][] {
  if (question.kind !== "pick-one" && question.kind !== "pick-many") return [];
  return question.options.flatMap((option): [string, string][] => {
    const key = option === question.revisionOption ? undefined : optionKey(question, option, keys);
    return key === undefined ? [] : [[option, key]];
  });
}

const picksOf = (answer: QuestionAnswer | undefined): readonly string[] => (answer === undefined ? [] : "pick" in answer ? [answer.pick] : "picks" in answer ? answer.picks : []);

/**
 * The verdicts that follow `answer`, the question's answer once `choice` was chosen: the frame the choice picks is Chosen
 * while it is picked and stops being Chosen once it is not. A pick-one has one pick, so its other frames stop being Chosen;
 * a pick-many leaves them be. A revision request picks no frame at all.
 */
export function pickVerdicts(question: Question, keys: FrameKeys, choice: string | null, answer: QuestionAnswer | undefined, verdictOf: VerdictOf): VerdictChange[] {
  const frames = optionFrames(question, keys);
  const picked = picksOf(answer);
  const clearing = question.kind === "pick-many" ? frames.filter(([option]) => option === choice) : frames;
  const changes = clearing.flatMap(([option, key]): VerdictChange[] => {
    if (picked.includes(option)) return verdictOf(key) === "chosen" ? [] : [{ key, verdict: "chosen" }];
    return verdictOf(key) === "chosen" ? [{ key, verdict: null }] : [];
  });
  return changes.filter((change, at) => changes.findIndex((each) => each.key === change.key) === at);
}

/** One question's answer once the frame its `option` picks takes `verdict`: Chosen picks the option, any other verdict un-picks it. */
function verdictAnswer(question: Question, answer: QuestionAnswer | undefined, option: string, verdict: Verdict | null): QuestionAnswer | undefined {
  const picks = picksOf(answer);
  if (question.kind === "pick-many") {
    if (verdict === "chosen") return picks.includes(option) ? answer : { picks: [...picks, option] };
    return picks.includes(option) ? { picks: picks.filter((pick) => pick !== option) } : answer;
  }
  if (verdict === "chosen") return { pick: option };
  return picks.includes(option) ? undefined : answer;
}

/** Every answer once frame `key` takes `verdict`, as each question with an option picking that frame answers it. */
export function verdictAnswers(questions: readonly Question[], keys: FrameKeys, answers: Readonly<Record<string, QuestionAnswer>>, key: string, verdict: Verdict | null): Record<string, QuestionAnswer> {
  return questions.reduce<Record<string, QuestionAnswer>>((current, question) => {
    const option = optionFrames(question, keys).find(([, each]) => each === key)?.[0];
    if (option === undefined) return current;
    const { [question.id]: answer, ...rest } = current;
    const next = verdictAnswer(question, answer, option, verdict);
    return next === undefined ? rest : { ...rest, [question.id]: next };
  }, { ...answers });
}
