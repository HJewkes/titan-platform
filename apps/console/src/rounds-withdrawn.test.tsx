// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type DataSource } from "@titan-design/rpc-client";
import { copiedRounds, type CopiedRounds } from "../server/round-fixtures.js";
import { listRounds } from "../server/rounds.js";
import { App } from "./App.js";

const SUPERSEDED = "kiln-schedule-r2";
const CLOSED = "lantern-cards-r1";
const ANSWERED_THEN_WITHDRAWN = "kiln-schedule-r1";
const REPLACEMENT = "orbit-retry-r1";
const LATE = "beacon-states-r1";

let rounds: CopiedRounds;

beforeEach(async () => {
  rounds = await copiedRounds();
  await rounds.withdraw(SUPERSEDED, `superseded-by:${REPLACEMENT}`);
  await rounds.withdraw(CLOSED, "closed");
  await rounds.withdraw(ANSWERED_THEN_WITHDRAWN, "answered-elsewhere");
});

afterEach(async () => {
  cleanup();
  await rounds.remove();
});

async function renderRounds(): Promise<void> {
  const calls = { [snapshotKey("rounds.list", {})]: successEnvelope(await listRounds(rounds.source)) };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  window.location.hash = "#/rounds";
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
  await screen.findByText("Open rounds");
}

/** A daemon stand-in that reads the rounds dir on every `rounds.list` call, so a later withdrawal shows on the next fetch. */
const liveRounds: DataSource = {
  call: async (name) => (name === "rounds.list" ? successEnvelope(await listRounds(rounds.source)) : errorEnvelope(`${name} is not served here`, 69)),
  subscribe: () => ({ close: () => undefined }),
};

async function renderLiveRounds(): Promise<void> {
  window.location.hash = "#/rounds";
  render(
    <RpcProvider source={liveRounds}>
      <App />
    </RpcProvider>,
  );
  await screen.findByText("Open rounds");
}

const rowIdsIn =(status: string): (string | null)[] =>
  within(screen.getByTestId(`rounds-${status}`)).queryAllByTestId(/^round-row-/).map((row) => row.getAttribute("data-testid"));

describe("withdrawn rounds on the rounds list", () => {
  it("keeps a withdrawn round out of Open and lists it under Withdrawn with its reason", async () => {
    await renderRounds();

    expect(rowIdsIn("open")).not.toContain(`round-row-${SUPERSEDED}`);
    expect(rowIdsIn("withdrawn")).toEqual(expect.arrayContaining([`round-row-${SUPERSEDED}`, `round-row-${CLOSED}`]));
    expect(within(screen.getByTestId(`round-row-${CLOSED}`)).getByText("Withdrawn: closed")).toBeTruthy();
  });

  it("links a superseded round to the round that replaced it", async () => {
    await renderRounds();

    const reason = within(screen.getByTestId(`round-row-${SUPERSEDED}`)).getByTestId(`round-withdrawn-${SUPERSEDED}`);
    expect(within(reason).getByText("Superseded by")).toBeTruthy();
    fireEvent.click(within(reason).getByRole("link"));

    await waitFor(() => expect(window.location.hash).toBe(`#/rounds/${REPLACEMENT}`));
  });

  it("keeps an answered round under Sent, never Open, when a withdrawal raced its answer", async () => {
    await renderRounds();

    expect(rowIdsIn("open")).not.toContain(`round-row-${ANSWERED_THEN_WITHDRAWN}`);
    expect(rowIdsIn("sent")).toContain(`round-row-${ANSWERED_THEN_WITHDRAWN}`);
    expect(screen.queryByTestId(`round-withdrawn-${ANSWERED_THEN_WITHDRAWN}`)).toBeNull();
  });

  it("moves a round withdrawn after the page loaded out of Open once the owner returns to the tab, with no reload", async () => {
    await renderLiveRounds();
    await waitFor(() => expect(rowIdsIn("open")).toContain(`round-row-${LATE}`));

    await rounds.withdraw(LATE, "closed");
    fireEvent.focus(window);

    await waitFor(() => expect(rowIdsIn("withdrawn")).toContain(`round-row-${LATE}`));
    expect(rowIdsIn("open")).not.toContain(`round-row-${LATE}`);
  });
});
