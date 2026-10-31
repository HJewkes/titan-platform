// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { renderPage } from "./render-page.test-helpers.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

afterEach(cleanup);

type Roster = ConsoleCommands["agents.roster"]["result"];
type RosterEntry = Roster["agents"][number];

const NAME = "dock-impl";
const AGENT_ID = "4c1d9e0a7b22";
const CONFIRM = "c".repeat(64);
const TARGET = { target: { kind: "retire-agent", name: NAME } };

function agent(name: string, overrides: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id: `${name}@1`, idSource: "nameAtRegisteredAt", name, agentId: AGENT_ID, state: "exited", stateSource: "history", origin: "spawned",
    workingOn: null, cwd: "/work/dock", gitBranch: null, seat: null, surface: null, profile: "impl", taskId: null, spawnedBy: "dock-coord", claudeSessionId: null,
    registeredAt: 1_000, spawnedAt: 1_000, lastEventAt: 9_000, idleMs: null, dnd: false, provisional: false, tags: [], costUsd: null, costSource: null,
    ...overrides,
  };
}

const roster = (agents: RosterEntry[]): Roster => ({ agents, brokerUptimeMs: 60_000, reconnecting: false, history: { events: 10, limit: 1000, oldestAt: 1_000 }, generatedAt: 10_000 });

const readBack = { agent: NAME, agentId: AGENT_ID, state: "exited", profile: "impl", cwd: "/work/dock", spawnedBy: "dock-coord", authority: "RET-OR: allow", proposedBy: "you", proposal: "Retire from the agent page", effect: "Retire dock-impl (4c1d9e0): release its worktree if it holds no uncommitted or unmerged work, and free the name. Its transcript stays on disk" };
const ready = (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ status: "ready", target: TARGET.target, readBack, readAt: new Date().toISOString(), confirm: CONFIRM, expiresAt: new Date().toISOString() }));
const answered = (outcome: object, message: string) => (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome, message }));

type Tap = (args: unknown) => Promise<JsonEnvelope<unknown>>;

/** The agent page over a recorded roster; with `taps` the page is live and those commands answer as given. */
function renderAgent(entry: RosterEntry, taps?: Record<string, Tap>, hash = `#/agents/${entry.name}`): { name: string; args: unknown }[] {
  const empty = successEnvelope({ sessions: [], nextBefore: null, degraded: null });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: { [snapshotKey("agents.roster", {})]: successEnvelope(roster([entry, agent("dock-coord", { state: "working", stateSource: "presence" })])), [snapshotKey("sessions.list", { agent: entry.name, limit: 50 })]: empty } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: { name: string; args: unknown }[] = [];
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => (calls.push({ name, args }), taps?.[name] ? taps[name](args) : inner.call(name, args, options)) };
  renderPage(source, hash, { answers: taps ? source : null });
  return calls;
}

async function retire(): Promise<HTMLElement> {
  await act(async () => void fireEvent.click(await screen.findByTestId("agent-retire")));
  const sheet = await findTapSheet("agent-retire-confirm");
  expect(within(sheet).getByTestId("agent-retire-readback")).toBeTruthy();
  return sheet;
}

const tapConfirm = (): Promise<void> => act(async () => void fireEvent.click(screen.getByTestId("agent-retire-confirm-ok")));

describe("the agent page's Retire tap", () => {
  it("reads the agent back, then retires on the second tap and shows the broker's caveats", async () => {
    const calls = renderAgent(agent(NAME), { "taps.prepare": ready, "taps.act": answered({ status: "retired", name: NAME, caveats: [] }, "Retired dock-impl; the process had already exited") });

    const sheet = await retire();
    await tapConfirm();

    expect(within(sheet).getByText(/^Retire dock-impl \(4c1d9e0\)/)).toBeTruthy();
    expect(screen.getByTestId("agent-retire-confirm-outcome").textContent).toContain("Retired dock-impl; the process had already exited");
    expect(calls.filter((call) => call.name.startsWith("taps.")).map((call) => [call.name, call.args])).toEqual([
      ["taps.prepare", TARGET],
      ["taps.act", { ...TARGET, confirm: CONFIRM }],
    ]);
  });

  it("offers no force retire, even after the factory refused a plain one", async () => {
    renderAgent(agent(NAME), { "taps.prepare": ready, "taps.act": answered({ status: "refused", reason: "resolver", detail: "the worktree holds uncommitted work" }, "Not retired (resolver): the worktree holds uncommitted work") });

    const sheet = await retire();
    await tapConfirm();

    expect(screen.getByTestId("agent-retire-confirm-outcome").textContent).toContain("Not retired (resolver)");
    expect(within(sheet).queryByText(/force|discard/i)).toBeNull();
    expect(screen.queryByTestId("agent-retire-confirm-ok")).toBeNull();
  });

  it("shows a moved agent's current id", async () => {
    renderAgent(agent(NAME), { "taps.prepare": ready, "taps.act": answered({ status: "moved", currentHead: null, currentAgentId: "77aa00110022" }, "The name is now a different agent (77aa001), read again") });

    await retire();
    await tapConfirm();

    expect(screen.getByTestId("agent-retire-confirm-outcome").textContent).toContain("different agent (77aa001)");
  });

  it.each([
    ["a live agent", agent(NAME, { state: "working", stateSource: "presence" }), "dock-impl is working: retire a working agent at the terminal."],
    ["a seat", agent("tpc-seat", { seat: "tpc-seat" }), "A seat is retired by its owner session."],
  ])("offers %s no tap and says why", async (_label, entry, hint) => {
    renderAgent(entry, { "taps.prepare": ready });

    expect((await screen.findByTestId("agent-retire-hint")).textContent).toBe(hint);
    expect(screen.queryByTestId("agent-retire")).toBeNull();
  });

  it("offers an adopted session nothing", async () => {
    renderAgent(agent(NAME, { origin: "adopted", agentId: null }), { "taps.prepare": ready });

    await screen.findByTestId("agent-card");
    expect(screen.queryByTestId("agent-retire")).toBeNull();
    expect(screen.queryByTestId("agent-retire-hint")).toBeNull();
  });

  it("sends a snapshot page to the live console", async () => {
    renderAgent(agent(NAME));

    expect((await screen.findByTestId("agent-retire-hint")).textContent).toBe("This page is a snapshot: act from the live console, or run agent-chat agent retire dock-impl on the terminal.");
  });
});

describe("the agents roster filter", () => {
  it("keeps only finished, not retired agents when ticked", async () => {
    renderAgent(agent(NAME), undefined, "#/agents");
    await screen.findByTestId(`agent-row-${NAME}`);

    await act(async () => void fireEvent.click(screen.getByTestId("agents-finished")));

    expect(screen.getByTestId(`agent-row-${NAME}`)).toBeTruthy();
    expect(screen.queryByTestId("agent-row-dock-coord")).toBeNull();
  });
});
