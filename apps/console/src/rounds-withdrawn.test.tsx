// @vitest-environment jsdom
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey } from "@titan-design/rpc-client";
import { FIXTURE_ROUNDS } from "../server/round-fixtures.js";
import { listRounds } from "../server/rounds.js";
import { App } from "./App.js";

const SUPERSEDED = "kiln-schedule-r2";
const CLOSED = "lantern-cards-r1";
const ANSWERED_THEN_WITHDRAWN = "kiln-schedule-r1";
const REPLACEMENT = "orbit-retry-r1";

let root: string;
let dir: string;

async function withdraw(id: string, reason: string): Promise<void> {
  const body = { schema: "titan-console/withdrawn@1", reason, at: "2031-03-04T12:00:00.000Z" };
  await writeFile(path.join(dir, id, "withdrawn.json"), JSON.stringify(body));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-rounds-withdrawn-"));
  dir = path.join(root, "rounds");
  await cp(FIXTURE_ROUNDS.dir, dir, { recursive: true });
  await withdraw(SUPERSEDED, `superseded-by:${REPLACEMENT}`);
  await withdraw(CLOSED, "closed");
  await withdraw(ANSWERED_THEN_WITHDRAWN, "answered-elsewhere");
});

afterEach(async () => {
  cleanup();
  await rm(root, { recursive: true, force: true });
});

async function renderRounds(): Promise<void> {
  const calls = { [snapshotKey("rounds.list", {})]: successEnvelope(await listRounds({ dir })) };
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: "2031-03-05T00:00:00.000Z", calls }), "text/html");
  window.location.hash = "#/rounds";
  render(
    <RpcProvider source={pageDataSource({ doc: page })}>
      <App />
    </RpcProvider>,
  );
  await screen.findByText("Open rounds");
}

const rowIdsIn = (status: string): (string | null)[] =>
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
});
