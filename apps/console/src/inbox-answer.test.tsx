// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";
import { findTapSheet } from "./tap-sheet.test-helpers.js";

const NOW = "2031-03-05T12:00:00.000Z";
const CONFIRM = "d".repeat(64);

const ASK = {
  id: "ask-1",
  sources: [{ system: "agent-chat", ref: "msg-1" }],
  kind: "decide",
  door: "two-way",
  summary: "Which relay port?",
  context: "",
  keys: [],
  personal: false,
  lens: "blocking-agent",
  unblocks: [],
  openedAt: NOW,
  status: "open",
  section: "blocking",
  asker: "agent-1",
  options: [
    { id: "a", label: "Port 8080" },
    { id: "b", label: "Port 9090" },
  ],
  recommended: { optionId: "b" },
  action: { kind: "answer-chat", msgId: "msg-1" },
};

const READBACK = {
  msgId: "msg-1",
  title: "Which relay port?",
  asker: "agent-1",
  question: "The relay needs a listen port for the depth probe",
  options: [
    { id: "a", label: "Port 8080" },
    { id: "b", label: "Port 9090" },
  ],
  recommended: "b",
  effect: "Answer agent-1's question; the broker records it as yours",
};

const prepared = (): JsonEnvelope<unknown> => successEnvelope({ status: "ready", itemId: "ask-1", action: ASK.action, readBack: READBACK, readAt: NOW, confirm: CONFIRM, expiresAt: NOW });

interface Call {
  name: string;
  args: unknown;
}

function renderAsk(outcome: { status: string; reason?: string }, message: string, { live = true } = {}): Call[] {
  const list = successEnvelope({ items: [ASK], gaps: [], fyiCount: 0, readAt: NOW, derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: NOW, calls: { [snapshotKey("inbox.list", {})]: list } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const taps: Record<string, () => Promise<JsonEnvelope<unknown>>> = {
    "inbox.prepare": () => Promise.resolve(prepared()),
    "inbox.act": () => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome, message })),
  };
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), taps[name] ? taps[name]() : inner.call(name, args, options)),
  };
  renderPage(source, "#/inbox", live ? { answers: source } : {});
  return calls;
}

async function openSheet(): Promise<HTMLElement> {
  fireEvent.click(within(await screen.findByTestId("inbox-row-ask-1")).getByText("Answer"));
  return findTapSheet("inbox-confirm");
}

const actArgs = (calls: readonly Call[]): unknown[] => calls.filter((call) => call.name === "inbox.act").map((call) => call.args);
const field = (sheet: HTMLElement): HTMLInputElement => within(sheet).getByLabelText<HTMLInputElement>("Your answer");

afterEach(() => {
  cleanup();
});

describe("the inbox page, answering an agent's chat question from the console", () => {
  it("reads back the question, asker and options as chips, marking the recommended one", async () => {
    renderAsk({ status: "answered" }, "Answer sent");
    const sheet = await openSheet();
    expect(within(sheet).getByText("The relay needs a listen port for the depth probe")).toBeTruthy();
    expect(within(sheet).getByText("Asked by agent-1")).toBeTruthy();
    expect(within(sheet).getByTestId("inbox-confirm-chip-a").textContent).toBe("Port 8080");
    expect(within(sheet).getByTestId("inbox-confirm-chip-b").textContent).toBe("Port 9090 (recommended)");
  });

  it("fills the text field with a chip's label when the chip is tapped", async () => {
    renderAsk({ status: "answered" }, "Answer sent");
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByTestId("inbox-confirm-chip-a"));
    expect(field(sheet).value).toBe("Port 8080");
  });

  it("keeps Confirm disabled while the text is empty", async () => {
    renderAsk({ status: "answered" }, "Answer sent");
    const sheet = await openSheet();
    expect(within(sheet).getByTestId("inbox-confirm-ok").getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(field(sheet), { target: { value: "   " } });
    expect(within(sheet).getByTestId("inbox-confirm-ok").getAttribute("aria-disabled")).toBe("true");
  });

  it("sends the typed text once on Confirm and shows the Answer sent outcome", async () => {
    const calls = renderAsk({ status: "answered" }, "Answer sent");
    const sheet = await openSheet();
    fireEvent.change(field(sheet), { target: { value: "Use 7070" } });
    await act(async () => void fireEvent.click(within(sheet).getByTestId("inbox-confirm-ok")));
    expect(actArgs(calls)).toEqual([{ itemId: "ask-1", text: "Use 7070", confirm: CONFIRM }]);
    expect(within(sheet).getByTestId("inbox-confirm-outcome").textContent).toBe("Answer sent");
  });

  it("shows a closed outcome's reason", async () => {
    renderAsk({ status: "closed", reason: "answered elsewhere" }, "Not sent; the question is closed, likely answered elsewhere: answered elsewhere");
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByTestId("inbox-confirm-chip-a"));
    await act(async () => void fireEvent.click(within(sheet).getByTestId("inbox-confirm-ok")));
    expect(within(sheet).getByTestId("inbox-confirm-outcome").textContent).toContain("answered elsewhere");
  });

  it("sends no act when Cancel is tapped", async () => {
    const calls = renderAsk({ status: "answered" }, "Answer sent");
    const sheet = await openSheet();
    fireEvent.change(field(sheet), { target: { value: "Use 7070" } });
    fireEvent.click(within(sheet).getByTestId("inbox-confirm-cancel"));
    expect(actArgs(calls)).toEqual([]);
  });

  it("keeps Run on terminal on a snapshot page", async () => {
    renderAsk({ status: "answered" }, "Answer sent", { live: false });
    const row = await screen.findByTestId("inbox-row-ask-1");
    expect(within(row).getByText("Run on terminal")).toBeTruthy();
    expect(within(row).queryByText("Answer")).toBeNull();
  });
});
