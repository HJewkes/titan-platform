// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HEAD = "0b7e2c1a5d4f4e8b9a1c3d5e7f9b0a2c4e6d8f01";

function item(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    sources: [{ system: "hitl", ref: `run-${id}/approve-merge` }],
    kind: "approve",
    door: "one-way",
    summary: `Summary of ${id}`,
    context: "",
    keys: [],
    personal: false,
    lens: "blocking-merge",
    unblocks: [],
    openedAt: ago(HOUR),
    status: "open",
    section: "blocking",
    evidence: undefined,
    action: { kind: "terminal", reason: "fixture" },
    ...overrides,
  };
}

const GATE = item("gate-1", {
  summary: "Merge example/repo#12",
  openedAt: ago(2 * HOUR),
  options: [
    { id: "merge", label: "merge" },
    { id: "hold", label: "hold" },
  ],
  recommended: { optionId: "merge", by: "fixture-reviewer" },
  command: "titan-factory gate resolve run-gate-1/approve-merge --decision merge",
  evidence: "https://github.com/example/repo/pull/12",
  action: { kind: "resolve-gate", gateId: "run-gate-1/approve-merge", runId: "run-gate-1", stepId: "approve-merge", repo: "example/repo", pr: 12, headSha: HEAD, decision: "merge" },
});

const HELD = item("held-1", {
  summary: "Merge example/repo#14",
  openedAt: ago(30 * 60 * 1000),
  hold: { class: "owner-asked", reason: "owner-asked: wait for the demo" },
  evidence: "#/shepherd/example%2Frepo%2314",
  action: { kind: "owner-release", repo: "example/repo", pr: 14, headSha: HEAD },
});

const ASK = item("ask-1", { sources: [{ system: "agent-chat", ref: "msg-1" }], kind: "decide", lens: "blocking-agent", summary: "Which relay port?", openedAt: ago(3 * HOUR), action: { kind: "answer-chat", msgId: "msg-1" } });

const ROUND = item("round-1", { sources: [{ system: "round", ref: "rd-7" }], kind: "review", summary: "Ship the inbox shots", openedAt: ago(5 * HOUR), evidence: "#/rounds/rd-7", action: { kind: "open-round", roundId: "rd-7" } });

const DEPOSIT = item("dep-1", {
  sources: [{ system: "deposit", ref: "dep-1" }],
  kind: "do",
  summary: "Publish the new package by hand",
  openedAt: ago(26 * HOUR),
  command: "pnpm publish --access public",
  action: { kind: "terminal", command: "pnpm publish --access public", reason: "a deposit is agent-written, so the console offers it no write; run its command" },
});

const PLANNING = Array.from({ length: 5 }, (_, n) =>
  item(`task-${n}`, { sources: [{ system: "active-work", ref: `orbit/OR-${n}` }], kind: "decide", lens: "planning", section: "planning", summary: `Plan OR-${n}`, evidence: `#/tasks/OR-${n}`, action: { kind: "open", route: `#/tasks/OR-${n}` } }),
);

interface Inbox {
  items?: Record<string, unknown>[];
  gaps?: string[];
  fyiCount?: number;
}

const inboxAnswer = ({ items = [GATE, HELD, ASK, ROUND, DEPOSIT, ...PLANNING], gaps = [], fyiCount = 42 }: Inbox = {}): JsonEnvelope<unknown> => successEnvelope({ items, gaps, fyiCount, readAt: new Date(NOW).toISOString() });

type Tap = (args: unknown) => Promise<JsonEnvelope<unknown>>;

interface Call {
  name: string;
  args: unknown;
}

/** Renders the inbox over a recorded snapshot; with `taps` the page is live and those commands answer as given. */
function renderInbox(answer: JsonEnvelope<unknown> = inboxAnswer(), taps?: Record<string, Tap>): Call[] {
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: answer } };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html");
  const inner = pageDataSource({ doc: page });
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), taps?.[name] ? taps[name](args) : inner.call(name, args, options)),
  };
  window.location.hash = "#/inbox";
  render(
    <RpcProvider source={source}>
      <AnswerSourceProvider value={taps ? source : null}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  return calls;
}

const CONFIRM = "c".repeat(64);
const READ_AT = new Date(NOW - 12_000).toISOString();

