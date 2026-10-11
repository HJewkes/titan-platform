import { describe, expect, it } from "vitest";
import type { ConditionFacts } from "./conditions.js";
import { unmetConditions } from "./conditions.js";
import type { AuthorityRequest } from "./evaluate.js";
import { canResolve, evaluate } from "./evaluate.js";
import { DEFAULT_TABLE } from "./table.js";
import type { ActionClass, ActorClass } from "./vocabulary.js";
import { ACTION_CLASSES, ACTOR_CLASSES, DELEGATE_RESOLVER_CLASSES, QUESTION_CONDITION_KINDS, RESOLVER_CLASSES } from "./vocabulary.js";

const ANSWERABLE: ConditionFacts = { question: { ruleKind: "question", mode: "auto" } };

function request(action: ActionClass, actor: ActorClass, fields: Record<string, unknown> = {}): AuthorityRequest {
  return { action, actor: { class: actor, id: `${actor}-1` }, tainted: false, subject: {}, facts: ANSWERABLE, ...fields } as AuthorityRequest;
}

function answer(facts: unknown, tainted: unknown = false): AuthorityRequest {
  return request("answer-question", "decider", { facts, tainted });
}

describe("the decider actor class", () => {
  it("is an actor class but never a resolver or delegate resolver", () => {
    expect(ACTOR_CLASSES).toContain("decider");
    expect(RESOLVER_CLASSES).not.toContain("decider");
    expect(DELEGATE_RESOLVER_CLASSES).not.toContain("decider");
  });

  it.each(DEFAULT_TABLE.rules.map((rule) => rule.id))("cannot resolve a gate opened by %s", (ruleId) => {
    expect(canResolve(DEFAULT_TABLE, ruleId, { class: "decider", tainted: false })).toBe(false);
  });

  it.each(ACTION_CLASSES.filter((action) => action !== "answer-question"))("is refused %s even with answerable question facts", (action) => {
    expect(evaluate(DEFAULT_TABLE, request(action, "decider")).verdict).toBe("deny");
  });
});

describe("answer-question by the decider", () => {
  it("is allowed by ANS-DC-QA for a question-rule gate in auto mode", () => {
    expect(evaluate(DEFAULT_TABLE, answer(ANSWERABLE))).toEqual({ verdict: "allow", ruleId: "ANS-DC-QA" });
  });

  it("checks exactly the two question conditions", () => {
    const row = DEFAULT_TABLE.rules.find((rule) => rule.id === "ANS-DC-QA");
    expect(row?.when).toEqual([...QUESTION_CONDITION_KINDS]);
  });

  const ruleKinds: Array<[string, unknown]> = [
    ["an authority rule", "authority"], ["a merge rule", "merge"], ["a differently cased kind", "Question"],
    ["an empty kind", ""], ["a null kind", null], ["a numeric kind", 1], ["a list kind", ["question"]],
  ];

  it.each(ruleKinds)("is refused by ANS-DC for %s", (_name, ruleKind) => {
    const decision = evaluate(DEFAULT_TABLE, answer({ question: { ruleKind, mode: "auto" } }));
    expect(decision).toMatchObject({ verdict: "deny", ruleId: "ANS-DC" });
    expect(decision.verdict === "deny" && decision.reason).toContain("ANS-DC-QA unmet: gate-rule-is-question");
  });

  it("is refused when the rule kind is missing", () => {
    expect(evaluate(DEFAULT_TABLE, answer({ question: { mode: "auto" } }))).toMatchObject({ verdict: "deny", ruleId: "ANS-DC" });
  });

  it.each(["shadow", "off", "AUTO", "", undefined, true])("is refused outside auto mode (mode %s)", (mode) => {
    const decision = evaluate(DEFAULT_TABLE, answer({ question: { ruleKind: "question", mode } }));
    expect(decision).toMatchObject({ verdict: "deny", ruleId: "ANS-DC" });
    expect(decision.verdict === "deny" && decision.reason).toContain("ANS-DC-QA unmet: category-mode-auto");
  });

  it.each([true, null, 0, "false"])("is refused when tainted is %s", (tainted) => {
    expect(evaluate(DEFAULT_TABLE, answer(ANSWERABLE, tainted))).toMatchObject({ verdict: "deny", ruleId: "ANS-DC" });
  });

  it("is refused when tainted is not set", () => {
    const untainted = answer(ANSWERABLE);
    Reflect.deleteProperty(untainted, "tainted");
    expect(evaluate(DEFAULT_TABLE, untainted)).toMatchObject({ verdict: "deny", ruleId: "ANS-DC" });
  });

  const missing: Array<[string, unknown]> = [
    ["no facts", undefined], ["merge facts only", { merge: {} }], ["a question that is a string", { question: "question" }],
    ["a question that is a list", { question: ["question", "auto"] }], ["facts holding a function", { question: { ruleKind: "question", mode: "auto", f: () => 1 } }],
  ];

  it.each(missing)("is refused with %s", (_name, facts) => {
    expect(evaluate(DEFAULT_TABLE, answer(facts))).toMatchObject({ verdict: "deny", ruleId: "ANS-DC" });
  });

  it("does not read a rule kind or mode from a polluted Object.prototype", () => {
    Object.defineProperty(Object.prototype, "ruleKind", { value: "question", configurable: true });
    Object.defineProperty(Object.prototype, "mode", { value: "auto", configurable: true });
    try {
      expect(unmetConditions([...QUESTION_CONDITION_KINDS], { question: {} as never })).toEqual([...QUESTION_CONDITION_KINDS]);
      expect(evaluate(DEFAULT_TABLE, answer({ question: {} }))).toMatchObject({ verdict: "deny", ruleId: "ANS-DC" });
    } finally {
      delete (Object.prototype as { ruleKind?: unknown }).ruleKind;
      delete (Object.prototype as { mode?: unknown }).mode;
    }
  });
});

describe("answer-question by any other actor", () => {
  // No row allowed answer-question before this action class existed, so every other actor is refused.
  it.each(ACTOR_CLASSES.filter((actor) => actor !== "decider"))("refuses %s even for a question-rule gate in auto mode", (actor) => {
    expect(evaluate(DEFAULT_TABLE, request("answer-question", actor))).toMatchObject({ verdict: "deny" });
  });
});
