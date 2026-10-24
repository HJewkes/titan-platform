import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_CONFIDENCE,
  DecideInputSchema,
  decideJsonSchemas,
  validate,
  type DecideInput,
  type DecideReply,
} from "./contract.js";

const INPUT: DecideInput = {
  question: "Should the retry loop back off exponentially?",
  options: [{ label: "Exponential backoff" }, { label: "Fixed interval", description: "Every 5 s" }],
  recommended: "Exponential backoff",
  category: "tech_design",
  initiative: "example-initiative",
  context: "A synthetic worker that polls a queue.",
  principles: [
    { id: "p-backoff", rule: "Prefer backoff over fixed retries", confidence: 0.9, examples: ["k1"] },
    { id: "p-simple", rule: "Pick the simpler option when equal", confidence: 0.7, examples: [] },
  ],
  precedents: [{ key: "k1", quote: "Back off, do not hammer the API." }],
};

function replyWith(extra: Partial<DecideReply> = {}): DecideReply {
  return {
    answer: "Exponential backoff",
    optionIndex: 0,
    confidence: 0.92,
    principleIds: ["p-backoff"],
    escalate: false,
    reversible: "Change the retry setting back in one commit.",
    ...extra,
  };
}

describe("validate", () => {
  it("accepts a reply that cites known principles above the threshold", () => {
    const result = validate(replyWith(), INPUT);

    expect(result).toEqual({ ok: true, reply: replyWith() });
  });

  it("rejects a reply that cites a principle id absent from the input", () => {
    const result = validate(replyWith({ principleIds: ["p-backoff", "p-invented"] }), INPUT);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toEqual([expect.stringContaining('"p-invented"')]);
  });

  it("forces escalation when confidence is under the default threshold", () => {
    const result = validate(replyWith({ confidence: 0.6 }), INPUT);

    expect(result.ok && result.reply.escalate).toBe(true);
    expect(result.ok && result.reply.escalateReason).toContain(`threshold ${DEFAULT_MIN_CONFIDENCE}`);
  });

  it("uses the category's own threshold from the policy", () => {
    const policy = { categories: { tech_design: { minConfidence: 0.95 } } };

    const result = validate(replyWith({ confidence: 0.92 }), INPUT, policy);

    expect(result.ok && result.reply.escalate).toBe(true);
  });

  it("keeps the model's own escalation reason when forcing escalation", () => {
    const result = validate(replyWith({ confidence: 0.5, escalate: true, escalateReason: "unclear scope" }), INPUT);

    expect(result.ok && result.reply.escalateReason).toMatch(/^unclear scope; confidence 0.5/);
  });

  it("rejects an optionIndex outside the input options", () => {
    const result = validate(replyWith({ optionIndex: 2 }), INPUT);

    expect(result).toEqual({ ok: false, errors: [expect.stringContaining("optionIndex 2")] });
  });

  it("rejects a negative optionIndex", () => {
    expect(validate(replyWith({ optionIndex: -1 }), INPUT).ok).toBe(false);
  });

  it("accepts a null optionIndex for a free-text answer", () => {
    expect(validate(replyWith({ optionIndex: null, answer: "Use a queue" }), INPUT).ok).toBe(true);
  });

  // Catches: dropping applyUnlock from validate, or checking only the question.
  it("forces escalation for a confident free-text answer that touches the unlock table", () => {
    const reply = replyWith({ optionIndex: null, answer: "Delete the branch and force-push main", confidence: 0.99 });

    const result = validate(reply, INPUT);

    expect(result.ok && result.reply.escalate).toBe(true);
    expect(result.ok && result.reply.escalateReason).toContain("unlock table (deletion)");
  });

  it.each([
    ["merge", "Merge it now"],
    ["publish or release", "Publish the package"],
    ["deploy", "Deploy to staging"],
    ["money", "Buy the larger plan"],
    ["settings or policy edit", "Update settings.json"],
  ])("forces escalation for a free-text answer touching %s", (row, answer) => {
    const result = validate(replyWith({ optionIndex: null, answer }), INPUT);

    expect(result.ok && result.reply.escalateReason).toContain(`(${row})`);
  });

  // Catches: passing reply.answer twice instead of input.question to checkUnlock.
  it("forces escalation when the question itself touches the unlock table", () => {
    const input = { ...INPUT, question: "Should this PR merge before the freeze?" };

    const result = validate(replyWith({ optionIndex: null, answer: "Yes" }), input);

    expect(result.ok && result.reply.escalate).toBe(true);
  });

  // Catches: treating a not_decidable category as a pass.
  it("forces escalation for a category the decider may not answer", () => {
    const result = validate(replyWith(), { ...INPUT, category: "merge_gate" });

    expect(result.ok && result.reply.escalateReason).toContain('category "merge_gate"');
  });

  // Catches: escalating every free-text answer (an always-hit unlock check).
  it("lets a benign free-text answer stand without escalation", () => {
    const reply = replyWith({ optionIndex: null, answer: "Use a queue" });

    expect(validate(reply, INPUT)).toEqual({ ok: true, reply });
  });

  // Catches: the unlock reason overwriting the threshold reason instead of appending.
  it("keeps the threshold reason when the unlock table also forces escalation", () => {
    const result = validate(replyWith({ optionIndex: null, answer: "Merge it", confidence: 0.5 }), INPUT);

    expect(result.ok && result.reply.escalateReason).toMatch(/^confidence 0.5 .*; this touches the unlock table/);
  });

  // Catches: dropping answerMatchErrors, so an index can launder a different free-text answer.
  it("rejects an answer that does not match the option at optionIndex", () => {
    const result = validate(replyWith({ optionIndex: 0, answer: "Fixed interval" }), INPUT);

    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('does not match option 0 "Exponential backoff"')] });
  });

  // Catches: comparing against the wrong option (e.g. options[0] regardless of the index).
  it("accepts an answer matching a later option at its index", () => {
    expect(validate(replyWith({ optionIndex: 1, answer: "Fixed interval" }), INPUT).ok).toBe(true);
  });

  it("returns errors instead of throwing for a malformed reply", () => {
    const result = validate({ answer: "yes", confidence: 2 }, INPUT);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.some((e) => e.startsWith("confidence"))).toBe(true);
  });
});

describe("decideJsonSchemas", () => {
  it("emits object schemas listing the contract fields as required", () => {
    const { input, reply } = decideJsonSchemas();

    expect(input.required).toEqual(expect.arrayContaining(["question", "options", "category", "principles"]));
    expect(reply.required).toEqual(
      expect.arrayContaining(["answer", "optionIndex", "confidence", "principleIds", "escalate", "reversible"]),
    );
  });

  it("parses the fixture input through the zod schema unchanged", () => {
    expect(DecideInputSchema.parse(INPUT)).toEqual(INPUT);
  });
});
