import type { WatchRow } from "../shepherd/view.js";
import type { DigestSources } from "../digest/collect.js";
import type { DigestModel } from "../digest/model.js";

export const NOW = new Date("2026-03-10T19:30:00Z");
export const SLOT = { date: "2026-03-10", hour: "12" };

export function watchRow(overrides: Partial<WatchRow>): WatchRow {
  return {
    repo: "acme/widgets",
    pr: 1,
    branch: "feat/x",
    runId: "11111111-1111-4111-8111-111111111111",
    task: "demo/T-1",
    phase: "ci",
    headSha: null,
    phaseSince: "2026-03-10T18:00:00Z",
    nextAction: "waiting for CI",
    pendingGate: null,
    held: null,
    stalled: null,
    ...overrides,
  };
}

export function fakeSources(overrides: Partial<DigestSources> = {}): DigestSources {
  return {
    rows: async () => [],
    gates: async () => [],
    agentChat: async () => {
      throw new Error("not stubbed");
    },
    queueAsks: () => [],
    seatCosts: () => [],
    ...overrides,
  };
}

export function emptyModel(overrides: Partial<DigestModel> = {}): DigestModel {
  return { slot: SLOT, generatedAt: NOW.toISOString(), since: "2026-03-10T13:30:00.000Z", needsYou: [], merged: [], stuck: [], seats: [], spend: [], gaps: [], ...overrides };
}
