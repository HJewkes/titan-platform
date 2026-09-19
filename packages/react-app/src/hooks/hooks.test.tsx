// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { staticSource, buildSnapshot, type DataSource } from "@titan-design/rpc-client";
import { RpcProvider, createRpcHooks } from "../index.js";
import {
  createTestRegistry,
  notes,
  recordingSource,
  registryCaller,
  resetNotes,
  startTestDaemon,
  testLiveSource,
  type Commands,
  type TestDaemon,
} from "../test-fixtures.js";

const { useQuery, useEvents, useInvalidate, useInvalidateOn } = createRpcHooks<Commands>();

function Ids({ tag, label = "ids" }: { tag?: string; label?: string }) {
  const list = useQuery("note.list", tag ? { tag } : {});
  if (list.status === "loading") return <p>loading</p>;
  if (list.status === "error") return <p role="alert">{list.error.message}</p>;
  return (
    <p aria-label={label} data-fetching={String(list.isFetching)}>
      {list.data.ids.join(",")}
      <button onClick={list.refetch}>refetch {label}</button>
    </p>
  );
}

function withSource(source: DataSource, children: ReactNode) {
  return render(<RpcProvider source={source}>{children}</RpcProvider>);
}

const text = (label: string) => screen.getByLabelText(label).firstChild?.textContent;

let daemon: TestDaemon;

beforeAll(async () => {
  daemon = await startTestDaemon(createTestRegistry());
});
afterAll(async () => {
  await daemon.close();
});
beforeEach(resetNotes);
afterEach(cleanup);

describe("useQuery", () => {
  it("shares one call between components asking for the same args in a different key order", async () => {
    const source = recordingSource(testLiveSource(daemon));
    function Twice() {
      const a = useQuery("note.list", { tag: "ui", limit: 5 });
      const b = useQuery("note.list", { limit: 5, tag: "ui" });
      return <p aria-label="both">{a.data?.ids.join(",") === b.data?.ids.join(",") ? a.data?.ids.join(",") : "differ"}</p>;
    }
    withSource(source, <><Twice /><Twice /></>);

    await waitFor(() => expect(screen.getAllByLabelText("both")[0]).toHaveProperty("textContent", "n1,n3"));
    expect(source.calls).toHaveLength(1);
  });

  it("makes one call under StrictMode's mount, unmount, and remount", async () => {
    const source = recordingSource(testLiveSource(daemon));
    render(<StrictMode><RpcProvider source={source}><Ids /></RpcProvider></StrictMode>);

    await waitFor(() => expect(text("ids")).toBe("n1,n2,n3"));
    expect(source.calls).toHaveLength(1);
  });

  it("aborts the in-flight call when the last component using it unmounts", async () => {
    const source = recordingSource(testLiveSource(daemon));
    function Slow() {
      const slow = useQuery("note.slow", { ms: 5_000 });
      return <p>{slow.status}</p>;
    }
    const view = withSource(source, <Slow />);
    await waitFor(() => expect(source.calls).toHaveLength(1));
    const signal = source.calls[0]!.signal!;

    view.unmount();

    await waitFor(() => expect(signal.aborted).toBe(true));
  });

  it("keeps showing the old data while a refetch runs, then shows the new answer", async () => {
    const source = recordingSource(testLiveSource(daemon));
    withSource(source, <Ids />);
    await waitFor(() => expect(text("ids")).toBe("n1,n2,n3"));
    notes.pop();

    act(() => screen.getByRole("button").click());

    expect(text("ids")).toBe("n1,n2,n3");
    expect(screen.getByLabelText("ids").dataset.fetching).toBe("true");
    await waitFor(() => expect(text("ids")).toBe("n1,n2"));
    expect(source.calls).toHaveLength(2);
  });

  it("keeps the last good data beside the error when a refetch fails", async () => {
    function Note() {
      const note = useQuery("note.get", { id: "n2" });
      return (
        <p aria-label="note">
          {`${note.status}|${note.data?.text ?? ""}|${note.error?.code ?? ""}`}
          <button onClick={note.refetch}>refetch</button>
        </p>
      );
    }
    withSource(testLiveSource(daemon), <Note />);
    await waitFor(() => expect(text("note")).toBe("success|Serve the build|"));
    notes.splice(1, 1);

    act(() => screen.getByRole("button").click());

    await waitFor(() => expect(text("note")).toBe("error|Serve the build|66"));
  });

  it("ignores a superseded answer that arrives after the fresh one", async () => {
    const pending: Array<(data: unknown) => void> = [];
    const source: DataSource = {
      call: () => new Promise((resolve) => pending.push((data) => resolve({ ok: true, data }))),
      subscribe: () => ({ close: () => undefined }),
    };
    withSource(source, <Ids />);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => pending[0]!({ ids: ["first"] }));
    act(() => screen.getByRole("button").click());
    act(() => screen.getByRole("button").click());

    await act(async () => {
      pending[2]!({ ids: ["fresh"] });
      pending[1]!({ ids: ["stale"] });
    });

    expect(text("ids")).toBe("fresh");
  });

  it("reports a failed command as an RpcError with the daemon's exit code", async () => {
    function Missing() {
      const note = useQuery("note.get", { id: "nope" });
      return <p role="alert">{note.error ? `${note.error.name} ${note.error.code} ${note.error.message}` : note.status}</p>;
    }
    withSource(testLiveSource(daemon), <Missing />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("RpcError 66 No note nope"));
  });

  it("refuses to run outside a provider, naming the missing provider", () => {
    const quiet = console.error;
    console.error = () => undefined;
    try {
      expect(() => render(<Ids />)).toThrow(/inside <RpcProvider>/);
    } finally {
      console.error = quiet;
    }
  });
});

