import { describe, expect, it } from "vitest";
import { OPTIONS } from "./fixtures.js";
import { classifyOutcome, type OutcomeInput } from "./outcome.js";

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
    ["rejected", null, "other"],
    ["none", null, "none"],
    ["unparsed", null, null],
    ["free_text", "Use a queue (Recommended) and add a dead-letter table", "amend"],
    ["free_text", "Ask the widget team first", "redirect"],
  ] as const)("maps %s answered %j to %s", (pickType, answer, expected) => {
    expect(outcomeOf(answer, { pickType })).toBe(expected);
  });
});
