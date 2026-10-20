/**
 * The builder rules a round must pass to enter the rounds dir (TP-3769): review-schema's `lintRound`, vendored in
 * `review-schema-0.3/lint.ts`, plus the harness's Ship-last order, which `applyRoundRules` applies by reordering
 * (review-harness round-rules.ts `shipLast`). The page asks a section's questions in `questionIds` order, and
 * `lintRound` passes a Ship with no frames anywhere in its section, so a side question after Ship would be asked
 * once the merge is already answered.
 *
 * Import and the decisions file refuse a round with any problem; they never reorder it, because round.json's bytes
 * are what frames.json and feedback.json bind by sha256. `rounds.get` never runs these rules, so a round already on
 * disk keeps opening.
 */
import { lintRound, type LintProblem } from "./review-schema-0.3/index.js";
import type { Manifest, Question } from "./round-schema.js";

const isShip = (question: Question): boolean => question.kind === "pick-one" && question.merge !== undefined;

function shipFollowedProblems(manifest: Manifest): LintProblem[] {
  const byId = new Map(manifest.questions.map((question) => [question.id, question]));
  return manifest.sections.flatMap((section) =>
    section.questionIds.flatMap((id, at) => {
      const ship = byId.get(id);
      if (ship === undefined || !isShip(ship)) return [];
      const after = section.questionIds.slice(at + 1).filter((next) => {
        const question = byId.get(next);
        return question !== undefined && !isShip(question);
      });
      if (after.length === 0) return [];
      return [{ rule: "ship-not-last" as const, message: `question ${id}: Ship is asked before ${after.join(", ")} in section ${section.id}; ask Ship last` }];
    }),
  );
}

export function roundRuleProblems(manifest: Manifest): LintProblem[] {
  const linted = lintRound(manifest);
  const flagged = (problem: LintProblem) => linted.some((other) => other.rule === problem.rule && other.message.startsWith(problem.message.split(":")[0] + ":"));
  return [...linted, ...shipFollowedProblems(manifest).filter((problem) => !flagged(problem))];
}

/** Null when the round passes; otherwise every problem, each named by its rule. */
export function roundRuleRefusal(manifest: Manifest): string | null {
  const problems = roundRuleProblems(manifest);
  return problems.length === 0 ? null : `round.json breaks the builder rules: ${problems.map(({ rule, message }) => `${rule}: ${message}`).join("; ")}`;
}
