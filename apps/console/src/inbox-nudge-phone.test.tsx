// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, staticSource, type DataSource } from "@titan-design/rpc-client";
import { BELOW_MD } from "./pages/TasksPage.js";
import { renderPage } from "./render-page.test-helpers.js";

const NOW = Date.parse("2031-03-05T12:00:00.000Z");
const ROUND_SHA = "e".repeat(64);

const NUDGE = {
  roundId: "kiln-r1", unit: "kiln", round: 1, openedAt: new Date(NOW - 7 * 3_600_000).toISOString(), manifestSha256: ROUND_SHA, oneTap: true, nudgedAt: null, recommendationsHidden: false,
  recommendations: [{ questionId: "ramp", prompt: "Which ramp by default?", answer: "Staged" }],
  line: "kiln-r1 has waited 7 h: reply rec to answer all 1 with the recommendation (ramp: Staged)",
};

const INBOX = successEnvelope({ items: [], planningCount: 0, gaps: [], fyiCount: 0, readAt: new Date(NOW).toISOString(), derived: [], nudges: [NUDGE] });

function stubWidth(phone: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: phone && query === BELOW_MD, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

/** Renders the inbox with one live nudge and returns the names of the writes it sent. */
function renderNudge(): string[] {
  const inner = staticSource({ snapshot: { format: SNAPSHOT_FORMAT, createdAt: new Date(NOW).toISOString(), calls: { [snapshotKey("inbox.list", {})]: INBOX } } });
  const writes: string[] = [];
  const answers: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => {
      if (name !== "rounds.answer-rec") return inner.call(name, args, options);
      writes.push(name);
      return Promise.resolve(successEnvelope({ status: "submitted", path: "/synthetic/feedback.json", sha256: "f".repeat(64), headSha: null }));
    },
  };
  renderPage(answers, "#/inbox", { answers });
  return writes;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the inbox's one-tap round answer on a phone", () => {
  it("arms a confirm step on the first tap and sends nothing yet", async () => {
    stubWidth(true);
    const writes = renderNudge();

    fireEvent.click(await screen.findByTestId("inbox-nudge-rec-kiln-r1"));

    const step = screen.getByTestId("inbox-nudge-confirm-kiln-r1");
    expect(within(step).getByText("Answer all with recommendation for round 1? This submits the round.")).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it("sends the answer once Confirm is tapped", async () => {
    stubWidth(true);
    const writes = renderNudge();

    fireEvent.click(await screen.findByTestId("inbox-nudge-rec-kiln-r1"));
    fireEvent.click(screen.getByTestId("inbox-nudge-confirm-go-kiln-r1"));

    expect(await screen.findByText("Answered with every recommendation.")).toBeTruthy();
    expect(writes).toEqual(["rounds.answer-rec"]);
  });

  it("puts the tap back and sends nothing when Cancel is tapped", async () => {
    stubWidth(true);
    const writes = renderNudge();

    fireEvent.click(await screen.findByTestId("inbox-nudge-rec-kiln-r1"));
    fireEvent.click(screen.getByTestId("inbox-nudge-confirm-cancel-kiln-r1"));

    expect(screen.queryByTestId("inbox-nudge-confirm-kiln-r1")).toBeNull();
    expect(screen.getByTestId("inbox-nudge-rec-kiln-r1").className).toContain("max-md:min-h-11");
    expect(writes).toEqual([]);
  });
});

describe("the inbox's one-tap round answer on a desktop", () => {
  it("sends on the first tap with no confirm step", async () => {
    stubWidth(false);
    const writes = renderNudge();

    fireEvent.click(await screen.findByTestId("inbox-nudge-rec-kiln-r1"));

    expect(await screen.findByText("Answered with every recommendation.")).toBeTruthy();
    expect(screen.queryByTestId("inbox-nudge-confirm-kiln-r1")).toBeNull();
    expect(writes).toEqual(["rounds.answer-rec"]);
  });
});
