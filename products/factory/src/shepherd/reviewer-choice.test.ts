import type { ReviewTarget, ReviewerAgent } from "@titan-design/review-panel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chooseReviewer, lineageFor } from "./reviewer-choice.js";
import type { Registration } from "./store.js";

const target: ReviewTarget = { repo: "octo/demo", pr: 7, head: "a".repeat(40) };

const agent = (name: string, spawnedBy: string | null, over: Partial<ReviewerAgent> = {}): ReviewerAgent => ({
  name,
  agentId: `agent-${name}`,
  sessionId: `session-${name}`,
  presence: "exited",
  spawnedBy,
  predecessor: null,
  fillTokens: 1_000,
  ...over,
});

/** Only the fields the choice reads: the opt-in reviewer, the implementer, and no hold or review ask. */
const registration = { implementer: "impl-a", policy: { reviewer: "rv-standing" }, held: false, holdReviewer: null, holdReason: null, reviewRequest: null } as unknown as Registration;

const standing = agent("rv-standing", "seat");
/** The seat's first generation, retired, is the only row that says the implementer spawned the seat. */
const retiredFirst = agent("seat", "impl-a", { agentId: "agent-seat-1" });
const roster = [{ ...agent("seat", "seat", { agentId: "agent-seat-2" }), predecessor: "seat" }, agent("impl-a", null), standing];

describe("chooseReviewer over a lineage with retired generations", () => {
  it("resumes the standing reviewer when the whole lineage clears it", () => {
    expect(chooseReviewer(target, registration, roster, { rows: roster, complete: true })).toMatchObject({ mode: "resume", reviewer: "rv-standing" });
  });

  it("spawns fresh rather than resume a standing reviewer whose seat's retired first generation the implementer spawned", () => {
    expect(chooseReviewer(target, registration, roster, { rows: [...roster, retiredFirst], complete: true })).toMatchObject({ mode: "spawn" });
  });

  it("never offers a row that is only in the lineage as the standing reviewer", () => {
    const live = roster.filter((row) => row !== standing);

    expect(chooseReviewer(target, registration, live, { rows: roster, complete: true })).toMatchObject({ mode: "spawn" });
  });
});

describe("lineageFor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("proves nothing when the lineage read fails, so no standing reviewer is resumed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const lineage = await lineageFor(async () => Promise.reject(new Error("broker down")), registration, roster);

    expect(lineage.complete).toBe(false);
    expect(chooseReviewer(target, registration, roster, lineage)).toMatchObject({ mode: "spawn" });
  });

  it("reads the lineage only for a registration that names a standing reviewer", async () => {
    const read = vi.fn(async () => ({ rows: roster, complete: true }));

    await lineageFor(read, { ...registration, policy: { ...registration.policy, reviewer: undefined } }, roster);
    expect(read).not.toHaveBeenCalled();
    expect(await lineageFor(read, registration, roster)).toEqual({ rows: roster, complete: true });
  });
});
