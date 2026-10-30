// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { BELOW_MD } from "./pages/phone.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type RosterEntry = ConsoleCommands["agents.roster"]["result"]["agents"][number];
type Session = ConsoleCommands["sessions.list"]["result"]["sessions"][number];

// Synthetic roster and runs; nothing here comes from a real broker or session graph.
function agent(name: string, overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id: `${name}@1`, idSource: "nameAtRegisteredAt", name, agentId: null, state: "working", stateSource: "presence", origin: "spawned",
    workingOn: null, cwd: null, gitBranch: null, seat: null, surface: null, profile: null, taskId: null, spawnedBy: null, claudeSessionId: null,
    registeredAt: 1_000, spawnedAt: null, lastEventAt: 9_000, idleMs: 0, dnd: false, provisional: false, tags: [], costUsd: null, costSource: null,
    ...overrides,
  };
}

const LONG_NAME = "harbor-dock-index-implementer";
const RUN: Session = {
  sessionId: "run-1", title: "Dock index build", startedAt: "2031-03-04T10:00:00.000Z", endedAt: "2031-03-04T10:30:00.000Z", cwd: null, gitBranch: null,
  turnCount: 12, transcript: null, agentName: LONG_NAME, parentSessionId: null, taskIds: ["HB-7"], prs: [], usage: [], costUsd: 0.5,
};

const SNAPSHOT: Snapshot = {
  format: SNAPSHOT_FORMAT,
  createdAt: "2031-03-05T00:00:00.000Z",
  calls: {
    [snapshotKey("agents.roster", {})]: successEnvelope({
      agents: [agent("harbor-coord"), agent(LONG_NAME, { state: "exited", spawnedBy: "harbor-coord", taskId: "HB-7", costUsd: 1.25, workingOn: "Build the dock index" })],
      brokerUptimeMs: 60_000, reconnecting: false, history: { events: 40, limit: 1000, oldestAt: 1_000 }, generatedAt: 10_000,
    }),
    [snapshotKey("sessions.list", { agent: LONG_NAME, limit: 50 })]: successEnvelope({ sessions: [RUN], nextBefore: null, degraded: null }),
  },
};

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("the agents pages on a phone", () => {
  it("stacks the roster into cards with each agent's name, state, work and spawner instead of the table", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/agents");

    const card = await screen.findByTestId(`agent-card-${LONG_NAME}`);
    expect(screen.queryAllByTestId(/^agent-row-/)).toEqual([]);
    expect(screen.getAllByTestId(/^agent-card-/)).toHaveLength(2);
    for (const text of [LONG_NAME, "exited", "Build the dock index"]) expect(within(card).getByText(text)).toBeTruthy();
    expect(within(card).getByText(/Spawned by harbor-coord · \$1\.25 · last seen/)).toBeTruthy();
    expect(within(card).getByText(LONG_NAME).className).toContain("max-md:min-w-11");
  });

  it("gives the roster tabs a 44px tap target", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/agents");

    expect((await screen.findByRole("tab", { name: "Messages" })).className).toContain("max-md:min-h-11");
  });

  it("wraps a long agent name on the detail card instead of cutting it off", async () => {
    onPhone();
    renderPage(SNAPSHOT, `#/agents/${LONG_NAME}`);

    const name = await within(await screen.findByTestId("agent-card")).findByTestId("agent-card-name");
    expect(name.className).toContain("max-md:whitespace-normal");
  });

  it("lists the agent's runs as cards linking to each session", async () => {
    onPhone();
    renderPage(SNAPSHOT, `#/agents/${LONG_NAME}`);

    const run = await screen.findByTestId("run-card-run-1");
    expect(screen.queryAllByTestId(/^run-row-/)).toEqual([]);
    expect(within(run).getByText("Dock index build")).toBeTruthy();
    expect(within(run).getByText("HB-7 · 12 turns · $0.50")).toBeTruthy();
    expect(within(run).getByTestId("run-link-run-1").className).toContain("max-md:min-h-11");
  });

  it("keeps the roster table on a desktop", async () => {
    renderPage(SNAPSHOT, "#/agents");

    expect(await screen.findByTestId(`agent-row-${LONG_NAME}`)).toBeTruthy();
    expect(screen.queryAllByTestId(/^agent-card-/)).toEqual([]);
  });
});
