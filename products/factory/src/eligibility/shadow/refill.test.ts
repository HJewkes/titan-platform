import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { censusDispatchable } from "./census.js";
import { refillLanes, type RefillPorts } from "./refill.js";
import type { RuleFile, ShadowLane } from "./rule-file.js";

const NOW = new Date("2026-03-04T09:07:00Z");

function rulesWith(lanes: Partial<ShadowLane>[]): RuleFile {
  return {
    schema: "titan-dispatcher/v1",
    mode: "shadow",
    shadow: { enabled: true, dir: "/unused" },
    lanes: lanes.map((lane) => ({ initiative: "demo-init", tag: null, ...lane })),
    relax: [],
    intake: { minSeverity: "medium", expireDays: 28 },
    stop: { taskFixRounds: 3, spendMultiple: 2, usdPerPoint: 8, betStoppedPrs: 3, betFollowupMultiple: 2, checkpointEvery: 5 },
    upkeep: { capShare: 0.25, windowDays: 7, factoryOutcomes: [] },
    compare: undefined,
  };
}

function fakePorts(counts: Record<string, number>): RefillPorts & { sent: { to: string; text: string }[]; counted: string[] } {
  const sent: { to: string; text: string }[] = [];
  const counted: string[] = [];
  return {
    sent,
    counted,
    dispatchable: async (lane) => {
      counted.push(lane.tag ?? lane.initiative);
      return counts[lane.tag ?? lane.initiative] ?? 0;
    },
    send: async (to, text) => {
      sent.push({ to, text });
    },
  };
}

const shadowDir = (): string => mkdtempSync(join(tmpdir(), "refill-"));

describe("ready-stock refill", () => {
  it("asks the lane's coordinator for a refill when the lane is under its floor, naming the count and the floor", async () => {
    const ports = fakePorts({ "lane:alpha": 3 });
    const dir = shadowDir();

    const outcomes = await refillLanes({ rules: rulesWith([{ tag: "lane:alpha", floor: 5, coordinator: "alpha-coord" }]), dir, now: NOW, ports });

    expect(outcomes).toEqual([{ lane: "demo-init[lane:alpha]", to: "alpha-coord", floor: 5, count: 3, result: "sent" }]);
    expect(ports.sent).toHaveLength(1);
    expect(ports.sent[0]!.to).toBe("alpha-coord");
    expect(ports.sent[0]!.text).toMatch(/demo-init\[lane:alpha\] has 3 dispatchable task\(s\), under its floor of 5/);
    expect(readFileSync(join(dir, "refill", "2026-03-04.jsonl"), "utf8")).toContain('"lane":"demo-init[lane:alpha]"');
  });

  it("sends nothing for a lane at its floor", async () => {
    const ports = fakePorts({ "lane:alpha": 5 });

    const outcomes = await refillLanes({ rules: rulesWith([{ tag: "lane:alpha", floor: 5 }]), dir: shadowDir(), now: NOW, ports });

    expect(outcomes).toEqual([]);
    expect(ports.sent).toEqual([]);
  });

  it("sends no second request for a lane already asked today, and asks again the next day", async () => {
    const rules = rulesWith([{ tag: "lane:alpha", floor: 5 }]);
    const dir = shadowDir();
    const ports = fakePorts({ "lane:alpha": 1 });
    await refillLanes({ rules, dir, now: NOW, ports });

    const later = await refillLanes({ rules, dir, now: new Date("2026-03-04T21:37:00Z"), ports });
    const nextDay = await refillLanes({ rules, dir, now: new Date("2026-03-05T00:07:00Z"), ports });

    expect(later).toEqual([expect.objectContaining({ result: "already-sent", count: 1 })]);
    expect(nextDay).toEqual([expect.objectContaining({ result: "sent" })]);
    expect(ports.sent).toHaveLength(2);
  });

  it("sends to the compare operator when the lane names no coordinator", async () => {
    const ports = fakePorts({});

    await refillLanes({ rules: rulesWith([{ floor: 2 }]), dir: shadowDir(), now: NOW, ports });

    expect(ports.sent.map((message) => message.to)).toEqual(["tp-operator"]);
  });

  it("counts no lane when the rule file sets no floor", async () => {
    const ports = fakePorts({});

    const outcomes = await refillLanes({ rules: rulesWith([{ tag: "lane:alpha" }]), dir: shadowDir(), now: NOW, ports });

    expect(outcomes).toEqual([]);
    expect(ports.counted).toEqual([]);
  });

  it("reports a failed send and records nothing, so the next tick asks again", async () => {
    const rules = rulesWith([{ floor: 2 }]);
    const dir = shadowDir();
    const failing: RefillPorts = { dispatchable: async () => 0, send: async () => Promise.reject(new Error("no live session")) };

    const first = await refillLanes({ rules, dir, now: NOW, ports: failing });
    const retry = await refillLanes({ rules, dir, now: NOW, ports: fakePorts({}) });

    expect(first).toEqual([expect.objectContaining({ result: "failed", detail: "send: no live session" })]);
    expect(retry).toEqual([expect.objectContaining({ result: "sent" })]);
  });
});

describe("census dispatchable rule", () => {
  it("counts an open task tagged brief:ready that no blocking class claims", () => {
    expect(censusDispatchable({ tags: ["Brief:Ready=2026-03-01", "lane:alpha"], notes: "Source: a plan." })).toBe(true);
  });

  it("does not count a task without brief:ready", () => {
    expect(censusDispatchable({ tags: ["lane:alpha"] })).toBe(false);
  });

  it.each([
    ["an owner tag", { tags: ["brief:ready", "needs-owner"] }],
    ["a needs-decision tag", { tags: ["brief:ready", "needs-decision"] }],
    ["a parked tag", { tags: ["brief:ready", "parked"] }],
    ["a blocked tag", { tags: ["brief:ready", "blocked-by:X-1"] }],
    ["a plan-first tag", { tags: ["brief:ready", "kind:plan"] }],
    ["a superseded-at tag", { tags: ["brief:ready", "superseded-at:m2"] }],
    ["an owner-gated note", { tags: ["brief:ready"], notes: "Waits on the owner for a key." }],
    ["a note that opens with blocked", { tags: ["brief:ready"], notes: "  Blocked until the reader lands." }],
    ["a duplicate note", { tags: ["brief:ready"], notes: "Duplicate of X-2." }],
  ])("does not count a brief:ready task with %s", (_, task) => {
    expect(censusDispatchable(task)).toBe(false);
  });
});
