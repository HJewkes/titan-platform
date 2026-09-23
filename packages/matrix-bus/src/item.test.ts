import { describe, expect, it } from "vitest";
import { ITEM_KEY, decodeItem, encodeItem, type ItemInput } from "./item.js";

const approval: ItemInput = {
  kind: "approval_request",
  machine: "edge1",
  session: "tp-coord",
  agent_id: "agent-7",
  msg_id: "a3f91c",
  at: 1790000000000,
  tool_name: "Bash",
  input_preview: "gh run watch 1841 --exit-status",
  recipient: "tp-worker",
  truncated: false,
  redacted: false,
};

describe("item codec", () => {
  it("round-trips every record field through message content", () => {
    const content = encodeItem(approval);

    const decoded = decodeItem(content);

    expect(decoded).toEqual({ v: 1, ...approval });
  });

  it("renders an approval body the way section 4.2 shows it", () => {
    const content = encodeItem({ ...approval, recipient: undefined });

    expect(content.msgtype).toBe("m.text");
    expect(content.body).toBe("APPR from tp-coord (edge1)\nBash: gh run watch 1841 --exit-status\n\nreact ✅ allow, ❌ deny");
  });

  it("carries a question's full text in the body but not in the record", () => {
    const text = "Which branch?\n".repeat(500);
    const item: ItemInput = { kind: "question", machine: "edge1", session: "s", msg_id: "q1", at: 1, truncated: false, redacted: false, text };

    const content = encodeItem(item);

    expect(content.body).toContain(text);
    expect(content.body.split("\n").at(-1)).toBe("reply to answer, or reply dismiss");
    expect(content[ITEM_KEY]).not.toHaveProperty("text");
  });

  it("names the endorsement recipient and the terminal fallback for a truncated item", () => {
    const item: ItemInput = { kind: "endorse_request", machine: "edge1", session: "s", msg_id: "e1", at: 1, recipient: "peer", truncated: true, redacted: false, text: "draft" };

    const lines = encodeItem(item).body.split("\n");

    expect(lines[0]).toBe("ENDORSE from s (edge1) to peer");
    expect(lines.at(-1)).toBe("too large to approve from the phone; answer at the terminal");
  });

  it("adds formatted_body only when given", () => {
    expect(encodeItem(approval)).not.toHaveProperty("formatted_body");
    expect(encodeItem(approval, "<b>x</b>")).toMatchObject({ format: "org.matrix.custom.html", formatted_body: "<b>x</b>" });
  });

  it("decodes a foreign message to null", () => {
    expect(decodeItem({ msgtype: "m.text", body: "hello" })).toBeNull();
  });

  it("decodes an unknown version or a malformed record to null", () => {
    const record = encodeItem(approval)[ITEM_KEY];

    expect(decodeItem({ [ITEM_KEY]: { ...record, v: 2 } })).toBeNull();
    expect(decodeItem({ [ITEM_KEY]: { ...record, kind: "bogus" } })).toBeNull();
    expect(decodeItem({ [ITEM_KEY]: { ...record, at: "yesterday" } })).toBeNull();
  });
});
