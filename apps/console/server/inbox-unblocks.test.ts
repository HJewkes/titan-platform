import { describe, expect, it } from "vitest";
import { fromDeposit, type OwnerItem, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { inboxItems } from "./inbox-view.js";

const LIVE = "live-seat";
const FILED_AT = new Date("2026-10-01T00:00:00.000Z");

const ask = (depositId: string, overrides: Partial<OwnerItemDeposit> = {}): OwnerItem =>
  fromDeposit({ depositId, asker: LIVE, kind: "decide", door: "two-way", summary: `Settle ${depositId}?`, context: "", ...overrides }, FILED_AT);

const sectionOfAsk = (item: OwnerItem): string | undefined => inboxItems([item], [], { liveAgents: new Set([LIVE]) })[0]?.section;

describe("a deposit's unblocks line", () => {
  it("files a live seat's ask with no unblocks line as planning", () => {
    expect(sectionOfAsk(ask("no-line"))).toBe("planning");
  });

  it("files a live seat's ask that states what it unblocks as blocking", () => {
    expect(sectionOfAsk(ask("with-line", { unblocksNow: "  the seat's next commit  " }))).toBe("blocking");
  });

  it("keeps the line trimmed and refuses one over 200 characters or across two lines", () => {
    expect(ask("trimmed", { unblocksNow: "  the seat's next commit  " }).unblocksNow).toBe("the seat's next commit");
    expect(() => ask("too-long", { unblocksNow: "x".repeat(201) })).toThrow();
    expect(() => ask("two-lines", { unblocksNow: "first\nsecond" })).toThrow();
  });
});
