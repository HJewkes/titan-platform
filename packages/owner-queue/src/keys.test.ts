import { describe, expect, it } from "vitest";
import { askKey, componentKey, prKey, relationKind, roundAskKey, tokenKey, topicKey } from "./keys.js";
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
