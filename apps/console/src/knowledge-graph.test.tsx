// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { EgoGraph } from "../server/graph.js";
import { App } from "./App.js";

afterEach(cleanup);

const TASK = "task:OR-7";
const NOTE = "note:orbit-relay/2031-03-03-backoff-ceiling.md";
const SESSION = "session:00000000-0000-4000-8000-000000000007";
const LONELY = "task:OR-9";
const BUSY = "task:OR-11";
const FALLBACK = "task:OR-12";

const node = (ref: string, kind: EgoGraph["nodes"][number]["kind"], depth: 0 | 1 | 2, label: string) => ({ ref, kind, depth, label, degree: 1, expanded: depth < 2 });

/** A synthetic depth-2 ego: the task, a note mentioning it and a session that ran it. */
function ego(center: string, overrides: Partial<EgoGraph> = {}): EgoGraph {
  return {
    center,
    depth: 2,
    nodes: [node(center, "task", 0, center.slice(5)), node(NOTE, "note", 1, "Cap the backoff"), node(SESSION, "session", 2, "Tune the relay backoff")],
    edges: [
      { source: NOTE, target: center, kind: "mentions", validFrom: null, via: "context.graph" },
      { source: SESSION, target: NOTE, kind: "touched", validFrom: "2031-03-03T10:00:00Z" },
    ],
    counts: { note: 1, session: 1 },
    truncated: null,
    sources: { graph: "ok", mentions: "ok" },
    degraded: null,
    ...overrides,
  };
}

const egoKey = (ref: string): string => snapshotKey("graph.ego", { ref, depth: 2, include: [], limit: {} });

function snapshot(): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [egoKey(TASK)]: successEnvelope(ego(TASK)),
      [egoKey(NOTE)]: successEnvelope(ego(NOTE, { nodes: [node(NOTE, "note", 0, "Cap the backoff"), node(SESSION, "session", 1, "Tune the relay backoff")], edges: [{ source: SESSION, target: NOTE, kind: "touched", validFrom: "2031-03-03T10:00:00Z" }], counts: { session: 1 } })),
      [egoKey(LONELY)]: successEnvelope(ego(LONELY, { nodes: [node(LONELY, "task", 0, "OR-9")], edges: [], counts: {} })),
      [egoKey(BUSY)]: successEnvelope(ego(BUSY, { counts: { note: 40, session: 12, file: 9 }, truncated: { nodeCap: 150, edgeCap: 300, omitted: { note: 39, session: 11 }, omittedEdges: 0, collapsed: [{ kind: "file", via: "touched", count: 9 }] } })),
      [egoKey(FALLBACK)]: successEnvelope(ego(FALLBACK, { depth: 1, sources: { graph: "absent", mentions: "ok", fallback: "mentions" } })),
      [egoKey("task:OR-404")]: errorEnvelope("graph unreadable", 65),
    },
  };
}

function renderConsole(hash: string): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot()), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

const graphRoute = (ref: string): string => `#/knowledge/${encodeURIComponent(ref)}?tab=graph`;

describe("the knowledge graph tab", () => {
  it("draws the depth-2 ego around a task with its nodes and edges", async () => {
    renderConsole(graphRoute(TASK));
    expect(await screen.findByRole("application", { name: /^Records linked to task:OR-7\./ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Graph", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cap the backoff, Note, 1 hop/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Tune the relay backoff, Session, 2 hops/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Cap the backoff to OR-7, mentions/ })).toBeTruthy();
    const legend = within(screen.getByRole("list", { name: "Legend" })).getAllByRole("listitem").map((item) => item.textContent);
    expect(legend).toEqual(["Task", "Session", "Note", "mentions", "touched"]);
  });

  it("opens a pressed node's record", async () => {
    renderConsole(graphRoute(TASK));
    fireEvent.click(await screen.findByRole("button", { name: /^Cap the backoff, Note/ }));
    await waitFor(() => expect(window.location.hash).toBe(`#/knowledge/${encodeURIComponent(NOTE)}`));
  });

  it("asks for a record when the ego has no neighbours", async () => {
    renderConsole(graphRoute(LONELY));
    expect(await screen.findByText("No linked records.")).toBeTruthy();
    expect(screen.getByText("Pick a record to see its neighbours.")).toBeTruthy();
  });

  it("captions how many neighbours a cap hit shows", async () => {
    renderConsole(graphRoute(BUSY));
    expect(await screen.findByText("Showing 2 of 61 neighbours.")).toBeTruthy();
  });

  it("warns that only mention links show when the session graph is absent", async () => {
    renderConsole(graphRoute(FALLBACK));
    expect(await screen.findByText("Session links are unavailable; showing mention links only.")).toBeTruthy();
    expect(screen.queryByText(/^Showing \d+ of/)).toBeNull();
  });

  it("says so when the graph cannot be read", async () => {
    renderConsole(graphRoute("task:OR-404"));
    expect(await screen.findByText("Could not load graph: graph unreadable")).toBeTruthy();
  });

  it("switches a record to its graph through the query string", async () => {
    renderConsole(`#/knowledge/${encodeURIComponent(NOTE)}`);
    fireEvent.click(await screen.findByRole("tab", { name: "Graph" }));
    await waitFor(() => expect(window.location.hash).toBe(graphRoute(NOTE)));
    expect(await screen.findByRole("application", { name: /^Records linked to note:orbit-relay/ })).toBeTruthy();
  });

  it("graphs the ref named in the index page's Graph tab and asks for one when none is named", async () => {
    renderConsole(`#/knowledge?tab=graph&ref=${encodeURIComponent(TASK)}`);
    expect(await screen.findByRole("application", { name: /^Records linked to task:OR-7\./ })).toBeTruthy();
    cleanup();
    renderConsole("#/knowledge?tab=graph");
    expect(await screen.findByText("Pick a record to see its neighbours.")).toBeTruthy();
  });
});
