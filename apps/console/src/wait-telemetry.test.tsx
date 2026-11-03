// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { DataSource } from "@titan-design/rpc-client";
import type { PerfRow } from "./data/perf.js";
import { createWaitTracker, trackWaitCalls, type WaitTracker } from "./data/waits.js";
import { Skeleton, Spinner, WaitTrackerProvider, useWait } from "./shell/Loading.js";

afterEach(cleanup);

const SECRET_ID = "TP-4242-secret";

function harness() {
  let clock = 1000;
  const rows: PerfRow[] = [];
  const tracker = createWaitTracker({ emit: (row) => rows.push(row), now: () => clock });
  return { rows, tracker, tick: (ms: number) => (clock += ms) };
}

/** A source whose calls stay open until the test answers them, so a wait can span a call. */
function pendingSource() {
  const answers: Array<(ok: boolean) => void> = [];
  const source: DataSource = {
    call: () => new Promise((resolve) => answers.push((ok) => resolve(ok ? { ok: true, data: {} } : { ok: false, error: "refused" }))),
    subscribe: () => ({ close: () => {} }) as never,
  };
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { source, answer: async (ok = true) => (answers.shift()?.(ok), await settled()) };
}

function Tracked({ tracker, children }: { tracker: WaitTracker; children: ReactNode }): ReactNode {
  return <WaitTrackerProvider value={tracker}>{children}</WaitTrackerProvider>;
}

function Busy({ busy }: { busy: boolean }): ReactNode {
  useWait(busy, true);
  return null;
}

describe("a page's spinner", () => {
  it("starts a wait on show and writes one row on hide", () => {
    const { rows, tracker, tick } = harness();
    tracker.setView("inbox");
    const view = render(<Tracked tracker={tracker}>{<Spinner size="sm" label="Loading" />}</Tracked>);

    tick(250);
    expect(rows).toEqual([]);
    view.rerender(<Tracked tracker={tracker}>{null}</Tracked>);

    expect(rows).toEqual([{ kind: "wait", view: "inbox", commands: [], ms: 250, phase: "cold", mutation: false }]);
  });

  it("ends the wait when the page unmounts while it still shows", () => {
    const { rows, tracker, tick } = harness();
    const view = render(<Tracked tracker={tracker}>{<Spinner size="sm" label="Loading" />}</Tracked>);

    tick(40);
    view.unmount();

    expect(rows).toEqual([expect.objectContaining({ kind: "wait", ms: 40 })]);
  });

  it("counts several skeletons shown together as one wait", () => {
    const { rows, tracker, tick } = harness();
    const view = render(
      <Tracked tracker={tracker}>
        <Skeleton />
        <Skeleton />
        <Spinner size="sm" label="Loading" />
      </Tracked>,
    );

    tick(90);
    view.unmount();

    expect(rows).toEqual([expect.objectContaining({ kind: "wait", ms: 90 })]);
  });

  it("names the commands in flight during the wait and never their arguments", async () => {
    const { rows, tracker } = harness();
    const { source, answer } = pendingSource();
    const reads = trackWaitCalls(source, tracker, null);
    void reads.call("work.task", { id: SECRET_ID });
    const view = render(<Tracked tracker={tracker}>{<Spinner size="sm" label={`Loading ${SECRET_ID}`} />}</Tracked>);
    void reads.call("work.taskMentions", { id: SECRET_ID });

    await answer();
    await answer();
    view.unmount();

    expect(rows).toEqual([expect.objectContaining({ commands: ["work.task", "work.taskMentions"], phase: "cold" })]);
    expect(JSON.stringify(rows)).not.toContain(SECRET_ID);
  });

  it("is a refetch once every command it waited on has answered before", async () => {
    const { rows, tracker } = harness();
    const { source, answer } = pendingSource();
    const reads = trackWaitCalls(source, tracker, null);
    void reads.call("inbox.list", {});
    await answer();

    void reads.call("inbox.list", {});
    render(<Tracked tracker={tracker}>{<Spinner size="sm" label="Loading" />}</Tracked>).unmount();

    expect(rows).toEqual([expect.objectContaining({ commands: ["inbox.list"], phase: "refetch" })]);
  });
});

describe("a background refetch", () => {
  it("writes no wait row when no loader shows", async () => {
    const { rows, tracker } = harness();
    const { source, answer } = pendingSource();
    render(<Tracked tracker={tracker}>{<p>the page with its data</p>}</Tracked>);

    void trackWaitCalls(source, tracker, null).call("inbox.list", {});
    await answer();

    expect(rows).toEqual([]);
  });
});

describe("a busy button", () => {
  it("times the write as a mutation wait on the written command alone, and as an action row", async () => {
    const { rows, tracker, tick } = harness();
    const { source, answer } = pendingSource();
    const actionRows: PerfRow[] = [];
    void trackWaitCalls(source, tracker, null).call("inbox.list", {});
    const view = render(<Tracked tracker={tracker}>{<Busy busy />}</Tracked>);
    void trackWaitCalls(source, tracker, { emit: (row) => actionRows.push(row), now: () => 0 }).call("inbox.act", { itemId: SECRET_ID });

    tick(600);
    await answer();
    await answer(false);
    view.rerender(<Tracked tracker={tracker}>{<Busy busy={false} />}</Tracked>);

    expect(rows).toEqual([{ kind: "wait", view: "home", commands: ["inbox.act"], ms: 600, phase: "cold", mutation: true }]);
    expect(actionRows).toEqual([{ kind: "action", command: "inbox.act", ms: 0, ok: false }]);
  });
});
