import { describe, expect, it } from "vitest";
import { memoryHost } from "../host/index.js";
import type { JournalRow } from "../host/index.js";
import { foldAgent } from "./fold.js";
import {
  checkBackgroundable,
  checkSurfaceable,
  placementFor,
} from "./mode-switch.js";
import type { AgentIdentity } from "./types.js";

/**
 * CC-23: moving a running agent between headless and a terminal. A switch is a continuation, not
 * a second agent: same identity, same name, same conversation, different presentation. Only the
 * plan is tested here; stopping and relaunching a process is the product's.
 */

const identity = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  agentId: "a1",
  name: "scout",
  profile: "explorer",
  state: "live",
  origin: "spawned",
  spawnedBy: "human",
  spawnedAt: 1,
  brief: "",
  cwd: "/work/ws",
  isolation: "none",
  surface: "headless",
  sessionId: "sess-1",
  lastEventAt: 1,
  generation: 1,
  ...over,
});

describe("who may switch what", () => {
  it("sends a surfaced agent beside its requester when the requester has a window", () => {
    expect(placementFor("w0t1p2:UUID")).toBe("iterm-pane");
  });

  it("gives a background agent surfacing itself its own window to open", () => {
    expect(placementFor(undefined)).toBe("iterm-tab");
  });

  it("refuses to surface an agent that is already in a terminal", () => {
    expect(
      checkSurfaceable(identity({ surface: "iterm-pane" }), "scout")
    ).toMatch(/already in a terminal/);
  });

  it("refuses to background an agent that is already headless", () => {
    expect(checkBackgroundable(identity(), "scout", 999)).toMatch(
      /already running headless/
    );
  });

  it("refuses either direction for a session the broker did not launch", () => {
    const adopted = identity({ origin: "adopted" });

    expect(checkSurfaceable(adopted, "scout")).toMatch(/agent_teleport/);
    expect(
      checkBackgroundable({ ...adopted, surface: "iterm-pane" }, "scout", 9)
    ).toMatch(/agent_teleport/);
  });

  it("refuses to background a session that never reported the pid of Claude Code", () => {
    expect(
      checkBackgroundable(
        identity({ surface: "iterm-pane" }),
        "scout",
        undefined
      )
    ).toMatch(/pid of Claude Code/);
  });

  it("allows a headless agent to surface and a windowed one to background", () => {
    expect(checkSurfaceable(identity(), "scout")).toBeUndefined();
    expect(
      checkBackgroundable(identity({ surface: "iterm-pane" }), "scout", 7777)
    ).toBeUndefined();
  });

  it("refuses anything already retired, and a name nothing holds", () => {
    expect(checkSurfaceable(identity({ state: "retired" }), "scout")).toMatch(
      /retired/
    );
    expect(checkSurfaceable(undefined, "nobody")).toMatch(/no agent named/);
  });
});

describe("the roster after a switch", () => {
  const spawnRow: JournalRow = {
    kind: "agent_spawned",
    msgId: "a1",
    ref: null,
    actor: "human",
    target: "scout",
    ts: 1,
    body: null,
    meta: { name: "scout", surface: "headless", session_id: "sess-1" },
  };
  const resumed = (meta: Record<string, string>): JournalRow => ({
    kind: "agent_resumed",
    msgId: null,
    ref: "a1",
    actor: "human",
    target: null,
    ts: 2,
    body: null,
    meta,
  });

  const foldedThrough = (row: JournalRow): AgentIdentity | undefined => {
    const host = memoryHost();
    host.journal.append(spawnRow);
    host.journal.append(row);
    return foldAgent(host.journal.rowsFor("a1"));
  };

  it("reports where the agent is NOW, not where it started", () => {
    const agent = foldedThrough(resumed({ surface: "iterm-pane" }));

    expect(agent).toMatchObject({
      surface: "iterm-pane",
      agentId: "a1",
      name: "scout",
    });
  });

  it("leaves the surface alone on an ordinary resume, which does not carry one", () => {
    expect(foldedThrough(resumed({}))?.surface).toBe("headless");
  });
});
