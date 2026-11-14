import { describe, expect, it } from "vitest";
import { askKey, componentKey, parsePrKey, prKey, relationKind, roundAskKey, tokenKey, topicKey } from "./keys.js";
import { isMergeKey } from "./merge.js";
import { SHA_A } from "./test-fixtures.js";

describe("relation keys", () => {
  it("never make two items one item", () => {
    const keys = [askKey("q-7"), roundAskKey("button", "q1"), componentKey("Button"), tokenKey("color.alert"), topicKey("alerts")];

    expect(keys.filter(isMergeKey)).toEqual([]);
  });

  it("default a round question's ask key to its unit and question id", () => {
    expect(roundAskKey(" button ", "q1")).toBe("ask:button/q1");
  });

  it("match component, token and topic names regardless of case and spacing", () => {
    expect(componentKey(" Date  Picker ")).toBe(componentKey("date picker"));
    expect(tokenKey("Color.Alert")).toBe("token:color.alert");
    expect(topicKey("Alert colours")).toBe("topic:alert-colours");
  });

  it("refuse a blank name", () => {
    expect(() => topicKey("  ")).toThrow(/topic key needs a name/);
    expect(() => askKey("")).toThrow(/ask key needs a name/);
  });

  it("are told apart from merge keys and junk by relationKind", () => {
    expect([askKey("x"), componentKey("x"), tokenKey("x"), topicKey("x")].map(relationKind)).toEqual(["ask", "component", "token", "topic"]);
    expect(["task:TP-1", "pr:o/r#1", "topic:", "topic: ", "asks:x", "ask"].map(relationKind)).toEqual([null, null, null, null, null, null]);
  });

  it("are never read from a key with no colon, even one that starts with a kind", () => {
    expect(["topics", "askx", "tokenX", "components"].map(relationKind)).toEqual([null, null, null, null]);
  });
});

describe("prKey", () => {
  it("pins a PR to its head in the form mergeByKeys merges on", () => {
    const key = prKey("Owner/Repo", 12, SHA_A.toUpperCase());

    expect(key).toBe(`pr:owner/repo#12@${SHA_A}`);
    expect(isMergeKey(key)).toBe(true);
    expect(relationKind(key)).toBeNull();
  });
});

describe("parsePrKey", () => {
  it("reads a full-sha key as a pin", () => {
    expect(parsePrKey(`pr:o/r#1@${SHA_A}`)).toEqual({ pr: "o/r#1", sha: SHA_A });
  });

  it("reads a key with no head, or a short sha, as unpinned", () => {
    expect(parsePrKey("pr:o/r#1")).toEqual({ pr: "o/r#1", sha: null });
    expect(parsePrKey("pr:o/r#1@abc1234")).toEqual({ pr: "o/r#1", sha: null });
  });

  it("trims padded keys", () => {
    expect(parsePrKey(`  pr:o/r#1@${SHA_A}\n`)).toEqual({ pr: "o/r#1", sha: SHA_A });
  });

  it("lower-cases mixed-case keys, prefix included", () => {
    expect(parsePrKey(`PR:Owner/Repo#1@${SHA_A.toUpperCase()}`)).toEqual({ pr: "owner/repo#1", sha: SHA_A });
  });

  it("does not pin a malformed ref", () => {
    expect(parsePrKey(`pr:nonsense@${SHA_A}`)).toEqual({ pr: "nonsense", sha: null });
  });

  it("is null for keys that are not PR keys", () => {
    expect(parsePrKey("task:TP-1")).toBeNull();
  });
});
