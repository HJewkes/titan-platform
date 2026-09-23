import { describe, expect, it } from "vitest";
import { MemoryMirrorState } from "./memory-state.js";
import type { PostedItem } from "./types.js";

const posted = (sourceId: string): PostedItem => ({
  sourceId,
  eventId: `$${sourceId}`,
  kind: "approval_request",
  approvable: true,
  status: "open",
  record: { v: 1, kind: "approval_request", machine: "m", session: "s", msg_id: sourceId, at: 1, truncated: false, redacted: false },
});

describe("MemoryMirrorState", () => {
  it("applies every field of one commit together", () => {
    const state = new MemoryMirrorState();

    state.commit({ posted: [posted("a"), posted("b")], closed: ["a"], applied: ["$r"], sourceCursor: "7", syncToken: "s1" });

    expect(state.openItems().map((item) => item.sourceId)).toEqual(["b"]);
    expect(state.byEventId("$a")?.status).toBe("closed");
    expect(state.hasApplied("$r")).toBe(true);
    expect([state.sourceCursor(), state.syncToken()]).toEqual(["7", "s1"]);
  });

  it("keeps earlier cursors when a commit omits them", () => {
    const state = new MemoryMirrorState();
    state.commit({ sourceCursor: "1", syncToken: "s1" });

    state.commit({ applied: ["$x"] });

    expect([state.sourceCursor(), state.syncToken()]).toEqual(["1", "s1"]);
  });

  it("restores a snapshot that later commits to the original do not reach", () => {
    const state = new MemoryMirrorState();
    state.commit({ posted: [posted("a")], sourceCursor: "1" });
    const restored = MemoryMirrorState.restore(state.snapshot());

    state.commit({ closed: ["a"], sourceCursor: "2" });

    expect(restored.bySourceId("a")?.status).toBe("open");
    expect(restored.sourceCursor()).toBe("1");
  });
});
