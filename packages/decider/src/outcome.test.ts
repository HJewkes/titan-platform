import { describe, expect, it } from "vitest";
import { OPTIONS } from "./fixtures.js";
import { classifyOutcome, stripRecommended, type OutcomeInput } from "./outcome.js";

const RECOMMENDED = OPTIONS[0] ?? null;

function outcomeOf(answer: string | null, extra: Partial<OutcomeInput> = {}) {
  return classifyOutcome({ answer, options: OPTIONS, recommended: RECOMMENDED, ...extra });
}

describe("classifyOutcome from a raw answer", () => {
  it("accepts the recommended option picked verbatim", () => {
    expect(outcomeOf("Use a queue (Recommended)")).toBe("accept");
  });

  it("calls another listed option other", () => {
    expect(outcomeOf("Use a cron job")).toBe("other");
  });

  it("calls a multi-select of listed options other", () => {
    expect(outcomeOf("Use a cron job, Do nothing")).toBe("other");
  });

  it("calls a multi-select other in either order when it includes the recommended option", () => {
    expect(outcomeOf("Use a queue (Recommended), Use a cron job")).toBe("other");
    expect(outcomeOf("Use a cron job, Use a queue (Recommended)")).toBe("other");
  });

  it("calls free text that starts with the recommended label an amend", () => {
    expect(outcomeOf("Use a queue, but cap retries at three")).toBe("amend");
  });

  it("calls free text a redirect when the recommended label is only a prefix of a longer word", () => {
    expect(outcomeOf("Use a queueing library instead")).toBe("redirect");
  });

  it("calls free text that quotes the recommended label an amend", () => {
    expect(outcomeOf('Go with "use a queue" and log each drop')).toBe("amend");
  });

  it("calls free text unrelated to any option a redirect", () => {
    expect(outcomeOf("Neither; fold this into the nightly import")).toBe("redirect");
  });

  it("calls free text a redirect when the asker recommended nothing", () => {
    expect(outcomeOf("Use a queue, but smaller", { recommended: null })).toBe("redirect");
  });

  it("leaves a missing answer unscored", () => {
    expect(outcomeOf(null)).toBeNull();
  });
});

describe("classifyOutcome from a v1 pick type", () => {
  it.each([
    ["recommended", "Use a queue (Recommended)", "accept"],
    ["other_option", "Use a cron job", "other"],
    ["rejected", null, null],
    ["none", null, "none"],
    ["unparsed", null, null],
    ["free_text", "Use a queue (Recommended) and add a dead-letter table", "amend"],
    ["free_text", "Ask the widget team first", "redirect"],
  ] as const)("maps %s answered %j to %s", (pickType, answer, expected) => {
    expect(outcomeOf(answer, { pickType })).toBe(expected);
  });
});

describe("stripRecommended", () => {
  it.each([
    ["Use a queue (Recommended)", "Use a queue"],
    ["Use a queue (recommended for now)", "Use a queue"],
    ["Use a queue [Recommended]", "Use a queue"],
    ["(Recommended) Use a queue", "Use a queue"],
    ["Recommended: Use a queue", "Use a queue"],
    ["Recommended - Use a queue", "Use a queue"],
    ["Use a queue - recommended", "Use a queue"],
    ["Use a queue: Recommend", "Use a queue"],
  ])("strips the marker from %j", (label, expected) => {
    expect(stripRecommended(label)).toBe(expected);
  });

  it.each([
    "Recommend the vendor to the team",
    "Recommended-tier plan",
    "Force push (not recommended)",
    "Skip the check [unrecommended]",
  ])("keeps %j, which carries no recommendation marker", (label) => {
    expect(stripRecommended(label)).toBe(label);
  });
});

describe("classifyOutcome with an option the asker advised against", () => {
  const options = ["Force push (not recommended)", "Rebase onto main (Recommended)"];

  it("calls picking it other, not accept", () => {
    const outcome = classifyOutcome({ answer: options[0] ?? null, options, recommended: options[1] ?? null });

    expect(outcome).toBe("other");
  });
});

describe("classifyOutcome with a prefix marker on the recommended option", () => {
  const options = ["Recommended: Use a queue", "Use a cron job"];

  it("accepts the recommended option picked without its marker", () => {
    const outcome = classifyOutcome({ answer: "Use a queue", options, recommended: options[0] ?? null });

    expect(outcome).toBe("accept");
  });
});
