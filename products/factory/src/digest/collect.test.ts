import { describe, expect, it } from "vitest";
import { fakeSources, NOW, SLOT, watchRow } from "../test-support/digest.js";
import { collectDigest } from "./collect.js";
import { readAgentChat, type Exec } from "./sources.js";

const failingAgentChat: Exec = async () => ({ code: 1, stdout: "", stderr: "error: unknown option '--json'\nUsage: agent-chat digest" });

describe("collectDigest", () => {
  it("turns an agent-chat that cannot print JSON into a gap line and keeps the Shepherd sections", async () => {
    const rows = [
      watchRow({ pr: 7, phase: "done", phaseSince: "2026-03-10T19:00:00Z", task: "demo/T-7" }),
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
});
