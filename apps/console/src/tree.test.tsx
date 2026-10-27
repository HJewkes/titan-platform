// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { errorEnvelope, invokeCommand } from "@titan-design/registry";
import type { DataSource } from "@titan-design/rpc-client";
import { brokerReader } from "../server/broker.js";
import { consoleCommands } from "../server/commands.js";
import { fixtureActiveWork } from "../server/fixtures.js";
import type { ConsoleContext } from "../server/owner-guard.js";
import { shepherdReader } from "../server/shepherd.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

const NO_AGENTS = { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), eventsDbPath: "/nonexistent/events.db", seatPrefixes: [] };
const OWNER: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: { credential: "session", issuedAt: 1_000, peerLocal: false }, ownerWrites: true };

afterEach(cleanup);

/** The tree page over the real `work.loops` command and the synthetic board, recording every call it makes. */
function mountTree(hash: string) {
  const commands = consoleCommands({ upstreams: [], agents: NO_AGENTS, sessions: { graphPath: "/nonexistent/graph.sqlite3" }, inbox: { dir: "/nonexistent/inbox" }, rounds: { dir: "/nonexistent/rounds" }, shepherd: shepherdReader(1), activeWork: fixtureActiveWork() });
  const calls: string[] = [];
  const call: DataSource["call"] = async (name, args) => {
    calls.push(name);
    if (name === "work.loops") return (await invokeCommand(commands["work.loops"], args, OWNER)).envelope;
    return errorEnvelope(`not stubbed: ${name}`, 1);
  };
  const live: DataSource = { call, subscribe: () => ({ close: () => undefined }) };
  window.location.hash = hash;
  render(
    <RpcProvider source={live}>
      <AnswerSourceProvider value={live}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  return calls;
}

const nodeButton = (title: string): HTMLElement => screen.getByRole("button", { name: new RegExp(`^(⚠ )?${title} · \\d+ closed in 14d, `) });

describe("tree page", () => {
  it("draws the dependency DAG by default with every node in its state", async () => {
    mountTree("#/tree");

    expect(await screen.findByRole("application", { name: /^Tech tree dependencies\./ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Dependencies", selected: true })).toBeTruthy();
    expect(nodeButton("Handshake retry").getAttribute("aria-label")).toMatch(/^Handshake retry · 4 closed in 14d, Done/);
    expect(nodeButton("Queue depth").getAttribute("aria-label")).toMatch(/^Queue depth · 1 closed in 14d, In progress/);
  });

  it("marks a not-started node with an unfinished dependency as locked", async () => {
    mountTree("#/tree");
    await screen.findByRole("application", { name: /^Tech tree dependencies\./ });

    const states = ["Backoff tuning", "Radio chapter", "Print run"].map((title) => nodeButton(title).getAttribute("aria-label")?.split(", ")[1]);

    expect(states).toEqual(["Locked", "Locked", "Locked"]);
  });

  it("flags a high-churn node with no done-when progress", async () => {
    mountTree("#/tree");
    await screen.findByRole("application", { name: /^Tech tree dependencies\./ });

    expect(screen.getByRole("button", { name: /^⚠ Battery chapters · 6 closed in 14d, In progress/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^⚠ Handshake retry/ })).toBeNull();
  });

  it("draws each dependency edge from the prerequisite to the node that needs it", async () => {
    mountTree("#/tree");
    await screen.findByRole("application", { name: /^Tech tree dependencies\./ });

    expect(screen.getByRole("button", { name: /^Handshake retry · 4 closed in 14d to Queue depth · 1 closed in 14d, unlocks/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Queue depth · 1 closed in 14d to Handshake retry/ })).toBeNull();
  });

  it("opens in the swimlane layout from a layout=lanes deep link", async () => {
    mountTree("#/tree?layout=lanes");

    expect(await screen.findByRole("application", { name: /^Tech tree in goal lanes\./ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Goal lanes", selected: true })).toBeTruthy();
    expect(nodeButton("Print run").getAttribute("aria-label")).toContain("Field handbook");
  });

  it("switches layout through the query string so the link keeps it", async () => {
    mountTree("#/tree");

    fireEvent.click(await screen.findByRole("tab", { name: "Goal lanes" }));

    await waitFor(() => expect(window.location.hash).toBe("#/tree?layout=lanes"));
    expect(await screen.findByRole("application", { name: /^Tech tree in goal lanes\./ })).toBeTruthy();
  });

  it("lists a selected node's loops, each leading to the loops page", async () => {
    mountTree("#/tree");
    await screen.findByRole("application", { name: /^Tech tree dependencies\./ });

    fireEvent.click(nodeButton("Handshake retry"));
    const loops = within(await screen.findByTestId("tree-node-loops"));
    fireEvent.click(loops.getByText("Station clocks stop drifting"));

    expect(loops.getByText("Relays retry a dropped handshake with backoff")).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe("#/loops"));
  });

  it("only reads, even when a node is selected", async () => {
    const calls = mountTree("#/tree");
    await screen.findByRole("application", { name: /^Tech tree dependencies\./ });

    fireEvent.click(nodeButton("Queue depth"));

    // console.build is the shell's own version read.
    expect([...new Set(calls)].sort()).toEqual(["console.build", "work.loops"]);
  });
});
