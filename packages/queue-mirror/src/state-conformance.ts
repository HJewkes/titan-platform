import { describe, expect, it } from "vitest";
import type { MirrorState, PostedItem } from "./types.js";

const posted = (sourceId: string): PostedItem => ({
  sourceId,
  eventId: `$${sourceId}`,
  kind: "approval_request",
  approvable: true,
  status: "open",
  record: {
    v: 1,
    kind: "approval_request",
    machine: "m",
    session: "s",
    msg_id: sourceId,
    at: 1,
    truncated: false,
    redacted: false,
  },
});

/** Behavior every MirrorState implementation must share; run over both Memory and Sqlite. */
export function runMirrorStateConformance(name: string, makeState: () => MirrorState): void {
  describe(name, () => {
    it("applies every field of one commit together, and openItems excludes closed", () => {
      const state = makeState();

      state.commit({ posted: [posted("a"), posted("b")], closed: ["a"], applied: ["$r"], sourceCursor: "7", syncToken: "s1" });

      expect(state.openItems().map((item) => item.sourceId)).toEqual(["b"]);
      expect(state.byEventId("$a")?.status).toBe("closed");
      expect(state.hasApplied("$r")).toBe(true);
      expect([state.sourceCursor(), state.syncToken()]).toEqual(["7", "s1"]);
    });

    it("keeps earlier cursors when a commit omits them", () => {
      const state = makeState();
      state.commit({ sourceCursor: "1", syncToken: "s1" });

      state.commit({ applied: ["$x"] });

      expect([state.sourceCursor(), state.syncToken()]).toEqual(["1", "s1"]);
    });

    it("round-trips the record exactly, including its optional fields", () => {
      const state = makeState();
      const item: PostedItem = {
        ...posted("a"),
        record: { ...posted("a").record, agent_id: "agent-1", tool_name: "bash", input_preview: 'a "quoted" value\nwith a newline' },
      };

      state.commit({ posted: [item] });

      expect(state.bySourceId("a")?.record).toEqual(item.record);
    });
  });
}
