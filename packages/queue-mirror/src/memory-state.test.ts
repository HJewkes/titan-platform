import { describe, expect, it } from "vitest";
import { MemoryMirrorState } from "./memory-state.js";
import { runMirrorStateConformance } from "./state-conformance.js";
import type { PostedItem } from "./types.js";

const posted = (sourceId: string): PostedItem => ({
  sourceId,
  eventId: `$${sourceId}`,
  kind: "approval_request",
  approvable: true,
  status: "open",
  record: { v: 1, kind: "approval_request", machine: "m", session: "s", msg_id: sourceId, at: 1, truncated: false, redacted: false },
});

runMirrorStateConformance("MemoryMirrorState", () => new MemoryMirrorState());

describe("MemoryMirrorState", () => {
  it("restores a snapshot that later commits to the original do not reach", () => {
    const state = new MemoryMirrorState();
    state.commit({ posted: [posted("a")], sourceCursor: "1" });
    const restored = MemoryMirrorState.restore(state.snapshot());

    state.commit({ closed: ["a"], sourceCursor: "2" });

    expect(restored.bySourceId("a")?.status).toBe("open");
    expect(restored.sourceCursor()).toBe("1");
  });
});
