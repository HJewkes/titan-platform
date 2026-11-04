// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, staticSource, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS, stagedRound, twoPrRound, type StagedRound } from "../server/round-fixtures.js";
import { getRound } from "../server/rounds.js";
import { getButton } from "./pages/get-button.test-helpers.js";
import { BELOW_MD } from "./pages/phone.js";
import { renderPage, unmountPages } from "./render-page.test-helpers.js";

const SHIP = "ship-tile-r1";
const PRS = "tiles-and-panels-r1";
// Each test renders a whole round page and presses through it; a loaded CI run can pass vitest's 5 s default (TP-3866).
const RENDER_TIMEOUT_MS = 30_000;

class SilentObserver {
  observe(): void {}
  disconnect(): void {}
}

let staged: StagedRound;
beforeAll(async () => {
  staged = await stagedRound(SHIP, PRS, twoPrRound());
});
afterAll(() => staged.remove());
beforeEach(() => vi.stubGlobal("IntersectionObserver", SilentObserver));
afterEach(async () => {
  await unmountPages();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const onPhone = (): void =>
  void vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));

/** A synthetic round page whose rounds.submit answers "submitted"; returns the args of each submit it was sent. */
async function renderRound(id: string, source = FIXTURE_ROUNDS): Promise<unknown[]> {
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("rounds.get", { id })]: successEnvelope(await getRound(source, id)),
      [snapshotKey("rounds.frames", { id })]: successEnvelope({ frames: [] }),
    },
  };
  const inner = staticSource({ snapshot });
  const submits: unknown[] = [];
  const submitted = successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null });
  const answers: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => (name === "rounds.submit" ? (submits.push(args), Promise.resolve(submitted)) : inner.call(name, args, options)),
  };
  renderPage(answers, { view: "rounds", id }, { answers });
  await screen.findAllByLabelText(/^Note for Send back/);
  return submits;
}

describe("a Ship round on a phone", { timeout: RENDER_TIMEOUT_MS }, () => {
  it("asks to confirm Ship, naming the PR and head, and sends it only on Confirm", async () => {
    onPhone();
    const submits = await renderRound(SHIP);

    fireEvent.click(getButton("Ship"));

    expect(submits).toEqual([]);
    expect(screen.getByTestId("phone-confirm").textContent).toContain("Ship example/tiles#1 at 89abcde?");
    fireEvent.click(getButton("Confirm Ship"));
    await waitFor(() => expect(submits).toEqual([expect.objectContaining({ answers: [{ questionId: "ship-tiles", pick: "Ship" }] })]));
  });

  it("sends nothing when the confirm step is cancelled", async () => {
    onPhone();
    const submits = await renderRound(SHIP);

    fireEvent.click(getButton("Ship"));
    fireEvent.click(getButton("Cancel"));

    expect(screen.queryByTestId("phone-confirm")).toBeNull();
    expect(submits).toEqual([]);
  });

  it("asks to confirm Send back before it sends the note", async () => {
    onPhone();
    const submits = await renderRound(SHIP);

    fireEvent.change(screen.getByLabelText("Note for Send back"), { target: { value: "The stripe is low." } });
    fireEvent.click(getButton("Send back"));

    expect(submits).toEqual([]);
    expect(screen.getByTestId("phone-confirm").textContent).toContain("Send example/tiles#1 back to its implementer");
    fireEvent.click(getButton("Confirm Send back"));
    await waitFor(() => expect(submits).toEqual([expect.objectContaining({ answers: [expect.objectContaining({ questionId: "ship-tiles", comment: "The stripe is low." })] })]));
  });

  it("asks to confirm a two-PR round's one send, counting its ships and send-backs", async () => {
    onPhone();
    const submits = await renderRound(PRS, staged.source);

    fireEvent.click(getButton("Ship example/tiles#1"));
    fireEvent.change(screen.getByLabelText("Note for Send back on example/panels#2"), { target: { value: "Narrow it again." } });
    fireEvent.click(getButton("Send back example/panels#2"));
    fireEvent.click(getButton("Send answers"));

    expect(submits).toEqual([]);
    expect(screen.getByTestId("phone-confirm").textContent).toContain("Send your answers: 1 to ship, 1 to send back?");
    fireEvent.click(getButton("Confirm send"));
    await waitFor(() => expect(submits).toHaveLength(1));
  });
});

describe("a Ship round on a desktop", { timeout: RENDER_TIMEOUT_MS }, () => {
  it("sends Ship on the one press, with no confirm step", async () => {
    const submits = await renderRound(SHIP);

    fireEvent.click(getButton("Ship"));

    expect(screen.queryByTestId("phone-confirm")).toBeNull();
    await waitFor(() => expect(submits).toHaveLength(1));
  });
});
