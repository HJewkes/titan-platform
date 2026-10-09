// @vitest-environment jsdom
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import { getRound, listRounds } from "../server/rounds.js";
import { App } from "./App.js";

afterEach(cleanup);

const source = { dir: fileURLToPath(new URL("../fixtures/rounds", import.meta.url)) };
const ROUND_IDS = ["kiln-schedule-r2", "kiln-schedule-r1", "orbit-retry-r1", "lantern-cards-r1", "legacy-r1"];

/** The answers the console daemon gives over the synthetic rounds in `fixtures/rounds`. */
async function recorded(): Promise<Snapshot> {
  const rounds = await Promise.all(ROUND_IDS.map(async (id) => [snapshotKey("rounds.get", { id }), successEnvelope(await getRound(source, id))] as const));
  return {
    format: SNAPSHOT_FORMAT,
    createdAt: "2031-03-05T00:00:00.000Z",
    calls: {
      [snapshotKey("rounds.list", {})]: successEnvelope(await listRounds(source)),
      ...Object.fromEntries(rounds),
      [snapshotKey("rounds.get", { id: "nowhere" })]: errorEnvelope('No round named "nowhere"', 66),
    },
  };
}

async function renderConsole(hash: string): Promise<void> {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", await recorded()), "text/html");
  window.location.hash = hash;
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
}

const question = (id: string): HTMLElement => screen.getByTestId(`round-question-${id}`);

/** The radio or checkbox whose label reads `label`, keys digit included. */
function choice(questionId: string, label: string): HTMLElement {
  const control = within(question(questionId)).getByText(label).closest<HTMLElement>('[role="radio"], [role="checkbox"]');
  if (!control) throw new Error(`no control labelled ${label}`);
  return control;
}

const isChecked = (control: HTMLElement): boolean => control.getAttribute("aria-checked") === "true";

describe("the rounds list", () => {
  it("lists open rounds first and the sent round after them", async () => {
    await renderConsole("#/rounds");
    await screen.findByText("Open rounds");
    const rows = screen.getAllByTestId(/^round-row-/).map((row) => row.getAttribute("data-testid"));
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toBe("round-row-kiln-schedule-r1");
    expect(screen.getByText("Sent rounds")).toBeTruthy();
  });

  it("lists an invalid round with the schema's reason", async () => {
    await renderConsole("#/rounds");
    const legacy = await screen.findByTestId("round-row-legacy-r1");
    expect(within(legacy).getByText("invalid")).toBeTruthy();
    expect(within(legacy).getByText(/titan-review\/round@1 predates the review contract/)).toBeTruthy();
    expect(within(screen.getByTestId("round-row-unreadable-r1")).getByText("round.json is not JSON")).toBeTruthy();
  });

  it("opens a round from its row", async () => {
    await renderConsole("#/rounds");
    fireEvent.click(within(await screen.findByTestId("round-row-kiln-schedule-r2")).getByRole("link"));
    await waitFor(() => expect(window.location.hash).toBe("#/rounds/kiln-schedule-r2"));
    expect(await screen.findByText("Which ramp should the calculator propose by default?")).toBeTruthy();
  });
});

describe("a question round", () => {
  it("renders each question with its options and no recommendation while unsent", async () => {
    await renderConsole("#/rounds/kiln-schedule-r2");
    await screen.findByTestId("round-question-ramp-default");
    for (const id of ["ramp-default", "hold-clarity", "report-columns", "report-notes"]) expect(question(id)).toBeTruthy();
    expect(choice("ramp-default", "3 Ask each time")).toBeTruthy();
    expect(choice("hold-clarity", "5 5")).toBeTruthy();
    expect(choice("report-columns", "4 Hold minutes")).toBeTruthy();
    expect(screen.queryByText(/^Recommended:/)).toBeNull();
    expect(screen.getByText("Recommendations show once the round is answered.")).toBeTruthy();
  });

  it("chooses an option of the first question with keys 1-9", async () => {
    await renderConsole("#/rounds/kiln-schedule-r2");
    await screen.findByTestId("round-question-ramp-default");

    fireEvent.keyDown(window, { key: "2" });

    expect(isChecked(choice("ramp-default", "2 Single slope"))).toBe(true);
    expect(isChecked(choice("ramp-default", "1 Staged climb"))).toBe(false);
  });

  it("moves the keys to the question last answered by pointer, and toggles a pick-many", async () => {
    await renderConsole("#/rounds/kiln-schedule-r2");
    await screen.findByTestId("round-question-report-columns");

    fireEvent.click(choice("report-columns", "1 Segment"));
    fireEvent.keyDown(window, { key: "3" });
    fireEvent.keyDown(window, { key: "1" });

    expect(isChecked(choice("report-columns", "1 Segment"))).toBe(false);
    expect(isChecked(choice("report-columns", "3 Rate per hour"))).toBe(true);
    expect(isChecked(choice("ramp-default", "1 Staged climb"))).toBe(false);
  });

  it("ignores a digit pressed with a modifier", async () => {
    await renderConsole("#/rounds/kiln-schedule-r2");
    await screen.findByTestId("round-question-ramp-default");

    fireEvent.keyDown(window, { key: "1", metaKey: true });

    expect(isChecked(choice("ramp-default", "1 Staged climb"))).toBe(false);
  });

  it("shows the recommendation in a round that shows them, with the PR a ship question binds", async () => {
    await renderConsole("#/rounds/orbit-retry-r1");
    expect(await screen.findByText("Recommended: Ship (90%, fixture-agent)")).toBeTruthy();
    expect(screen.getByText("Ships example/orbit-relay#12 at 0123456")).toBeTruthy();
  });
});

describe("other rounds", () => {
  it("sends a design round to the harness instead of rendering its questions", async () => {
    await renderConsole("#/rounds/lantern-cards-r1");
    expect(await screen.findByText("design round: open in the harness")).toBeTruthy();
    expect(screen.queryByTestId("round-question-density-pick")).toBeNull();
  });

  it("says why an invalid round cannot be shown", async () => {
    await renderConsole("#/rounds/legacy-r1");
    expect(await screen.findByText(/^This round does not pass the round schema: schema: titan-review\/round@1 predates/)).toBeTruthy();
  });

  it("says so when a round cannot be loaded", async () => {
    await renderConsole("#/rounds/nowhere");
    expect(await screen.findByText('Could not load nowhere: No round named "nowhere"')).toBeTruthy();
  });
});
