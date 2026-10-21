// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource, type Snapshot } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS as source } from "../server/round-fixtures.js";
import { getRound } from "../server/rounds.js";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";
import { draftKey } from "./pages/round-draft.js";
import { checkAndSend, toSection } from "./pages/round-pager.test-helpers.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const ROUND = "kiln-schedule-r2";
const RAMP = "Which ramp should the calculator propose by default?";
const OLDER_SHA = "a".repeat(64);

interface Served {
  /** Serves the round as though round.json now hashes to this, as after a rebuild of the round. */
  manifestSha256?: string;
  status?: "sent";
}

/** Renders the synthetic question round; `rounds.submit` succeeds, and after it `rounds.get` answers as sent. */
async function renderRound({ manifestSha256, status }: Served = {}): Promise<void> {
  const round = await getRound(source, ROUND);
  if (!round.valid) throw new Error(round.reason);
  const served = { ...round, ...(manifestSha256 && { manifestSha256 }), ...(status && { status, notes: { general: "", comments: {} } }) };
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: { [snapshotKey("rounds.get", { id: ROUND })]: successEnvelope(served), [snapshotKey("rounds.list", {})]: successEnvelope({ rounds: [], truncated: false, dir: "/state/rounds" }) },
  };
  const inner = pageDataSource({ doc: new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", snapshot), "text/html") });
  let sent = false;
  const live: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => {
      if (name === "rounds.submit") {
        sent = true;
        return Promise.resolve(successEnvelope({ status: "submitted", path: "feedback.json", sha256: "0".repeat(64), headSha: null }));
      }
      if (name === "rounds.get" && sent) return Promise.resolve(successEnvelope({ ...served, status: "sent", notes: { general: "", comments: {} } }));
      return inner.call(name, args, options);
    },
  };
  window.location.hash = `#/rounds/${ROUND}`;
  render(
    <RpcProvider source={live}>
      <AnswerSourceProvider value={live}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
  await screen.findByTestId("round-question-ramp-default");
}

const control = (questionId: string, label: string): HTMLElement => {
  const found = within(screen.getByTestId(`round-question-${questionId}`)).getByText(label).closest<HTMLElement>("[aria-checked]");
  if (!found) throw new Error(`no control labelled ${label}`);
  return found;
};
const pick = (questionId: string, label: string): void => void fireEvent.click(control(questionId, label));
const picked = (questionId: string, label: string): string | null => control(questionId, label).getAttribute("aria-checked");
const commentBox = (): HTMLTextAreaElement | HTMLInputElement => screen.getByLabelText<HTMLTextAreaElement>(`Comment on ${RAMP}`);
const stored = (): string | null => localStorage.getItem(draftKey(ROUND));

/** Answers the first section and leaves round feedback, then waits for the debounced write to land. */
async function typeDraft(): Promise<void> {
  pick("ramp-default", "2 Single slope");
  fireEvent.change(commentBox(), { target: { value: "Single, for the test tiles." } });
  await toSection("report");
  fireEvent.change(screen.getByLabelText("Feedback on this round"), { target: { value: "Keep the cone chart." } });
  await waitFor(() => expect(stored()).toContain("Keep the cone chart."));
}

describe("an unsent round's draft", () => {
  it("restores picks, comments and round feedback after the page is remounted", async () => {
    await renderRound();
    await typeDraft();
    cleanup();

    await renderRound();

    expect(picked("ramp-default", "2 Single slope")).toBe("true");
    expect(commentBox().value).toBe("Single, for the test tiles.");
    await toSection("report");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Feedback on this round").value).toBe("Keep the cone chart.");
    expect(screen.queryByText("Draft from an older version discarded")).toBeNull();
  });

  it("is discarded, with a note, when the round's manifest sha has changed", async () => {
    await renderRound({ manifestSha256: OLDER_SHA });
    await typeDraft();
    cleanup();

    await renderRound();

    expect(screen.getByText("Draft from an older version discarded")).toBeTruthy();
    expect(picked("ramp-default", "2 Single slope")).toBe("false");
    expect(commentBox().value).toBe("");
    expect(stored()).toBeNull();
  });

  it("is cleared by a successful send, and the sent round restores none", async () => {
    await renderRound();
    await typeDraft();

    checkAndSend();
    await screen.findByText("Answers sent");

    expect(stored()).toBeNull();
    cleanup();
    expect(stored()).toBeNull();
  });

  it("is never restored into a round already sent, and is dropped", async () => {
    await renderRound();
    await typeDraft();
    cleanup();

    await renderRound({ status: "sent" });

    expect(screen.queryByLabelText(`Comment on ${RAMP}`)).toBeNull();
    expect(screen.queryByText("Single, for the test tiles.")).toBeNull();
    await waitFor(() => expect(stored()).toBeNull());
  });

  it.each([
    ["corrupt JSON", "{not json"],
    ["a draft failing the schema", JSON.stringify({ manifestSha256: "x", draft: { answers: { "ramp-default": { pick: 7 } } } })],
  ])("ignores %s in storage and shows the round unanswered", async (_, raw) => {
    localStorage.setItem(draftKey(ROUND), raw);

    await renderRound();

    expect(picked("ramp-default", "2 Single slope")).toBe("false");
    expect(commentBox().value).toBe("");
    expect(screen.queryByText("Draft from an older version discarded")).toBeNull();
  });
});
