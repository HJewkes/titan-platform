import { describe, expect, it } from "vitest";
import { scrubBrief } from "./brief.js";

const merge = { pr: 77, mergeSha: "c".repeat(40) };

describe("brief scrub", () => {
  it("keeps a clean brief as title plus done_when only", () => {
    const result = scrubBrief({ title: "Add a retry cap", doneWhen: "the client stops after three retries" }, merge);

    expect(result).toEqual({ ok: true, brief: "Task: Add a retry cap\nDone when: the client stops after three retries" });
  });

  it("rejects a brief citing another PR number", () => {
    const result = scrubBrief({ title: "Follow the fix in #3540", doneWhen: "tests pass" }, merge);

    expect(result).toEqual({ ok: false, reason: "brief-leaks-history" });
  });

  it("rejects a brief carrying a full commit sha", () => {
    const result = scrubBrief({ title: "Revert the bad cache", doneWhen: `behaves as at ${"ab12".repeat(10)}` }, merge);

    expect(result).toEqual({ ok: false, reason: "brief-leaks-history" });
  });

  it.each(["closed by Shepherd", "Follow-up TP-12 filed"])("rejects Shepherd's own words: %s", (words) => {
    const result = scrubBrief({ title: "Tidy the queue", doneWhen: `done; ${words}` }, merge);

    expect(result.ok).toBe(false);
  });

  it("rejects a brief naming its own PR as an answer leak", () => {
    const result = scrubBrief({ title: "Ship the cap", doneWhen: "see #77" }, merge);

    expect(result).toEqual({ ok: false, reason: "brief-leaks-answer" });
  });

  it("keeps short numbers and task ids that point nowhere", () => {
    const result = scrubBrief({ title: "TP-5406: cap at 12 retries", doneWhen: "issue #12 style cases pass" }, merge);

    expect(result.ok).toBe(true);
  });
});
