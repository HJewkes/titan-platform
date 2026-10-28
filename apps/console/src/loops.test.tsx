// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { errorEnvelope, EXIT, invokeCommand } from "@titan-design/registry";
import type { DataSource } from "@titan-design/rpc-client";
import { failure, type ActiveWork } from "../server/active-work.js";
import { brokerReader } from "../server/broker.js";
import { consoleCommands } from "../server/commands.js";
import { fixtureActiveWork } from "../server/fixtures.js";
import { REFUSALS, type ConsoleContext } from "../server/owner-guard.js";
import { shepherdReader } from "../server/shepherd.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

const NO_AGENTS = { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), eventsDbPath: "/nonexistent/events.db", seatPrefixes: [] };
const LOOPBACK: ConsoleContext = { warnings: [], format: "json", surface: "http", auth: null, ownerWrites: true };
const OWNER: ConsoleContext = { ...LOOPBACK, auth: { credential: "session", issuedAt: 1_000, peerLocal: false } };
const OWNER_WRITES_OFF: ConsoleContext = { ...OWNER, ownerWrites: false };

/** The old daemon's answer to a command it does not have. */
const OLD_DAEMON: ActiveWork = { read: () => Promise.reject(failure("active-work loop.board: Unknown command: loop.board", EXIT.USAGE)) };

afterEach(cleanup);

interface Setup {
  activeWork?: ActiveWork;
  /** Who reads the board, which decides whether its tiers are writable. */
  reader?: ConsoleContext;
  /** Who writes a move. */
  writer?: ConsoleContext;
}

/** The loops page over the real `work.*` commands and the synthetic board, recording every call it makes. */
function mountLoops({ activeWork = fixtureActiveWork(), reader = OWNER, writer = OWNER }: Setup = {}) {
  const commands = consoleCommands({ upstreams: [], agents: NO_AGENTS, sessions: { graphPath: "/nonexistent/graph.sqlite3" }, inbox: { dir: "/nonexistent/inbox" }, rounds: { dir: "/nonexistent/rounds" }, shepherd: shepherdReader(1), activeWork });
  const calls: { name: string; args: unknown }[] = [];
  const call: DataSource["call"] = async (name, args) => {
    calls.push({ name, args });
    if (name === "work.loops") return (await invokeCommand(commands["work.loops"], args, reader)).envelope;
    if (name === "work.loop-tier") return (await invokeCommand(commands["work.loop-tier"], args, writer)).envelope;
    return errorEnvelope(`not stubbed: ${name}`, 1);
  };
  const live: DataSource = { call, subscribe: () => ({ close: () => undefined }) };
  window.location.hash = "#/loops";
  render(
    <RpcProvider source={live}>
      <AnswerSourceProvider value={live}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  return calls;
}

async function renderLoops(setup: Setup = {}) {
  const calls = mountLoops(setup);
  await screen.findByText(/Tiers are advisory/);
  return calls;
}

/** The loop ids a tier shows, in the order it shows them. */
const idsIn = (tier: string): string[] =>
  [...screen.getByTestId(`loop-tier-${tier}`).querySelectorAll("[data-loop-id]")].map((card) => card.getAttribute("data-loop-id") ?? "");

function moveWithMenu(title: string, option: string): void {
  fireEvent.click(screen.getByRole("combobox", { name: `Move ${title}` }));
  fireEvent.click(screen.getByRole("option", { name: option }));
}

const BATTERY = "The battery chapters read as one";

describe("loops page", () => {
  it("shows every tier labelled advisory, with each placed loop in its tier", async () => {
    await renderLoops();

    const labels = ["unsorted", "S", "A", "B", "C", "parked"].map((tier) => screen.getByTestId(`loop-tier-${tier}`).getAttribute("aria-label"));
    expect(labels).toEqual(["Tier Unsorted, advisory", "Tier S, advisory", "Tier A, advisory", "Tier B, advisory", "Tier C, advisory", "Tier Parked, advisory"]);
    expect([idsIn("A"), idsIn("B"), idsIn("C"), idsIn("parked")]).toEqual([["loop-c"], ["loop-d"], ["loop-e"], ["loop-f"]]);
  });

  it("puts a loop with no tier in the Unsorted tray", async () => {
    await renderLoops();

    expect(idsIn("unsorted")).toEqual(["2031-03-04-1500-relay-retry#1", "loop-g"]);
  });

  it("orders cards inside a tier by tier rank", async () => {
    await renderLoops();

    expect(idsIn("S")).toEqual(["loop-b", "loop-a"]);
  });

  it("moves a card with its Move to menu, sends work.loop-tier and reads the board again", async () => {
    const calls = await renderLoops();

    moveWithMenu(BATTERY, "Tier S");

    expect(idsIn("S")).toContain("loop-c");
    await waitFor(() => expect(calls.filter((call) => call.name === "work.loops")).toHaveLength(2));
    expect(calls.find((call) => call.name === "work.loop-tier")?.args).toEqual({ id: "loop-c", tier: "S" });
  });

  it("moves a card back when the console refuses the tier write", async () => {
    await renderLoops({ writer: OWNER_WRITES_OFF });

    moveWithMenu(BATTERY, "Tier S");
    const refused = await screen.findByTestId("loops-move-refused");

    expect(refused.textContent).toContain(REFUSALS.disabled);
    expect([idsIn("A"), idsIn("S").includes("loop-c")]).toEqual([["loop-c"], false]);
  });

  it("shows tiers read-only with the guard's reason when this viewer may not write", async () => {
    await renderLoops({ reader: LOOPBACK });

    expect(screen.getByTestId("loops-read-only").textContent).toContain(REFUSALS.noCredential);
    expect(screen.getByRole("combobox", { name: `Move ${BATTERY}` }).getAttribute("aria-disabled")).toBe("true");
    expect(within(screen.getByTestId("loop-tier-A")).getByTestId("loop-card-loop-c").closest("[draggable]")?.getAttribute("draggable")).toBe("false");
  });

  it("filters the tiers by initiative and status", async () => {
    await renderLoops();

    fireEvent.click(screen.getByRole("combobox", { name: "Initiative" }));
    fireEvent.click(screen.getByRole("option", { name: "orbit-relay" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "STALLED" }));

    expect(["unsorted", "S", "A", "parked"].flatMap(idsIn)).toEqual(["loop-b"]);
  });

  it("says a newer active-work is needed when the daemon has no loop.board", async () => {
    mountLoops({ activeWork: OLD_DAEMON });

    expect((await screen.findByTestId("loops-unavailable")).textContent).toContain("active-work ≥ 0.23 needed");
  });
});
