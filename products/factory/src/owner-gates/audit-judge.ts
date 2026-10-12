import { runAgent } from "@titan-design/agent";
import { z } from "zod";
import type { OutcomeFacts } from "./audit-facts.js";

/** What the judge reads about one sampled decision. */
export interface JudgeInput {
  gateId: string;
  class: string | undefined;
  question: string;
  answer: string | undefined;
  waitHours: number;
  /** The facts the owner gave when resolving, as the gate stored them. */
  evidence: Record<string, unknown> | undefined;
  facts: OutcomeFacts;
}

export const judgeNoteSchema = z.object({
  stamp: z.enum(["did-work", "stamp", "unclear"]),
  note: z.string().min(1).max(280),
});

export type JudgeNote = z.infer<typeof judgeNoteSchema>;

/** One note per sampled decision; throws when no note could be had, and the caller records why. */
export type AuditJudge = (input: JudgeInput) => Promise<JudgeNote>;

export type JudgeVerdict = JudgeNote | { unavailable: string };

/** A failed judge call, carrying the agent's failure kind so the report can name it. */
export class JudgeUnavailable extends Error {
  constructor(
    readonly kind: string,
    reason: string,
  ) {
    super(`${kind}: ${reason}`);
  }
}

/** One week's judge call costs cents; this only stops a runaway. */
const MAX_JUDGE_USD = 1;

function judgePrompt(input: JudgeInput): string {
  return [
    "You audit one decision the owner made on a factory gate, to catch rubber-stamping.",
    "Say `did-work` if the answer shows the owner weighed the question, `stamp` if it looks approved without a look, else `unclear`.",
    "Base it only on the record below; the outcome facts are what followed within 72 hours. One line, at most 280 characters.",
    "",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

/** Sonnet through `claude -p` on the CLI login of the running `CLAUDE_CONFIG_DIR`: one turn, no tools. */
export function claudeJudge(cwd: string): AuditJudge {
  return async (input) => {
    const result = await runAgent({
      harness: "claude-print",
      prompt: judgePrompt(input),
      cwd,
      model: "sonnet",
      outputSchema: judgeNoteSchema,
      maxTurns: 1,
      maxBudgetUsd: MAX_JUDGE_USD,
    });
    if (!result.ok) throw new JudgeUnavailable(result.failure.kind, result.failure.reason);
    return judgeNoteSchema.parse(result.output);
  };
}

/** The facts are the audit and the note sits on top, so a judge failure becomes a line in the report, never a lost report. */
export async function judgeOrUnavailable(judge: AuditJudge | undefined, input: JudgeInput): Promise<JudgeVerdict> {
  if (!judge) return { unavailable: "disabled" };
  try {
    return judgeNoteSchema.parse(await judge(input));
  } catch (error) {
    return { unavailable: error instanceof JudgeUnavailable ? error.kind : error instanceof z.ZodError ? "schema_invalid" : "error" };
  }
}
