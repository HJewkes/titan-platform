import { describe, expect, it } from "vitest";
import type { UsageMeasurement } from "../index.js";
import { ATTEMPT_ID_PATTERN, COST_ID_PATTERN, FILE_ID_PATTERN, POLICY_GATE_ID_PATTERN, PR_ID_PATTERN, commitRef, costId, policyGateId } from "./index.js";

const SHA = "9f2c0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b";
const conversation = { harness: "claude-code", namespace: "host-a", nativeId: "conv-1" };
const usage = { model: null, tokens: { input: 1, output: 1, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: 2 }, cost: null, source: "test" };

describe("trace id helpers", () => {
  it("builds a commit ref only from a full 40-character sha", () => {
    expect(commitRef("acme/docs", SHA)).toBe(`commit:acme/docs@${SHA}`);
    expect(() => commitRef("acme/docs", SHA.slice(0, 7))).toThrow(/40/);
    expect(() => commitRef("docs", SHA)).toThrow(/owner\/name/);
  });

  it("rejects truncated or non-numeric attempt ids", () => {
    expect(ATTEMPT_ID_PATTERN.test("workflow:run-1:draft:0:1")).toBe(true);
    expect(ATTEMPT_ID_PATTERN.test("workflow:a:b:c")).toBe(false);
    expect(ATTEMPT_ID_PATTERN.test("workflow:run-1:draft:x:1")).toBe(false);
  });

  it("scopes a policy gate id under its attempt and encodes the row", () => {
    const id = policyGateId("workflow:run-1:draft:0:1", "F5", "pr:open");
    expect(id).toBe("workflow:run-1:draft:0:1#policy:F5:pr%3Aopen");
    expect(POLICY_GATE_ID_PATTERN.test(id)).toBe(true);
    expect(() => policyGateId("run-1/draft", "F5", "row")).toThrow(/request key/);
  });

  it("keys delta costs by response and snapshot costs by scope and epoch", () => {
    const delta: UsageMeasurement = { ...usage, kind: "delta", responseId: "msg_01" };
    const first: UsageMeasurement = { ...usage, kind: "snapshot", scope: "turn", scopeId: "t-1", epoch: "e-1", sequence: 1 };
    expect(costId(conversation, delta)).toBe("cost:response:claude-code:host-a:conv-1:msg_01");
    expect(costId(conversation, first)).toBe("cost:conversation:claude-code:host-a:conv-1:turn:t-1:e-1");
    expect(costId(conversation, { ...first, sequence: 9 })).toBe(costId(conversation, first));
    expect(COST_ID_PATTERN.test(costId(conversation, first))).toBe(true);
  });

  it("gives two versions of one file different artifact ids", () => {
    expect(FILE_ID_PATTERN.test(`file:acme/docs/site/guide.md@${SHA}`)).toBe(true);
    expect(FILE_ID_PATTERN.test("file:acme/docs/site/guide.md")).toBe(false);
    expect(PR_ID_PATTERN.test("pr:acme/docs#12")).toBe(true);
    expect(PR_ID_PATTERN.test("pr:acme/docs#0")).toBe(false);
  });
});
