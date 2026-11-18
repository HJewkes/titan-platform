// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";

// Local noon, so "today" never straddles midnight whatever zone the test runs in.
const NOW = new Date(2031, 2, 5, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

const upstream = (id: string, reachable = true) => ({ id, label: `${id} upstream`, target: "http://127.0.0.1:7400", reachable, detail: reachable ? "ok" : "refused" });
const initiative = (slug: string, openTasks: number) => ({ slug, title: slug, openTasks, newestActivity: iso(NOW - HOUR), state: "focused", personal: false });
const session = (sessionId: string) => ({ sessionId, title: sessionId, startedAt: iso(NOW - HOUR), agentName: null });

interface Fixture {
  upstreams?: ReturnType<typeof upstream>[];
  sessions?: ReturnType<typeof session>[];
  nextBefore?: string | null;
}

function snapshot({ upstreams, sessions = [session("s-1")], nextBefore = null }: Fixture = {}): Snapshot {
  const ok = (data: unknown) => successEnvelope(data);
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: iso(NOW),
    calls: {
      [snapshotKey("upstreams.health", {})]: ok({ checkedAt: iso(NOW), upstreams: upstreams ?? ["work", "agents", "sessions"].map((id) => upstream(id)) }),
      [snapshotKey("work.portfolio", {})]: ok({ fetchedAt: "", personalKnown: true, parseErrors: [], initiatives: [initiative("alpha", 3), initiative("beta", 4)] }),
      [snapshotKey("work.tasks", { stage: "blocked" })]: ok({ fetchedAt: "", evidence: { repos: [], degraded: [] }, tasks: [] }),
      [snapshotKey("agents.queue", {})]: ok({ items: [], hidden: {}, open: 0, generatedAt: NOW }),
      [snapshotKey("agents.roster", {})]: ok({ agents: [{ id: "a", name: "a", stateSource: "presence" }, { id: "b", name: "b", stateSource: "history" }], brokerUptimeMs: HOUR, reconnecting: false, generatedAt: NOW }),
      [snapshotKey("sessions.list", { limit: 200 })]: ok({ nextBefore, degraded: null, sessions }),
      [snapshotKey("inbox.list", {})]: ok({ items: [], gaps: [], fyiCount: 0, readAt: iso(NOW), derived: [] }),
    },
  };
}

function renderHome(fixture?: Fixture): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot(fixture)), "text/html");
  renderPage(pageDataSource({ doc: page }), "#/");
}

const tile = async (label: string): Promise<HTMLElement> => screen.findByTestId(`count-${label}`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the home count tiles", () => {
  it("shows each of the four tiles with its label and value", async () => {
    renderHome();
    const expected: [string, string][] = [["Open tasks", "7"], ["Initiatives", "2"], ["Live agents", "1"], ["Sessions today", "1"]];
    for (const [label, value] of expected) {
      const element = await tile(label);
      expect(within(element).getByText(label)).toBeTruthy();
      expect(within(element).getByText(value)).toBeTruthy();
    }
  });

  it("shows the dash in the tile of a down upstream", async () => {
    renderHome({ upstreams: [upstream("work", false), upstream("agents"), upstream("sessions")] });
    expect(within(await tile("Open tasks")).getByText("–")).toBeTruthy();
    expect(within(await tile("Initiatives")).getByText("–")).toBeTruthy();
    expect(within(await tile("Live agents")).getByText("1")).toBeTruthy();
  });

  it("reads a full first page of today's sessions as a floor", async () => {
    renderHome({ sessions: [session("s-1"), session("s-2")], nextBefore: "cursor" });
    expect(within(await tile("Sessions today")).getByText("2+")).toBeTruthy();
  });
});
