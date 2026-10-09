import { describe, expect, it } from "vitest";
import { fakeSources, NOW, SLOT, watchRow } from "../test-support/digest.js";
import { collectDigest, type GateFact } from "./collect.js";
import { readAgentChat, type Exec } from "./sources.js";
import { collectNeeds } from "../needs/merged.js";
import { sources10_05 } from "../test-support/needs-10-05.js";

const RUN = "33333333-3333-4333-8333-333333333333";
const RESOLVE = `titan-factory gate resolve ${RUN} approve-merge --json '<payload>'`;

function gateFact(overrides: Partial<GateFact> = {}): GateFact {
  return { runId: RUN, stepId: "approve-merge", gateId: "g-1", prompt: "raw prompt", resolve: RESOLVE, createdAt: "2026-03-10T19:00:00Z", ...overrides };
}

const failingAgentChat: Exec = async () => ({ code: 1, stdout: "", stderr: "error: unknown option '--json'\nUsage: agent-chat digest" });

describe("collectDigest", () => {
  it("turns an agent-chat that cannot print JSON into a gap line and keeps the Shepherd sections", async () => {
    const rows = [
      watchRow({ pr: 7, phase: "done", outcome: { kind: "merged", reason: null }, phaseSince: "2026-03-10T19:00:00Z", task: "demo/T-7" }),
      watchRow({ pr: 8, held: { reason: "waiting on a design call" }, phaseSince: "2026-03-10T15:00:00Z" }),
    ];
    const sources = fakeSources({ rows: async () => rows, agentChat: (minutes) => readAgentChat(failingAgentChat, "agent-chat", minutes) });

    const model = await collectDigest({ sources, now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.gaps).toEqual(["agent-chat digest: exit 1: error: unknown option '--json'"]);
    expect(model.merged).toEqual([{ ref: "acme/widgets#7", title: "demo/T-7", at: "2026-03-10T19:00:00Z" }]);
    expect(model.stuck).toEqual([{ ref: "acme/widgets#8", reason: "held: waiting on a design call", since: "2026-03-10T15:00:00Z" }]);
  });

  it("leaves out a run that finished before the window", async () => {
    const rows = [watchRow({ pr: 3, phase: "done", phaseSince: "2026-03-09T10:00:00Z" }), watchRow({ pr: 4, phase: "failed", stalled: { reason: "boom" }, phaseSince: "2026-03-09T10:00:00Z" })];

    const model = await collectDigest({ sources: fakeSources({ rows: async () => rows }), now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.merged).toEqual([]);
    expect(model.stuck).toEqual([]);
  });

  it("reports a run that stopped unmerged under Stuck with its reason, never as merged", async () => {
    const rows = [watchRow({ pr: 6, phase: "done", outcome: { kind: "stopped", reason: "closed" }, phaseSince: "2026-03-10T19:00:00Z" })];

    const model = await collectDigest({ sources: fakeSources({ rows: async () => rows }), now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.merged).toEqual([]);
    expect(model.stuck).toEqual([{ ref: "acme/widgets#6", reason: "stopped: closed", since: "2026-03-10T19:00:00Z" }]);
  });

  it("reads asks, merged PRs and spend from agent-chat JSON", async () => {
    const json = {
      ledger: { available: true, escalations: [{ from: "seat-a", text: "approve acme/widgets#9?", at: 0 }], reports: [] },
      mergedPrs: [{ label: "https://github.com/acme/widgets/pull/12", detail: "Add a knob" }],
      spend: [{ account: "pool-a", now: { sevenDay: 41, fiveHour: 9, writtenAt: 0 }, stale: false }],
    };
    const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify(json), stderr: "" });

    const model = await collectDigest({ sources: fakeSources({ agentChat: (m) => readAgentChat(exec, "agent-chat", m) }), now: NOW, windowMinutes: 60, slot: SLOT });

    expect(model.needsYou).toEqual([{ text: "seat-a: approve acme/widgets#9?", source: "agent-chat", keys: ["pr:widgets#9"] }]);
    expect(model.merged).toEqual([{ ref: "acme/widgets#12", title: "Add a knob" }]);
    expect(model.spend).toEqual([{ pool: "pool-a", sevenDay: 41, fiveHour: 9, stale: false }]);
    expect(model.gaps).toEqual([]);
  });

  it("a pending gate becomes one ask with summary, evidence and resolve command", async () => {
    const gates = [gateFact({ summary: "Merge widgets#42, CI green", evidenceRef: "https://ci.example/run/1" })];
    const sources = fakeSources({ rows: async () => [watchRow({ pr: 42, runId: RUN })], gates: async () => gates });

    const model = await collectDigest({ sources, now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.needsYou).toEqual([
      {
        text: "acme/widgets#42 approve-merge: Merge widgets#42, CI green",
        evidence: "https://ci.example/run/1",
        command: RESOLVE,
        source: "factory",
        keys: ["gate:g-1", `run:${RUN}`, "pr:widgets#42"],
      },
    ]);
  });

  it("falls back to the prompt for a gate opened before the brief migration", async () => {
    const model = await collectDigest({ sources: fakeSources({ gates: async () => [gateFact()] }), now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.needsYou.map((ask) => ask.text)).toEqual(["33333333 approve-merge: raw prompt"]);
  });

  it("a gate opened before the window start is marked waiting since its createdAt", async () => {
    const gates = [gateFact({ gateId: "old", createdAt: "2026-03-10T13:29:00Z" }), gateFact({ gateId: "new", createdAt: "2026-03-10T13:31:00Z" })];

    const model = await collectDigest({ sources: fakeSources({ gates: async () => gates }), now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.needsYou.map((ask) => ask.since)).toEqual(["2026-03-10T13:29:00Z", undefined]);
  });
});

describe("collectDigest with the merged owner list", () => {
  it("reads needsYou from the merged list, asks only (no news), not the separate gate, queue and chat reads", async () => {
    const [first, second] = await sources10_05();
    const list = await collectNeeds([first!, second!]);
    const sources = fakeSources({ gates: async () => [gateFact()], needs: async () => list });

    const model = await collectDigest({ sources, now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.needsYou).toHaveLength(5 + 36);
    expect(model.needsYou.map((ask) => ask.text)).not.toContain("widgets#9 approve-merge: raw prompt");
  });

  it("carries the list's gaps into the digest", async () => {
    const sources = fakeSources({ needs: async () => ({ items: [], gaps: ["agent-chat: down"], overlaps: [], counts: {} }) });

    const model = await collectDigest({ sources, now: NOW, windowMinutes: 360, slot: SLOT });

    expect(model.gaps).toContain("agent-chat: down");
  });
});
