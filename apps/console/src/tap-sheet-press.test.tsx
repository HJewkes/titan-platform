// @vitest-environment jsdom
import { createRequire } from "node:module";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RpcProvider, embedSnapshot, pageDataSource } from "@titan-design/react-app";
import { successEnvelope, type JsonEnvelope } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, type DataSource } from "@titan-design/rpc-client";
import { AnswerSourceProvider } from "./data/submit.js";
import { TapSheet } from "./pages/TapSheet.js";

// A loaded CI runner: React's scheduler slices, which run passive effects, land after RTL's setTimeout(0) drain.
// React's scheduler takes setImmediate at import, so this runs before the imports.
// The console project shares one worker across files, so the real one goes back once this file is done.
const realSetImmediate = vi.hoisted(() => {
  const real = globalThis.setImmediate;
  (globalThis as Record<string, unknown>).setImmediate = (callback: () => void) => setTimeout(callback, 10);
  return real;
});
afterAll(() => void (globalThis.setImmediate = realSetImmediate));

interface Scheduler {
  unstable_IdlePriority: number;
  unstable_scheduleCallback(priority: number, callback: () => void): unknown;
}
// react-dom's own instance: findBy* waits with act off, so a commit there queues its passive-effect flush on this
// scheduler, which cleanup does not cancel. Left queued, it reads `window` after this file's jsdom is gone (TP-4539).
function reactDomScheduler(): Scheduler {
  const loaded: unknown = createRequire(createRequire(import.meta.url).resolve("react-dom"))("scheduler");
  const isScheduler = (value: unknown): value is Scheduler => typeof value === "object" && value !== null && "unstable_scheduleCallback" in value;
  if (!isScheduler(loaded)) throw new Error("react-dom's scheduler has no unstable_scheduleCallback");
  return loaded;
}
const scheduler = reactDomScheduler();
const drainScheduler = () => new Promise<void>((resolve) => void scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, resolve));

afterEach(async () => {
  cleanup();
  await drainScheduler();
});

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
