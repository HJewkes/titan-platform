import type { GateRecord } from "@titan-design/hitl";
import { describe, expect, it } from "vitest";
import { ownerFriction } from "./owner-friction.js";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-07T08:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();
const NOW = Date.parse("2026-10-08T16:00:00Z");

function gate(stem: string, openedAt: number, closed?: { at: number; by: "owner-terminal" | "owner-remote" | "coordinator" }): GateRecord {
  return {
    id: `run-${stem}-${openedAt}/${stem}:0`,
    prompt: "p",
    schema: undefined,
    status: closed ? "resolved" : "pending",
    payload: undefined,
    reason: undefined,
    createdAt: iso(openedAt),
    resolvedAt: closed ? iso(closed.at) : undefined,
    expiresAt: undefined,
    resolvedBy: closed ? { class: closed.by, id: "someone", channel: "terminal" } : undefined,
    resolvedEvidence: undefined,
    rule: undefined,
    summary: undefined,
    evidenceRef: undefined,
    questions: undefined,
  };
}

const owner = (at: number) => ({ at, by: "owner-terminal" as const });

describe("ownerFriction", () => {
  it("gives the exact median and max waited hours per gate kind on the day the owner resolved them", () => {
    const gates = [
      gate("approve-merge", T0, owner(T0 + 1 * HOUR)),
      gate("approve-merge", T0, owner(T0 + 4 * HOUR)),
      gate("approve-merge", T0, owner(T0 + 10 * HOUR)),
      gate("ci-failed", T0, owner(T0 + 2 * HOUR)),
      gate("ci-failed", T0, owner(T0 + 5 * HOUR)),
      gate("main-frozen", T0, { at: T0 + 3 * HOUR, by: "owner-remote" }),
    ];

    const [day] = ownerFriction(gates, NOW);

    expect(day).toEqual({
      day: "2026-10-07",
      ownerTouches: 6,
      kinds: [
        { kind: "approve-merge", gates: 3, medianHours: 4, maxHours: 10 },
        { kind: "ci-failed", gates: 2, medianHours: 3.5, maxHours: 5 },
        { kind: "main-frozen", gates: 1, medianHours: 3, maxHours: 3 },
      ],
    });
  });

  it("counts an open gate to the injected now, on the day of now, without an owner touch", () => {
    const rows = ownerFriction([gate("sh-sent-back", NOW - 7.5 * HOUR)], NOW);

    expect(rows).toEqual([{ day: "2026-10-08", ownerTouches: 0, kinds: [{ kind: "sh-sent-back", gates: 1, medianHours: 7.5, maxHours: 7.5 }] }]);
  });

  it("does not count a gate a non-owner resolved as an owner touch or a wait", () => {
    const rows = ownerFriction([gate("approve-merge", T0, { at: T0 + HOUR, by: "coordinator" })], NOW);

    expect(rows).toEqual([]);
  });

  it("keeps days apart, oldest first, and applies an inclusive date range", () => {
    const gates = [gate("stuck-behind", T0, owner(T0 + HOUR)), gate("stuck-behind", T0 + 24 * HOUR, owner(T0 + 26 * HOUR)), gate("stuck-behind", T0 + 48 * HOUR, owner(T0 + 49 * HOUR))];

    const rows = ownerFriction(gates, NOW, { from: "2026-10-07", to: "2026-10-08" });

    expect(rows.map((row) => row.day)).toEqual(["2026-10-07", "2026-10-08"]);
  });

  it("reads the kind from the step id and ignores the iteration suffix", () => {
    const withSuffix = { ...gate("approve-merge", T0, owner(T0 + HOUR)), id: "run/approve-merge:3" };
    const bare = { ...gate("approve-merge", T0, owner(T0 + HOUR)), id: "run/approve-merge" };

    expect(ownerFriction([withSuffix, bare], NOW)[0]!.kinds).toEqual([{ kind: "approve-merge", gates: 2, medianHours: 1, maxHours: 1 }]);
  });
});
