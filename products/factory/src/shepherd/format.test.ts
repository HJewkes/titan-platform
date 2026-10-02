import { describe, expect, it } from "vitest";
import { formatShepherd } from "./format.js";
import type { WatchRow } from "./view.js";

const HEAD = "a".repeat(40);

const row = (held: WatchRow["held"]): WatchRow => ({
  repo: "acme/widgets",
  pr: 1,
  branch: "feat/x",
  runId: "run-1",
  task: "demo/T-1",
  phase: "merging",
  headSha: HEAD,
  phaseSince: "2026-01-01T00:00:00.000Z",
  nextAction: "merging",
  pendingGate: null,
  held,
  stalled: null,
});

describe("the shepherd text view of a hold", () => {
  it("names the head and the reviewer session that satisfied the hold, in status and timeline", () => {
    const satisfied = row({ reason: "awaiting a named review", satisfiedAt: HEAD, satisfiedBy: "rv-sec (agent-rv/session-rv)" });
    const expected = `held: awaiting a named review, satisfied at ${HEAD} by rv-sec (agent-rv/session-rv)`;

    const status = formatShepherd("shepherd.status", [satisfied]);
    const timeline = formatShepherd("shepherd.timeline", { row: satisfied, entries: [] });

    expect(status).toContain(expected);
    expect(timeline).toContain(expected);
  });

  it("shows an unsatisfied hold by its reason alone", () => {
    expect(formatShepherd("shepherd.status", [row({ reason: "owner review" })])).toBe(`acme/widgets#1 merging ${HEAD.slice(0, 7)} merging [held: owner review]\n`);
  });
});
