// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";

const NOW = "2031-03-05T12:00:00.000Z";
const CONFIRM = "c".repeat(64);

const approveItem = (id: string, summary: string): Record<string, unknown> => ({
  id,
  sources: [{ system: "agent-chat", ref: `msg-${id}` }],
  kind: "approve",
  door: "one-way",
  summary,
  context: "",
  keys: [],
  personal: false,
  lens: "blocking-agent",
  unblocks: [],
  openedAt: NOW,
  status: "open",
  section: "blocking",
  action: { kind: "approve-chat", msgId: `msg-${id}` },
});

const PROMPT = approveItem("perm-1", "agent-1 asks: Bash: example command");
const ENDORSE = approveItem("end-1", "agent-1 asks you to endorse a message to agent-2");

const PERMISSION_READBACK = {
  msgId: "msg-perm-1",
  kind: "permission",
  tool: "Bash",
  inputPreview: "example command --flag\n  second line",
  description: "Run the example command",
  asker: "agent-1",
  choices: ["allow", "deny"],
  effect: "Answer agent-1's permission prompt for Bash; the broker records the verdict as yours, from the console",
};

const ENDORSED_TEXT = "hello agent-2 \n  indented 𝄞 \n";
const ENDORSE_READBACK = { msgId: "msg-end-1", kind: "endorse", text: ENDORSED_TEXT, to: "agent-2", asker: "agent-1", effect: "Deliver this exact text to agent-2 with your authority, as agent-1 asked" };

const ready = (item: Record<string, unknown>, readBack: Record<string, unknown>): JsonEnvelope<unknown> =>
  successEnvelope({ status: "ready", itemId: item["id"], action: item["action"], readBack, readAt: NOW, confirm: CONFIRM, expiresAt: NOW });

const answered = (): Promise<JsonEnvelope<unknown>> => Promise.resolve(successEnvelope({ actionId: CONFIRM, outcome: { status: "answered" }, message: "Allowed" }));

interface Call {
  name: string;
  args: unknown;
}

/** A live inbox page over one item, whose prepare answers with the given read-back. */
function renderApprove(item: Record<string, unknown>, readBack: Record<string, unknown>, { inApp = false } = {}): Call[] {
  const list = successEnvelope({ items: [item], gaps: [], fyiCount: 0, readAt: NOW, derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: NOW, calls: { [snapshotKey("inbox.list", {})]: list } };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  const taps: Record<string, () => Promise<JsonEnvelope<unknown>>> = { "inbox.prepare": () => Promise.resolve(ready(item, readBack)), "inbox.act": answered };
  const calls: Call[] = [];
  const source: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (calls.push({ name, args }), taps[name] ? taps[name]() : inner.call(name, args, options)),
  };
  renderPage(source, "#/inbox", { answers: source, inApp });
  return calls;
}

async function openSheet(id: string): Promise<HTMLElement> {
  fireEvent.click(within(await screen.findByTestId(`inbox-row-${id}`)).getByText("Approve"));
  return screen.findByTestId("inbox-confirm");
}

const actArgs = (calls: readonly Call[]): unknown[] => calls.filter((call) => call.name === "inbox.act").map((call) => call.args);

afterEach(() => {
  cleanup();
});

describe("the inbox page, answering an agent's prompt from the console", () => {
  it("offers an approve-chat item as a console tap, not a terminal command", async () => {
    renderApprove(PROMPT, PERMISSION_READBACK);
    const row = await screen.findByTestId("inbox-row-perm-1");
    expect(within(row).getByTestId("inbox-act-perm-1")).toBeTruthy();
    expect(within(row).queryByText("Run on terminal")).toBeNull();
  });

  it("reads back a permission prompt's tool, input and description, offering Allow and Deny in place of Confirm", async () => {
    renderApprove(PROMPT, PERMISSION_READBACK);
    const sheet = await openSheet("perm-1");
    expect((await within(sheet).findByTestId("inbox-readback-tool")).textContent).toBe("Tool: Bash");
    expect(within(sheet).getByTestId("inbox-readback-input").textContent).toBe("example command --flag\n  second line");
    expect(within(sheet).getByTestId("inbox-readback-description").textContent).toBe("agent-1 says: Run the example command");
    expect(within(sheet).getByTestId("inbox-confirm-allow")).toBeTruthy();
    expect(within(sheet).getByTestId("inbox-confirm-deny")).toBeTruthy();
    expect(within(sheet).queryByTestId("inbox-confirm-ok")).toBeNull();
  });

  it.each(["allow", "deny"])("sends a permission prompt's %s as the act's verdict, with no text", async (verdict) => {
    const calls = renderApprove(PROMPT, PERMISSION_READBACK);
    const sheet = await openSheet("perm-1");
    const button = await within(sheet).findByTestId(`inbox-confirm-${verdict}`);
    await act(async () => void fireEvent.click(button));
    expect(actArgs(calls)).toEqual([{ itemId: "perm-1", verdict, confirm: CONFIRM }]);
  });

  it("renders an endorsement's exact stored text with its whitespace intact, never the item's summary", async () => {
    renderApprove(ENDORSE, ENDORSE_READBACK);
    const sheet = await openSheet("end-1");
    const block = await within(sheet).findByTestId("inbox-readback-text");
    expect(block.tagName).toBe("PRE");
    expect(block.textContent).toBe(ENDORSED_TEXT);
    expect(block.className).toContain("whitespace-pre-wrap");
    expect(within(sheet).getByTestId("inbox-readback-recipient").textContent).toBe("To agent-2");
    expect(within(sheet).getByText("Starts or ends with whitespace, delivered as is")).toBeTruthy();
  });

  it("sends Endorse as the act's verdict with no text, offering no Allow or Deny", async () => {
    const calls = renderApprove(ENDORSE, ENDORSE_READBACK);
    const sheet = await openSheet("end-1");
    const button = await within(sheet).findByTestId("inbox-confirm-endorse");
    expect(within(sheet).queryByTestId("inbox-confirm-allow")).toBeNull();
    await act(async () => void fireEvent.click(button));
    expect(actArgs(calls)).toEqual([{ itemId: "end-1", verdict: "endorse", confirm: CONFIRM }]);
  });

  // The broker token lives only in the console server's verdict client, so the page holds none to render as long as it
  // reaches the broker through the inbox commands alone.
  it("reaches the broker only through inbox.prepare and inbox.act, so the page never holds the token", async () => {
    const calls = renderApprove(ENDORSE, ENDORSE_READBACK, { inApp: true });
    const sheet = await openSheet("end-1");
    await act(async () => void fireEvent.click(await within(sheet).findByTestId("inbox-confirm-endorse")));
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set(["inbox.list", "console.build", "inbox.prepare", "inbox.act"]));
    expect(document.body.textContent).not.toMatch(/token/i);
  });
});
