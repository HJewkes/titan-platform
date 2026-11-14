import { partialFake } from "@titan-design/test-kit";
import type { Verbs } from "../cli-types.js";
import { TaskSchema } from "@titan-design/pm";
import { describe, expect, it } from "vitest";
import type { LaneSignals } from "./back-pressure.js";
import {
  landedRuleHolds,
  mergedNotSwitchedOn,
  type LandedTask,
} from "./landed.js";
import { landedProvider } from "./landed-signals.js";

const LIMITS = { laneOpenPrs: 3, ownerQueue: 10, inflowWeeks: 2 };
const NOW = Date.parse("2026-11-18T12:00:00Z");
const SIGNALS: LaneSignals = { openPrs: 1, mergedNotDeployed: 0, unread: {} };

function laneTask(n: number, fields: Partial<LandedTask> = {}): LandedTask {
  return {
    key: `alpha/AL-${n}`,
    status: "open",
    source: "owner",
    created: "2026-10-01",
    doneAt: null,
    ownerSteps: [],
    ...fields,
  };
}

const restart = [{ kind: "restart" }];

function candidate(n: number) {
  return {
    task: TaskSchema.parse({
      id: `AL-${n}`,
      title: `Synthetic ${n}`,
      priority: 1,
      status: "open",
      created: "2026-11-01",
      updated: "2026-11-09",
      done_at: null,
    }),
  };
}

interface Case {
  laneTasks: LandedTask[];
  merged?: number[];
  eligible?: number[];
  signals?: LaneSignals;
}

function holds({
  laneTasks,
  merged = [],
  eligible = [9],
  signals = SIGNALS,
}: Case) {
  return landedRuleHolds({
    initiative: "alpha",
    eligible: eligible.map(candidate),
    laneTasks,
    mergedTasks: new Set(merged.map((n) => `alpha/AL-${n}`)),
    signals,
    limits: LIMITS,
    now: NOW,
  });
}

describe("merged-not-switched-on", () => {
  it("counts a merged task that is open with a restart owner step toward the limit", () => {
    const result = holds({
      laneTasks: [
        laneTask(1, { ownerSteps: restart }),
        laneTask(2, { ownerSteps: restart }),
      ],
      merged: [1, 2],
    });

    expect(result).toEqual([
      expect.objectContaining({
        task: "alpha/AL-9",
        codes: ["merged-not-switched-on"],
        numbers: {
          open: 1,
          mergedNotDeployed: 0,
          mergedNotSwitchedOn: 2,
          limit: 3,
        },
      }),
    ]);
  });

  it("frees the slot when the same task is done", () => {
    expect(
      holds({
        laneTasks: [
          laneTask(1, { status: "done", ownerSteps: restart }),
          laneTask(2, { ownerSteps: restart }),
        ],
        merged: [1, 2],
      })
    ).toEqual([]);
  });

  it("does not count a task whose only owner step is a sitting", () => {
    expect(
      mergedNotSwitchedOn(
        [laneTask(1, { ownerSteps: [{ kind: "sitting" }] })],
        new Set(["alpha/AL-1"])
      )
    ).toBe(0);
  });

  it("counts each switch-on kind and ignores an unmerged task", () => {
    const kinds = ["restart", "config", "release", "publish", "credential"].map(
      (kind, at) => laneTask(at + 1, { ownerSteps: [{ kind }] })
    );

    expect(
      mergedNotSwitchedOn(kinds, new Set(kinds.map((task) => task.key)))
    ).toBe(5);
    expect(mergedNotSwitchedOn(kinds, new Set())).toBe(0);
  });

  it("holds only the candidates past the slots left, in dispatch order", () => {
    const result = holds({
      laneTasks: [laneTask(1, { ownerSteps: restart })],
      merged: [1],
      eligible: [7, 8, 9],
    });

    expect(result.map((hold) => hold.task)).toEqual([
      "alpha/AL-8",
      "alpha/AL-9",
    ]);
  });

  it("adds nothing when the open count is unread", () => {
    expect(
      holds({
        laneTasks: [laneTask(1, { ownerSteps: restart })],
        merged: [1],
        signals: { unread: { openPrs: "down" } },
      })
    ).toEqual([]);
  });
});

describe("filing-paused", () => {
  const paused = (fields: Partial<LandedTask>, n: number): LandedTask =>
    laneTask(n, { created: "2026-11-03", ...fields });

  /** Two complete weeks (W45, W46) of inflow with no outflow: the flow is paused. */
  const filedInPausedWeeks = [
    paused({ source: "follow-up" }, 1),
    paused({ source: "owner" }, 2),
    paused({ source: "sweep", created: "2026-11-10" }, 3),
  ];

  it("refuses an agent-source task filed in a paused week", () => {
    expect(holds({ laneTasks: filedInPausedWeeks, eligible: [1] })).toEqual([
      expect.objectContaining({ task: "alpha/AL-1", codes: ["filing-paused"] }),
    ]);
  });

  it("never refuses an owner-source task", () => {
    expect(holds({ laneTasks: filedInPausedWeeks, eligible: [2] })).toEqual([]);
  });

  it("refuses nothing while outflow keeps up", () => {
    const flowing = [
      ...filedInPausedWeeks,
      laneTask(4, { created: "2026-09-01", doneAt: "2026-11-04T00:00:00Z" }),
      laneTask(5, { created: "2026-09-01", doneAt: "2026-11-11T00:00:00Z" }),
    ];

    expect(holds({ laneTasks: flowing, eligible: [1] })).toEqual([]);
  });

  it("leaves an agent-source task filed outside the paused weeks", () => {
    expect(
      holds({
        laneTasks: [
          ...filedInPausedWeeks,
          paused({ source: "audit", created: "2026-10-01" }, 6),
        ],
        eligible: [6],
      })
    ).toEqual([]);
  });
});

describe("landed provider", () => {
  const verbs = partialFake<Verbs>({});
  const lane = { initiative: "alpha", tag: null };

  it("holds through the read port and reads nothing for an empty lane", async () => {
    const reads: number[] = [];
    const provider = landedProvider(
      async () => (
        reads.push(1),
        {
          laneTasks: [laneTask(1, { ownerSteps: restart })],
          mergedTasks: new Set(["alpha/AL-1"]),
        }
      )
    );
    const ctx = {
      lane,
      verbs,
      now: NOW,
      signals: { ...SIGNALS, openPrs: 2 },
      limits: LIMITS,
    };

    expect((await provider({ ...ctx, eligible: [] })).holds).toEqual([]);
    expect(reads).toEqual([]);
    expect(
      (await provider({ ...ctx, eligible: [candidate(9)] })).holds.map(
        (hold) => hold.codes
      )
    ).toEqual([["merged-not-switched-on"]]);
  });
});
