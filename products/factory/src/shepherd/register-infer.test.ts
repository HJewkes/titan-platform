import { describe, expect, it } from "vitest";
import { implementerFromBranch, taskFromBranch } from "./register-infer.js";

describe("register inference from an agent-chat branch", () => {
  it("reads the agent name and task id from agent-chat/tc-tp-2239", () => {
    const branch = "agent-chat/tc-tp-2239";

    expect(implementerFromBranch(branch)).toBe("tc-tp-2239");
    expect(taskFromBranch(branch)).toBe("TP-2239");
  });

  it("takes the first id and ignores the trailing words in agent-chat/dc-td-554-review-errors", () => {
    const branch = "agent-chat/dc-td-554-review-errors";

    expect(implementerFromBranch(branch)).toBe("dc-td-554-review-errors");
    expect(taskFromBranch(branch)).toBe("TD-554");
  });

  it("names no implementer for a branch agent-chat did not cut, but still reads its id", () => {
    const branch = "feat/cc-784-retry";

    expect(implementerFromBranch(branch)).toBeUndefined();
    expect(taskFromBranch(branch)).toBe("CC-784");
  });

  it("reads no task from a branch with no id", () => {
    expect(taskFromBranch("agent-chat/review-errors")).toBeUndefined();
    expect(taskFromBranch("agent-chat/tc-e4")).toBeUndefined();
  });
});