const ready = (overrides: Record<string, unknown> = {}): JsonEnvelope<unknown> =>
  successEnvelope({
    status: "ready",
    itemId: "gate-1",
    action: GATE.action,
    readBack: { repo: "example/repo", pr: 12, title: "Merge example/repo#12", headSha: HEAD, gateId: "run-gate-1/approve-merge", effect: "Approve the merge of example/repo#12 at 0b7e2c1" },
    readAt: READ_AT,
    confirm: CONFIRM,
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    ...overrides,
  });

const resolved = (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status: "resolved" }, message: "Merge approved" }));

function deferred(): { promise: Promise<JsonEnvelope<unknown>>; resolve: (value: JsonEnvelope<unknown>) => void } {
  let resolve!: (value: JsonEnvelope<unknown>) => void;
  const promise = new Promise<JsonEnvelope<unknown>>((done) => (resolve = done));
  return { promise, resolve };
}

const named = (calls: readonly Call[], name: string): Call[] => calls.filter((call) => call.name === name);

async function tapGate(): Promise<HTMLElement> {
  fireEvent.click(within(await screen.findByTestId("inbox-row-gate-1")).getByText("Approve merge"));
  return screen.findByTestId("inbox-confirm");
}

const confirmButton = (): HTMLElement => screen.getByTestId("inbox-confirm-ok");

const rowIds = (section: string): (string | null)[] => within(screen.getByTestId(section)).queryAllByTestId(/^inbox-row-/).map((row) => row.getAttribute("data-testid"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the inbox page", () => {
  it("lists the blockers in the order the server sent, with source badges and ages", async () => {
    renderInbox(inboxAnswer({ items: [HELD, GATE, ASK, ROUND, DEPOSIT] }));
    await screen.findByTestId("inbox-row-held-1");
    expect(rowIds("inbox-blocking")).toEqual(["inbox-row-held-1", "inbox-row-gate-1", "inbox-row-ask-1", "inbox-row-round-1", "inbox-row-dep-1"]);
    const badges = ["held-1", "gate-1", "ask-1", "round-1", "dep-1"].map((id) => within(screen.getByTestId(`inbox-row-${id}`)).getByText(/^(hold|gate|ask|round|terminal)$/).textContent);
    expect(badges).toEqual(["hold", "gate", "ask", "round", "terminal"]);
    expect(within(screen.getByTestId("inbox-row-gate-1")).getByText("2h")).toBeTruthy();
    expect(within(screen.getByTestId("inbox-row-dep-1")).getByText("1d")).toBeTruthy();
  });

  it("shows the recommendation chip by the option's label and the hold's reason", async () => {
    renderInbox();
    expect(within(await screen.findByTestId("inbox-row-gate-1")).getByText("Recommend: merge")).toBeTruthy();
    expect(within(screen.getByTestId("inbox-row-held-1")).getByText("owner-asked: wait for the demo")).toBeTruthy();
  });

  it("badges a gate under shepherd-release as a release", async () => {
    renderInbox(inboxAnswer({ items: [item("rel-1", { sources: [{ system: "hitl", ref: "run-rel/approve-merge" }], keys: ["recipe:shepherd-release/version-packages"] })] }));
    expect(within(await screen.findByTestId("inbox-row-rel-1")).getByText("release")).toBeTruthy();
  });

  it("opens a console-route evidence link inside the console and a URL in a new tab", async () => {
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    renderInbox();
    fireEvent.click(within(await screen.findByTestId("inbox-row-gate-1")).getByText("https://github.com/example/repo/pull/12"));
    expect(opened).toHaveBeenCalledWith("https://github.com/example/repo/pull/12", "_blank", "noopener");
    fireEvent.click(within(screen.getByTestId("inbox-row-held-1")).getByText("Open evidence"));
    await waitFor(() => expect(window.location.hash).toBe("#/shepherd/example%2Frepo%2314"));
  });

  it("offers every write as Run on terminal on a snapshot page, revealing the command and the reason", async () => {
    renderInbox();
    const held = await screen.findByTestId("inbox-row-held-1");
    expect(within(held).queryByText("Release hold")).toBeNull();
    fireEvent.click(within(held).getByText("Run on terminal"));
    expect(within(held).getByText(`titan-factory shepherd owner-release example/repo#14 --head ${HEAD}`)).toBeTruthy();
    expect(within(held).getByText("This page is a snapshot: act from the live console, or run it on the terminal.")).toBeTruthy();
    const deposit = screen.getByTestId("inbox-row-dep-1");
    fireEvent.click(within(deposit).getByText("Run on terminal"));
    expect(within(deposit).getByText("pnpm publish --access public")).toBeTruthy();
    expect(within(deposit).getByText("a deposit is agent-written, so the console offers it no write; run its command")).toBeTruthy();
  });

  it("copies a row's command", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderInbox();
    fireEvent.click(within(await screen.findByTestId("inbox-row-gate-1")).getByText("Copy command"));
    expect(writeText).toHaveBeenCalledWith("titan-factory gate resolve run-gate-1/approve-merge --decision merge");
    expect(await within(screen.getByTestId("inbox-row-gate-1")).findByText("Copied")).toBeTruthy();
  });

  it("offers no copy without a clipboard, as on a plain-http page, and still shows the command", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    renderInbox();
    const gate = await screen.findByTestId("inbox-row-gate-1");
    expect(within(gate).queryByText("Copy command")).toBeNull();
    fireEvent.click(within(gate).getByText("Run on terminal"));
    expect(within(gate).getByText("titan-factory gate resolve run-gate-1/approve-merge --decision merge")).toBeTruthy();
  });

  it("gives a round no terminal button, since opening it is navigation", async () => {
    renderInbox();
    expect(within(await screen.findByTestId("inbox-row-round-1")).queryByText("Run on terminal")).toBeNull();
  });

  it("starts the planning section collapsed with its count, and opens it on request", async () => {
    renderInbox();
    await screen.findByTestId("inbox-planning");
    expect(screen.getByText("Planning (5)")).toBeTruthy();
    expect(rowIds("inbox-planning")).toEqual([]);
    fireEvent.click(screen.getByText("Show 5 planning items"));
    expect(rowIds("inbox-planning")).toHaveLength(5);
  });

  it("counts FYIs as text only", async () => {
    renderInbox();
    expect((await screen.findByTestId("inbox-fyi")).textContent).toBe("FYI: 42");
  });

  it("issues only inbox.list until a row is tapped", async () => {
    const calls = renderInbox(inboxAnswer(), { "inbox.prepare": () => Promise.resolve(ready()), "inbox.act": resolved });
    await screen.findByTestId("inbox-row-gate-1");
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["inbox.list"]));
  });
});