describe("invalidation", () => {
  it("refetches only the named command's queries when a matching event arrives", async () => {
    const source = recordingSource(testLiveSource(daemon));
    function App() {
      const status = useInvalidateOn({ events: ["notes.changed"], commands: ["note.list"] });
      const note = useQuery("note.get", { id: "n2" });
      return <><p aria-label="status">{status}</p><Ids />{note.data && <p aria-label="n2">{note.data.text}</p>}</>;
    }
    withSource(source, <App />);
    await waitFor(() => expect(text("status")).toBe("open"));
    await waitFor(() => expect(text("ids")).toBe("n1,n2,n3"));
    const before = source.calls.length;

    notes.push({ id: "n4", text: "Late", tags: [] });
    notes[1]!.text = "Changed but not invalidated";
    daemon.handle.hub.broadcast({ event: "other", data: "{}" });
    daemon.handle.hub.broadcast({ event: "notes.changed", data: "{}" });

    await waitFor(() => expect(text("ids")).toBe("n1,n2,n3,n4"));
    expect(source.calls.slice(before).map((c) => c.name)).toEqual(["note.list"]);
    expect(text("n2")).toBe("Serve the build");
  });

  it("refetches after the event stream reconnects, since frames sent while it was down are lost", async () => {
    function App() {
      const status = useInvalidateOn();
      return <><p aria-label="status">{status}</p><Ids /></>;
    }
    withSource(testLiveSource(daemon), <App />);
    await waitFor(() => expect(text("ids")).toBe("n1,n2,n3"));
    await waitFor(() => expect(text("status")).toBe("open"));

    notes.shift();
    await daemon.restart();

    await waitFor(() => expect(text("ids")).toBe("n2,n3"), { timeout: 3_000 });
  });

  it("refetches every watched query when invalidated with no names", async () => {
    let invalidate: ReturnType<typeof useInvalidate> = () => undefined;
    function App() {
      invalidate = useInvalidate();
      return <><Ids label="all" /><Ids tag="ui" label="ui" /></>;
    }
    withSource(testLiveSource(daemon), <App />);
    await waitFor(() => expect(text("ui")).toBe("n1,n3"));

    notes[1]!.tags.push("ui");
    act(() => invalidate());

    await waitFor(() => expect(text("ui")).toBe("n1,n2,n3"));
  });
});

describe("useEvents", () => {
  it("delivers product broadcasts over one shared stream and reports its status", async () => {
    const seen: string[] = [];
    let subscriptions = 0;
    const inner = testLiveSource(daemon);
    const source: DataSource = { call: inner.call, subscribe: (h, o) => (subscriptions++, inner.subscribe(h, o)) };
    function Listener({ id }: { id: string }) {
      const status = useEvents((m) => seen.push(`${id}:${m.event}:${m.data}`));
      return <p aria-label={id}>{status}</p>;
    }
    withSource(source, <><Listener id="a" /><Listener id="b" /></>);
    await waitFor(() => expect(text("a")).toBe("open"));

    daemon.handle.hub.broadcast({ event: "tick", data: "1" });

    await waitFor(() => expect(seen.sort()).toEqual(["a:tick:1", "b:tick:1"]));
    expect(subscriptions).toBe(1);
  });

  it("opens and then stays quiet over a static snapshot", async () => {
    const snapshot = await buildSnapshot(registryCaller(createTestRegistry()), { calls: [{ command: "note.list" }] });
    function App() {
      const status = useEvents();
      return <><p aria-label="status">{status}</p><Ids /></>;
    }
    withSource(staticSource({ snapshot }), <App />);
    await waitFor(() => expect(text("ids")).toBe("n1,n2,n3"));
    expect(text("status")).toBe("open");
  });
});
