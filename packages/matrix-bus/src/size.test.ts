import { describe, expect, it } from "vitest";
import { encodeItem } from "./item.js";
import { ContentTooLargeError, assertSendable } from "./size.js";

describe("assertSendable", () => {
  it("refuses a 70,000-byte body", () => {
    expect(() => assertSendable({ msgtype: "m.text", body: "x".repeat(70_000) })).toThrow(ContentTooLargeError);
  });

  it("counts bytes, not characters", () => {
    expect(() => assertSendable({ body: "é".repeat(31_000) })).toThrow(ContentTooLargeError);
    expect(() => assertSendable({ body: "e".repeat(31_000) })).not.toThrow();
  });

  it("accepts an ordinary item", () => {
    const item = encodeItem({ kind: "notice", machine: "edge1", session: "s", msg_id: "n1", at: 1, truncated: false, redacted: false, text: "done" });

    expect(() => assertSendable(item)).not.toThrow();
  });
});
