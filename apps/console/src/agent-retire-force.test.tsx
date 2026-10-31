// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { z } from "zod";
import { renderPage } from "./render-page.test-helpers.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

afterEach(cleanup);

type Roster = ConsoleCommands["agents.roster"]["result"];
type RosterEntry = Roster["agents"][number];

const NAME = "dock-impl";
const AGENT_ID = "4c1d9e0a7b22";
const CONFIRM = "c".repeat(64);
const PLAIN = { kind: "retire-agent", name: NAME };
const FORCED = { ...PLAIN, force: true };
const EXITED_AT = "2031-03-05T00:00:00.000Z";
const WAIT = "Wait 47 s: agent-chat keeps a just-exited agent's worktree for 2 minutes so unpushed work is not lost";

const entry: RosterEntry = {
  id: `${NAME}@1`, idSource: "nameAtRegisteredAt", name: NAME, agentId: AGENT_ID, state: "exited", stateSource: "history", origin: "spawned",
  workingOn: null, cwd: "/work/dock", gitBranch: null, seat: null, surface: null, profile: "impl", taskId: null, spawnedBy: "dock-coord", claudeSessionId: null,
  registeredAt: 1_000, spawnedAt: 1_000, lastEventAt: 9_000, idleMs: null, dnd: false, provisional: false, tags: [], costUsd: null, costSource: null,
};

const readBack = (effect: string, exitedAt: string | null) => ({ agent: NAME, agentId: AGENT_ID, state: "exited", profile: "impl", cwd: "/work/dock", spawnedBy: "dock-coord", exitedAt, authority: "RET-OR: allow", proposedBy: "you", proposal: "Retire from the agent page", effect });

/** `taps.prepare` as the server answers it: the plain sheet carries `forceStop`, the forced one the force effect. */
const prepare =
  (forceStop: string | null, exitedAt: string | null = EXITED_AT) =>
  (args: unknown): Promise<JsonEnvelope<unknown>> => {
    const { target } = z.object({ target: z.looseObject({ force: z.boolean().optional() }) }).parse(args);
    const effect = target.force === true ? "Retire dock-impl (4c1d9e0) with --force: discard what its worktree holds" : "Retire dock-impl (4c1d9e0): release its worktree";
    return Promise.resolve(successEnvelope({ status: "ready", target, readBack: readBack(effect, exitedAt), forceStop, readAt: new Date().toISOString(), confirm: CONFIRM, expiresAt: new Date().toISOString() }));
  };
const retired = (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status: "retired", name: NAME, caveats: [] }, message: "Retired dock-impl; removed the worktree" }));

function renderAgent(taps: Record<string, (args: unknown) => Promise<JsonEnvelope<unknown>>>): { name: string; args: unknown }[] {
  const roster: Roster = { agents: [entry], brokerUptimeMs: 60_000, reconnecting: false, history: { events: 10, limit: 1000, oldestAt: 1_000 }, generatedAt: 10_000 };
  const empty = successEnvelope({ sessions: [], nextBefore: null, degraded: null });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls: { [snapshotKey("agents.roster", {})]: successEnvelope(roster), [snapshotKey("sessions.list", { agent: NAME, limit: 50 })]: empty } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const calls: { name: string; args: unknown }[] = [];
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name, args, options) => (calls.push({ name, args }), taps[name] ? taps[name](args) : inner.call(name, args, options)) };
  renderPage(source, `#/agents/${NAME}`, { answers: source });
  return calls;
}

async function openPlain(): Promise<HTMLElement> {
  await act(async () => void fireEvent.click(await screen.findByTestId("agent-retire")));
  const sheet = await findTapSheet("agent-retire-confirm");
  expect(within(sheet).getByTestId("agent-retire-readback")).toBeTruthy();
  return sheet;
}

describe("the agent page's forced retire", () => {
  it("reads the exit time back and offers force once the grace has passed, retiring with force on Retire and discard", async () => {
    const calls = renderAgent({ "taps.prepare": prepare(null), "taps.act": retired });

    const plain = await openPlain();
    expect(within(plain).getByTestId("agent-retire-exited").textContent).toBe(`exited ${EXITED_AT}`);
    await act(async () => void fireEvent.click(within(plain).getByTestId("agent-retire-force-open")));
    const forced = await findTapSheet("agent-retire-force");
    expect(within(forced).getByText(/with --force: discard/)).toBeTruthy();
    await act(async () => void fireEvent.click(within(forced).getByTestId("agent-retire-force-discard")));

    expect((await screen.findByTestId("agent-retire-force-outcome")).textContent).toContain("Retired dock-impl");
    expect(calls.filter((call) => call.name.startsWith("taps.")).map((call) => [call.name, call.args])).toEqual([
      ["taps.prepare", { target: PLAIN }],
      ["taps.prepare", { target: FORCED }],
      ["taps.act", { target: FORCED, confirm: CONFIRM }],
    ]);
  });

  it("says how long the grace still runs and offers no force inside it", async () => {
    renderAgent({ "taps.prepare": prepare(WAIT) });

    const plain = await openPlain();

    expect(within(plain).getByTestId("agent-retire-force-stop").textContent).toBe(`No forced retire: ${WAIT}`);
    expect(within(plain).queryByTestId("agent-retire-force-open")).toBeNull();
  });

  it("says the roster reports no exit time and offers no force", async () => {
    renderAgent({ "taps.prepare": prepare("agent-chat reports no exit time for dock-impl", null) });

    const plain = await openPlain();

    expect(within(plain).getByTestId("agent-retire-exited").textContent).toBe("agent-chat reports no exit time");
    expect(within(plain).queryByTestId("agent-retire-force-open")).toBeNull();
  });
});
