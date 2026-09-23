import { MAX_CONTENT_BYTES, TRUNCATED_LINE, contentBytes, encodeItem, renderItemBody } from "@titan-design/matrix-bus";
import { describe, expect, it } from "vitest";
import { syncFilter, toItemInput } from "./render.js";
import type { QueueItem } from "./types.js";

const approval = (inputPreview: string): QueueItem => ({
  id: "req-1",
  kind: "approval_request",
  machine: "mbp",
  session: "tp316",
  at: 1_000,
  toolName: "Bash",
  inputPreview,
});

describe("toItemInput", () => {
  it("truncates an oversize preview until the encoded content fits", () => {
    const input = toItemInput(approval("x".repeat(70_000)));

    expect(input.truncated).toBe(true);
    expect(contentBytes(encodeItem(input))).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
    expect(renderItemBody(input).endsWith(TRUNCATED_LINE)).toBe(true);
  });

  it("measures the encoded content, where JSON escaping inflates a preview that fits as a body", () => {
    const input = toItemInput(approval('"'.repeat(35_000)));

    expect(input.truncated).toBe(true);
    expect(contentBytes(encodeItem(input))).toBeLessThanOrEqual(MAX_CONTENT_BYTES);
  });

  it("redacts before cutting, so no fragment of a secret straddling the cut survives", () => {
    const secret = "token=" + "s".repeat(40_000);
    const input = toItemInput(approval(`${"y".repeat(20_000)} ${secret}`));

    expect(input.redacted).toBe(true);
    expect(input.truncated).toBe(false);
    expect(input.input_preview).not.toContain("sss");
  });

  it("keeps a clean item whole with both flags false", () => {
    const input = toItemInput({ ...approval("ls -la"), agentId: "a1" });

    expect(input).toMatchObject({ msg_id: "req-1", agent_id: "a1", input_preview: "ls -la", truncated: false, redacted: false });
  });

  it("redacts endorsement text but not question text", () => {
    const base = { id: "q", machine: "m", session: "s", at: 1, text: "use API_KEY=abc" } as const;

    expect(toItemInput({ ...base, kind: "endorse_request" }).text).toBe("use API_KEY=[REDACTED]");
    expect(toItemInput({ ...base, kind: "question" })).toMatchObject({ text: "use API_KEY=abc", redacted: false });
  });
});

describe("syncFilter", () => {
  it("limits the timeline to the one room", () => {
    expect(syncFilter("!q:hub")).toMatchObject({ room: { rooms: ["!q:hub"] } });
  });
});
