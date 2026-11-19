// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { EXIT, errorEnvelope, successEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, staticSource, type DataSource } from "@titan-design/rpc-client";
import { LOG_ANSWERS } from "../server/twin/log.js";
import { renderPage, unmountPages } from "./render-page.test-helpers.js";

const ROW = "deposit:dep-ceiling";
const OPTIONS = { options: [{ id: "keep", label: "Keep 30 s", recommended: true }, { id: "raise", label: "Raise to 60 s", recommended: false }], refusal: null };

function snapshot() {
  const calls = Object.fromEntries(LOG_ANSWERS.map(({ command, args, result }) => [snapshotKey(command, args), successEnvelope(result)]));
  return { format: SNAPSHOT_FORMAT, createdAt: "2031-03-06T00:00:00.000Z", calls };
}

/** The log with a live answer source on a desktop; returns each write's name and args. */
function renderLive(overrule: object = successEnvelope({ from: "Keep 30 s", to: "Raise to 60 s", seat: "seat-alpha", notice: "sent" })): unknown[][] {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  const inner = staticSource({ snapshot: snapshot() });
  const writes: unknown[][] = [];
  const answers: DataSource = {
    subscribe: inner.subscribe.bind(inner),
    call: (name, args, options) => {
      if (name === "log.overrule-options") return Promise.resolve(successEnvelope(OPTIONS));
      if (name !== "log.overrule") return inner.call(name, args, options);
      writes.push([name, args]);
      return Promise.resolve(overrule);
    },
  };
  renderPage(answers, "#/log", { answers });
  return writes;
}

afterEach(async () => {
  await unmountPages();
  vi.unstubAllGlobals();
});

describe("the log's overrule tap", () => {
  it("offers only the picks by-rec did not take, and sends the owner's", async () => {
    const writes = renderLive();

    fireEvent.click(await screen.findByTestId(`log-overrule-${ROW}`));
    const picks = await screen.findByTestId(`log-overrule-picks-${ROW}`);
    expect(within(picks).queryByText("Keep 30 s")).toBeNull();
    fireEvent.click(within(picks).getByTestId(`log-overrule-pick-${ROW}-raise`));

    expect((await screen.findByTestId(`log-overruled-${ROW}`)).textContent).toContain("Keep 30 s → Raise to 60 s; the asker was told to reverse");
    expect(writes).toEqual([["log.overrule", { source: "deposit", id: "dep-ceiling", optionId: "raise" }]]);
  });

  it("shows the server's refusal and records nothing", async () => {
    renderLive(errorEnvelope("owner-write command refused: owner writes are off", EXIT.NOPERM));

    fireEvent.click(await screen.findByTestId(`log-overrule-${ROW}`));
    fireEvent.click(await screen.findByTestId(`log-overrule-pick-${ROW}-raise`));

    expect(await screen.findByText("Not overruled: owner-write command refused: owner writes are off")).toBeTruthy();
  });

  it("shows both picks on an overruled row, and a snapshot's tap disabled", async () => {
    renderPage(snapshot(), "#/log");

    expect((await screen.findByTestId("log-overruled-picks-deposit:dep-digest")).textContent).toContain("auto-by-rec picked keep; you picked batch");
    expect(screen.queryByTestId("log-overrule-deposit:dep-digest")).toBeNull();
    expect(within(screen.getByTestId(`log-row-${ROW}`)).getByText("Overrule from the live console.")).toBeTruthy();
  });
});
