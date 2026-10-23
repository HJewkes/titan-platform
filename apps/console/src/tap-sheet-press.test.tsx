// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, type DataSource } from "@titan-design/rpc-client";
import { AnswerSourceProvider } from "./data/submit.js";
import { TapSheet } from "./pages/TapSheet.js";

// A loaded CI runner: React's scheduler slices, which run passive effects, land after RTL's setTimeout(0) drain.
// React's scheduler takes setImmediate at import, so this runs before the imports.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).setImmediate = (callback: () => void) => setTimeout(callback, 10);
});

afterEach(cleanup);

const CONFIRM = "c".repeat(64);

function renderSheet(): void {
  const page = new DOMParser().parseFromString(embedSnapshot("<html><head></head><body></body></html>", { format: SNAPSHOT_FORMAT, createdAt: new Date(0).toISOString(), calls: {} }), "text/html");
  const inner = pageDataSource({ doc: page });
  const answers: Record<string, JsonEnvelope<unknown>> = {
    "fixture.prepare": successEnvelope({ status: "ready", confirm: CONFIRM, readAt: new Date(0).toISOString(), effect: "Do the fixture thing" }),
    "fixture.act": successEnvelope({ actionId: CONFIRM, outcome: { status: "resolved" }, message: "Fixture done" }),
  };
  const source: DataSource = { subscribe: inner.subscribe.bind(inner), call: (name) => Promise.resolve(answers[name] ?? successEnvelope({})) };
  render(
    <RpcProvider source={inner}>
      <AnswerSourceProvider value={source}>
        <TapSheet<{ status: "ready"; confirm: string; readAt: string; effect: string }>
          commands={{ prepare: "fixture.prepare", act: "fixture.act", args: {}, invalidates: [] }}
          verb="Do it"
          reading="Reading"
          command={undefined}
          renderReadBack={(prepared) => <p data-testid="sheet-readback">{prepared.effect}</p>}
          testID="sheet"
          onClose={() => undefined}
        />
      </AnswerSourceProvider>
    </RpcProvider>,
  );
}

describe("a tap sheet on a slow runner", () => {
  it("takes a Confirm pressed the moment the read-back paints", async () => {
    renderSheet();
    await screen.findByTestId("sheet-readback");

    fireEvent.click(screen.getByTestId("sheet-ok"));

    expect((await screen.findByTestId("sheet-outcome")).textContent).toContain("Fixture done");
  });
});
