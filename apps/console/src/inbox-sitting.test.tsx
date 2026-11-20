// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { renderPage } from "./render-page.test-helpers.js";

const NOW = "2031-03-05T12:00:00.000Z";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ID = "deposit:0123456789abcdef0123456789abcdef";
const MERGE = { kind: "merge-at-head", repo: "acme/widgets", pr: 7, headSha: HEAD };

const SITTING = {
  id: ID,
  sources: [{ system: "deposit", ref: "seat-a/sit-1" }],
  kind: "do",
  door: "two-way",
  summary: "Terminal sitting: reinstall and merge",
  context: "Run these in order.",
  keys: [],
  personal: false,
  lens: "blocking-agent",
  unblocks: [],
  asker: "seat-a",
  openedAt: NOW,
  status: "open",
  section: "blocking",
  steps: [
    { title: "Reinstall the tool", command: "example-cli install --global", verify: "example-cli --version prints 1.2.3", outcome: "done" },
    { title: "Merge the release PR", command: "example-cli merge 7", op: MERGE },
    { title: "Restart the daemon", command: "example-daemon restart" },
  ],
  action: { kind: "owner-op", op: MERGE },
};

const writeText = vi.fn<(text: string) => Promise<void>>();

function renderSitting(): void {
  const list = successEnvelope({ items: [SITTING], gaps: [], fyiCount: 0, readAt: NOW, derived: [] });
  const snapshot: Snapshot = { format: SNAPSHOT_FORMAT, createdAt: NOW, calls: { [snapshotKey("inbox.list", {})]: list } };
  const source = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  renderPage(source, "#/inbox", { answers: source, inApp: false });
}

const step = (number: number): HTMLElement => screen.getByTestId(`inbox-sitting-${ID}-step-${number}`);

beforeEach(() => {
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  writeText.mockReset();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("the inbox page, showing a sitting", () => {
  it("lists the steps in order, each with its status", async () => {
    renderSitting();
    const sitting = await screen.findByTestId(`inbox-sitting-${ID}`);

    expect(within(sitting).getByText("Sitting: 1 of 3 steps done or skipped")).toBeTruthy();
    expect([1, 2, 3].map((number) => within(step(number)).getByText(/^\d\. /).textContent)).toEqual(["1. Reinstall the tool", "2. Merge the release PR", "3. Restart the daemon"]);
    expect([1, 2, 3].map((number) => ["Done", "Next", "To do"].find((status) => within(step(number)).queryByText(status) !== null))).toEqual(["Done", "Next", "To do"]);
    expect(within(step(1)).getByText("Check: example-cli --version prints 1.2.3")).toBeTruthy();
  });

  it("copies each step's own command from its own button", async () => {
    renderSitting();
    await screen.findByTestId(`inbox-sitting-${ID}`);

    fireEvent.click(within(step(3)).getByText("Copy command"));
    fireEvent.click(within(step(1)).getByText("Copy command"));

    expect(writeText.mock.calls.map(([text]) => text)).toEqual(["example-daemon restart", "example-cli install --global"]);
  });

  it("marks the step that carries an op and offers its tap on the row", async () => {
    renderSitting();
    const row = await screen.findByTestId(`inbox-row-${ID}`);

    expect(within(step(2)).getByText("Console tap: Merge at head")).toBeTruthy();
    expect(within(row).getByTestId(`inbox-act-${ID}`).textContent).toBe("Merge at head");
    expect(within(row).getByText("sitting")).toBeTruthy();
  });
});
