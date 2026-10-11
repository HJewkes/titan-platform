import type { ResolvedLimits } from "./resolve.js";
import type { Grant } from "./schema.js";

export interface FiveHourReading {
  fiveHour: number;
  resetsAt: Date;
}

export interface LiftQuestion {
  pool: string;
  /** `<pool>:<resets_at>`: one question per pool per five-hour window, recorded as asked by the caller. */
  key: string;
  resetsAt: Date;
  liftTo: number;
  text: string;
}

export interface LiftAnswer {
  questionId: string;
  answer: "yes" | "no";
}

export function liftKey(pool: string, resetsAt: Date): string {
  return `${pool}:${resetsAt.toISOString()}`;
}

/** The question to ask the owner when a liftable pool reaches its ceiling, or null when none is due. */
export function liftQuestion(input: {
  limits: ResolvedLimits;
  reading: FiveHourReading;
  asked: ReadonlySet<string>;
}): LiftQuestion | null {
  const { limits, reading, asked } = input;
  if (limits.lift === null || reading.fiveHour < limits.ceiling_five_hour) return null;
  if (limits.ceiling_five_hour >= limits.lift.ceiling_five_hour) return null;
  const key = liftKey(limits.pool, reading.resetsAt);
  if (asked.has(key)) return null;
  const resets = reading.resetsAt.toISOString();
  return {
    pool: limits.pool,
    key,
    resetsAt: reading.resetsAt,
    liftTo: limits.lift.ceiling_five_hour,
    text: `${limits.pool} at ${limits.ceiling_five_hour}% of five_hour, resets ${resets}: go to ${limits.lift.ceiling_five_hour} until then?`,
  };
}

/** The grant a yes writes: the lifted ceiling until the window resets. A no, or no answer, holds. */
export function grantFromAnswer(question: LiftQuestion, answer: LiftAnswer): Grant | null {
  if (answer.answer !== "yes") return null;
  return {
    pool: question.pool,
    ceiling_five_hour: question.liftTo,
    until: question.resetsAt.toISOString(),
    question: answer.questionId,
  };
}
