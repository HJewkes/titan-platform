import { describe, expect, it } from "vitest";
import { CI_WAIT_HEAD, CI_WAIT_IN_COMMAND } from "./ci-wait-head.js";
import { gapCauseOf } from "./cache-ttl-gap-cause.js";
import { transcriptSignals } from "./transcript-friction.js";

const WINDOW = { since: "2030-01-01T00:00:00.000Z", until: "2030-01-02T00:00:00.000Z" };
const SHARED_HEADS = ["ci-wait", "gh pr checks", "gh run"];

/** One Bash call that holds the worker for ten minutes, so the wait takes the call's cluster. */
function longWait(command: string): string[] {
  const use = { type: "assistant", timestamp: "2030-01-01T01:00:00.000Z", message: { content: [{ type: "tool_use", id: "w1", name: "Bash", input: { command } }] } };
  const done = { type: "user", timestamp: "2030-01-01T01:10:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok", is_error: false }] } };
  return [JSON.stringify(use), JSON.stringify(done)];
}
const waitClusters = (command: string) => transcriptSignals(longWait(command), WINDOW).map((s) => s.cluster);

describe("the shared ci-wait head rule", () => {
  it.each(SHARED_HEADS)("treats %s as a ci-wait head in both the gap cause and the friction cluster", (head) => {
    expect(CI_WAIT_HEAD.test(head)).toBe(true);
    expect(gapCauseOf([{ tool: "Bash", heads: [head] }])).toBe("ci-wait");
    expect(waitClusters(`${head} 12`)).toEqual(["ci-wait"]);
  });

  it("treats gh run rerun as ci-wait in both places, since the gh run family is one head", () => {
    expect(gapCauseOf([{ tool: "Bash", heads: ["gh run"] }])).toBe("ci-wait");
    expect(waitClusters("gh run rerun 7")).toEqual(["ci-wait"]);
  });

  it("finds the head after a chain in a command line but not in a head", () => {
    expect(CI_WAIT_IN_COMMAND.test("git status; gh pr checks 3")).toBe(true);
    expect(CI_WAIT_HEAD.test("git status; gh pr checks 3")).toBe(false);
  });

  it("does not call other gh commands a ci-wait in either place", () => {
    expect(gapCauseOf([{ tool: "Bash", heads: ["gh pr merge"] }])).toBe("other-bash");
    expect(waitClusters("gh pr merge 3")).toEqual(["other"]);
  });

  it.each(["cat ci-wait-head.ts", "grep ci-wait x", "vim src/ci-wait.ts"])("keeps the prior cluster for %s, which only mentions the helper", (command) => {
    expect(CI_WAIT_IN_COMMAND.test(command)).toBe(false);
    expect(waitClusters(command)).toEqual(["other"]);
  });

  it.each(["ci-wait 12", "cd x && ci-wait 12", "./bin/ci-wait", "git push; ci-wait"])("reads %s as an invocation of the helper", (command) => {
    expect(CI_WAIT_IN_COMMAND.test(command)).toBe(true);
  });
});