describe("the inbox page, acting from the console", () => {
  it("labels each console tap with its verb and leaves the rest on the terminal", async () => {
    renderInbox(inboxAnswer(), { "inbox.prepare": () => Promise.resolve(ready()), "inbox.act": resolved });
    expect(within(await screen.findByTestId("inbox-row-gate-1")).getByText("Approve merge")).toBeTruthy();
    expect(within(screen.getByTestId("inbox-row-held-1")).getByText("Release hold")).toBeTruthy();
    const ask = screen.getByTestId("inbox-row-ask-1");
    expect(within(ask).queryByText("Answer")).toBeNull();
    fireEvent.click(within(ask).getByText("Run on terminal"));
    expect(within(ask).getByText("Answer from the console comes later; run it on the terminal for now.")).toBeTruthy();
  });

  it("keeps Confirm disabled until the read-back loads, and Cancel sends nothing", async () => {
    const prepared = deferred();
    const calls = renderInbox(inboxAnswer(), { "inbox.prepare": () => prepared.promise, "inbox.act": resolved });
    await tapGate();
    expect(confirmButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirmButton());
    prepared.resolve(ready());
    expect(await screen.findByText("Approve the merge of example/repo#12 at 0b7e2c1")).toBeTruthy();
    expect(screen.getByText("head 0b7e2c1, matches the live head, read 12 s ago")).toBeTruthy();
    expect(confirmButton().getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(screen.getByTestId("inbox-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("inbox-confirm")).toBeNull());
    expect(named(calls, "inbox.prepare").map((call) => call.args)).toEqual([{ itemId: "gate-1" }]);
    expect(named(calls, "inbox.act")).toEqual([]);
  });

  it("sends the prepared confirm on the second tap, shows the outcome inline and reads the inbox again", async () => {
    const calls = renderInbox(inboxAnswer(), { "inbox.prepare": () => Promise.resolve(ready()), "inbox.act": resolved });
    await tapGate();
    await screen.findByTestId("inbox-readback");
    fireEvent.click(confirmButton());
    expect((await screen.findByTestId("inbox-confirm-outcome")).textContent).toContain("Merge approved");
    expect(named(calls, "inbox.act").map((call) => call.args)).toEqual([{ itemId: "gate-1", confirm: CONFIRM }]);
    await waitFor(() => expect(named(calls, "inbox.list").length).toBeGreaterThan(1));
    expect(screen.queryByTestId("inbox-confirm-ok")).toBeNull();
  });

  it("shows a moved head as a warning naming the new head", async () => {
    const moved = () => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status: "moved", currentHead: "9".repeat(40) }, message: "PR moved to 9999999, read again" }));
    renderInbox(inboxAnswer(), { "inbox.prepare": () => Promise.resolve(ready()), "inbox.act": moved });
    await tapGate();
    await screen.findByTestId("inbox-readback");
    fireEvent.click(confirmButton());
    expect((await screen.findByTestId("inbox-confirm-outcome")).textContent).toContain("PR moved to 9999999, read again");
  });

  it("falls back to the terminal command when inbox actions are off", async () => {
    renderInbox(inboxAnswer(), { "inbox.prepare": () => Promise.resolve(errorEnvelope("inbox actions are off", 69)), "inbox.act": resolved });
    const sheet = await tapGate();
    expect((await within(sheet).findByTestId("inbox-confirm-error")).textContent).toContain("Not done: inbox actions are off");
    expect(within(sheet).getByText("titan-factory gate resolve run-gate-1/approve-merge --decision merge")).toBeTruthy();
    expect(screen.queryByTestId("inbox-confirm-ok")).toBeNull();
    expect(within(sheet).getByText("Close")).toBeTruthy();
  });

  it("keeps the read-back and offers the terminal when the owner write is refused", async () => {
    const refused = () => Promise.resolve(errorEnvelope("owner writes are off on this console", 77));
    renderInbox(inboxAnswer(), { "inbox.prepare": () => Promise.resolve(ready()), "inbox.act": refused });
    const sheet = await tapGate();
    await within(sheet).findByTestId("inbox-readback");
    fireEvent.click(confirmButton());
    expect((await within(sheet).findByTestId("inbox-confirm-error")).textContent).toContain("Not done: owner writes are off on this console");
    expect(within(sheet).getByTestId("inbox-readback")).toBeTruthy();
    expect(within(sheet).getByText("titan-factory gate resolve run-gate-1/approve-merge --decision merge")).toBeTruthy();
  });

  it("names why the console cannot take a tap the server answers with no action", async () => {
    const none = () => Promise.resolve(successEnvelope({ status: "no-action", itemId: "gate-1", action: { kind: "terminal", reason: "fixture" }, reason: "the gate is a device gate" }));
    renderInbox(inboxAnswer(), { "inbox.prepare": none, "inbox.act": resolved });
    const sheet = await tapGate();
    expect((await within(sheet).findByTestId("inbox-confirm-error")).textContent).toContain("The console cannot take this tap: the gate is a device gate");
  });

  it("reads back the hold a Release hold tap lifts", async () => {
    const held = ready({ itemId: "held-1", action: HELD.action, readBack: { repo: "example/repo", pr: 14, title: "add the widget cache", headSha: HEAD, hold: HELD.hold, effect: "Release the owner-asked hold on example/repo#14 at 0b7e2c1" } });
    const calls = renderInbox(inboxAnswer(), { "inbox.prepare": () => Promise.resolve(held), "inbox.act": resolved });
    fireEvent.click(within(await screen.findByTestId("inbox-row-held-1")).getByText("Release hold"));
    expect(await screen.findByText("Release the owner-asked hold on example/repo#14 at 0b7e2c1")).toBeTruthy();
    expect(screen.getByText("example/repo#14: add the widget cache")).toBeTruthy();
    expect(screen.getByText("Hold: owner-asked: wait for the demo")).toBeTruthy();
    expect(named(calls, "inbox.prepare").map((call) => call.args)).toEqual([{ itemId: "held-1" }]);
  });
});

describe("the inbox page, empty or gapped", () => {
  it("says nothing needs the owner when every source answered and nothing is open", async () => {
    renderInbox(inboxAnswer({ items: [], fyiCount: 0 }));
    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  it("shows a banner per dead source and never claims nothing needs the owner", async () => {
    renderInbox(inboxAnswer({ items: [], gaps: ["factory: connect ECONNREFUSED"] }));
    expect(await screen.findByText("A source is unreadable, so this list may be missing items: factory: connect ECONNREFUSED")).toBeTruthy();
    expect(screen.queryByText("Nothing needs you")).toBeNull();
  });

  it("says so when the inbox itself cannot be read", async () => {
    renderInbox(errorEnvelope("console daemon down", 69));
    expect(await screen.findByText("Could not load the inbox: console daemon down")).toBeTruthy();
  });
});
