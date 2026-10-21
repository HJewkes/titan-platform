// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RpcProvider } from "@titan-design/react-app";
import { successEnvelope } from "@titan-design/registry";
import { snapshotKey, staticSource, type Snapshot } from "@titan-design/rpc-client";
import type { ArRunView, ArValidator } from "../server/autoresearch-view.js";
import { AR_RUN_FIXTURE } from "../server/twin/autoresearch.js";
import { TWIN_NOW } from "../server/twin/clock.js";
import { twinSnapshot } from "../server/twin/snapshot.js";
import { App } from "./App.js";

let twin: Snapshot;

beforeAll(async () => {
  twin = await twinSnapshot();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RUN_ROUTE = "#/autoresearch/ar-7c1e";

/** Every run-page section but the validator panel. */
const OTHER_SECTIONS = ["header", "backlog", "lanes", "decisions", "progress", "registries"] as const;

/** Numbers no other section could show by chance, so a leak of any of them would change that section. */
const VALIDATOR: ArValidator = {
  maxLooks: 2,
  looks: [{ look: 1, at: new Date(TWIN_NOW - 60_000).toISOString(), sha: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0", aggregate: { metrics: { score: 987.6 }, gates: { all_gate: 41 } }, provenance: "held-out set v9" }],
};

const withRun = (run: ArRunView): Snapshot => ({ ...twin, calls: { ...twin.calls, [snapshotKey("autoresearch.run", { runId: run.runId })]: successEnvelope(run) } });

function renderRun(snapshot: Snapshot = twin): void {
  window.location.hash = RUN_ROUTE;
  render(
    <RpcProvider source={staticSource({ snapshot })}>
      <App />
    </RpcProvider>,
  );
}

/** React's generated ids differ from one mount to the next, so they are blanked before two mounts are compared. */
const withoutGeneratedIds = (html: string): string => html.replace(/«[^»]*»|:r[0-9a-z]+:/g, "«id»");

async function otherSectionsHtml(snapshot: Snapshot): Promise<Record<string, string>> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TWIN_NOW);
  renderRun(snapshot);
  await screen.findByTestId("autoresearch-validator");
  const html = Object.fromEntries(OTHER_SECTIONS.map((name) => [name, withoutGeneratedIds(screen.getByTestId(`autoresearch-${name}`).innerHTML)]));
  cleanup();
  return html;
}

describe("the autoresearch registries and validator panel", () => {
  it("keeps a validator look out of every other section", async () => {
    const without = await otherSectionsHtml(twin);

    const withLook = await otherSectionsHtml(withRun({ ...AR_RUN_FIXTURE, validator: VALIDATOR }));

    expect(withLook).toEqual(without);
  });

  it("shows the validator's look, aggregate only, once its panel opens", async () => {
    renderRun(withRun({ ...AR_RUN_FIXTURE, validator: VALIDATOR }));
    const panel = await screen.findByTestId("autoresearch-validator");

    expect(within(panel).getByText("Report only. Never used for selection. Do not tune on these numbers.")).toBeTruthy();
    fireEvent.click(within(panel).getByText("Validator · looks 1 / 2"));

    const look = await within(panel).findByTestId("autoresearch-validator-look-1");
    expect(look.textContent).toContain("b0b0b0b");
    expect(look.textContent).toContain("987.6");
    expect(look.textContent).toContain("all_gate 41");
    expect(look.textContent).toContain("held-out set v9");
  });

  it("says the validator is not reporting while the run carries no validator field", async () => {
    renderRun();
    const panel = await screen.findByTestId("autoresearch-validator");

    expect(within(panel).getByText("Validator · validator not reporting yet")).toBeTruthy();
  });

  it("tabs between the dead ends, the bugs and the repeat rate", async () => {
    renderRun();
    const registries = await screen.findByTestId("autoresearch-registries");

    expect(within(registries).getByTestId("autoresearch-dead-ends").textContent).toContain("A looser slack lets the hidden cases through");
    fireEvent.click(within(registries).getByText("Bugs 2"));
    expect(within(registries).getByTestId("autoresearch-bugs").textContent).toContain("rejected:post:unit");
    fireEvent.click(within(registries).getByText("Bug-repeat rate"));

    expect(within(registries).getByTestId("autoresearch-repeat-rate").textContent).toContain("r1 no L0 failure · r2 0/1 (0%) · r3 no L0 failure");
  });
});
