// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleCommands } from "../server/commands.js";
import { BELOW_MD } from "./pages/phone.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type ListResult = ConsoleCommands["sessions.list"]["result"];
type Row = ListResult["sessions"][number];

const NEWEST = "c0ffee00-0000-4000-8000-000000000001";
const OLDEST = "c0ffee00-0000-4000-8000-000000000002";
const CURSOR = "2031-03-04T08:00:00.000Z";

// Synthetic session-graph rows; nothing here comes from a real graph.
function row(sessionId: string, startedAt: string, overrides: Partial<Row> = {}): Row {
  return {
    sessionId, title: "Retry a dropped handshake", startedAt, endedAt: new Date(Date.parse(startedAt) + 40 * 60_000).toISOString(), cwd: null, gitBranch: null,
    turnCount: 2, transcript: null, agentName: "orbit-builder", parentSessionId: null, taskIds: ["OR-12"], prs: ["pr:example/orbit#41"],
    usage: [{ model: "model-a", inputTokens: 1_000, cacheReadTokens: 200_000, cacheCreationTokens: 40_000, outputTokens: 9_000, requests: 12, costUsd: 3.4, priced: true }],
    costUsd: 3.4, ...overrides,
  };
}

const SNAPSHOT: Snapshot = {
  format: SNAPSHOT_FORMAT,
  createdAt: "2031-03-05T00:00:00.000Z",
  calls: {
    [snapshotKey("sessions.list", { limit: 50 })]: successEnvelope({ sessions: [row(NEWEST, "2031-03-05T10:00:00.000Z")], nextBefore: CURSOR, degraded: null }),
    [snapshotKey("sessions.list", { limit: 50, before: CURSOR })]: successEnvelope({ sessions: [row(OLDEST, "2031-03-03T12:00:00.000Z", { taskIds: ["OR-9"], prs: [] })], nextBefore: null, degraded: null }),
  },
};

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

describe("the sessions list on a phone", () => {
  it("stacks each session into a card with its agent, tasks, PR and figures instead of the table", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/sessions");

    const card = await screen.findByTestId(`session-card-${NEWEST}`);
    expect(screen.queryAllByTestId(/^session-row-/)).toEqual([]);
    for (const text of ["orbit-builder", "OR-12", /example\/orbit#41/]) expect(within(card).getByText(text)).toBeTruthy();
    expect(within(card).getByText("40m · 250K tokens · $3.40")).toBeTruthy();
  });

  it("gives the session, agent and task links a 44px tap target, and the short agent and task links 44px of width", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/sessions");

    const card = await screen.findByTestId(`session-card-${NEWEST}`);
    expect(within(card).getByTestId(`session-link-${NEWEST}`).className).toContain("max-md:min-h-11");
    for (const link of [within(card).getByText("orbit-builder"), within(card).getByText("OR-12")]) expect(link.className).toContain("max-md:min-w-11");
  });

  it("adds the older page as cards on Load more", async () => {
    onPhone();
    renderPage(SNAPSHOT, "#/sessions");

    fireEvent.click(await screen.findByText("Load more"));

    expect(within(await screen.findByTestId(`session-card-${OLDEST}`)).getByText("OR-9")).toBeTruthy();
  });

  it("keeps the table on a desktop", async () => {
    renderPage(SNAPSHOT, "#/sessions");

    expect(await screen.findByTestId(`session-row-${NEWEST}`)).toBeTruthy();
    expect(screen.queryAllByTestId(/^session-card-/)).toEqual([]);
  });
});
