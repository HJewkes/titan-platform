/**
 * A plan round's `planApprovals` (TP-4357): the console's own round.json field, not review-schema's, lifted off before the
 * strict parse as `supersedes` is. Each entry binds one pick-one question to the TP-4284 approved entry the owner's
 * `approve` pick records, written by the planner verbatim in the factory's shape: the task, repo, gate and scope come from
 * here, the round id from the round's directory and the actor from the factory's console resolver. The factory parses the
 * action again, strictly, before it writes a row; this copy refuses a malformed round when it is read.
 */
import { CI_POLICY_KEYS } from "@titan-design/session-read";
import { z } from "zod";

const bounded = z.string().min(1).max(512);
const MAX_BINDINGS = 20;

const PinnedFile = z.strictObject({ path: bounded, blob: z.string().regex(/^[0-9a-f]{40}$/).nullable() });
const CiPolicyScope = z.strictObject({
  ciPolicyKeys: z.array(z.enum(CI_POLICY_KEYS)).min(1).max(CI_POLICY_KEYS.length),
  files: z
    .array(PinnedFile)
    .min(1)
    .max(20)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length, "each pinned path appears once"),
});
const PathScope = z.strictObject({ paths: z.array(bounded).min(1).max(200) });

const bindingFields = {
  questionId: z.string().min(1),
  /** The option whose pick is the approval; any other pick records nothing. */
  approve: z.string().min(1),
  task: z.string().min(1).max(256),
  repo: z.string().min(1).max(256),
};

const PlanBinding = z.discriminatedUnion("gate", [
  z.strictObject({ ...bindingFields, gate: z.literal("ci-policy"), scope: CiPolicyScope }),
  z.strictObject({ ...bindingFields, gate: z.enum(["skill", "visual"]), scope: PathScope }),
]);

export const PlanBindings = z
  .array(PlanBinding)
  .min(1)
  .max(MAX_BINDINGS)
  .refine((bindings) => new Set(bindings.map((binding) => binding.questionId)).size === bindings.length, "a question binds one plan approval");

export type PlanBinding = z.infer<typeof PlanBinding>;

interface BoundQuestion {
  id: string;
  kind: string;
  options?: readonly string[];
}

/** Each binding names a pick-one in the round, and its `approve` is one of that question's options. */
export function planBindingProblems(bindings: readonly PlanBinding[], questions: readonly BoundQuestion[]): string[] {
  return bindings.flatMap(({ questionId, approve }) => {
    const question = questions.find((each) => each.id === questionId);
    if (question?.kind !== "pick-one") return [`planApprovals: ${questionId} is not a pick-one question of this round`];
    return question.options?.includes(approve) ? [] : [`planApprovals: ${questionId} has no option "${approve}"`];
  });
}
