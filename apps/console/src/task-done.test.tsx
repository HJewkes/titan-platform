// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { errorEnvelope, successEnvelope } from "@titan-design/registry";
import { staticSource, type DataSource } from "@titan-design/rpc-client";
import { recorded } from "./tasks.test-helpers.js";
import { renderPage } from "./render-page.test-helpers.js";

afterEach(cleanup);

/** The recorded task page as the read source, counting each `work.task` read it answers. */
function countingReads() {
  const inner = staticSource({ snapshot: recorded() });
  const state = { taskReads: 0 };
  const source: DataSource = {
    call: async (name, args, options) => {
      if (name === "work.task") state.taskReads += 1;
      return inner.call(name, args, options);
    },
    subscribe: (handlers, options) => inner.subscribe(handlers, options),
  };
  return { source, state };
}

function recordingWriter(answer: (name: string) => ReturnType<DataSource["call"]>) {
  const calls: { name: string; args: unknown }[] = [];
  const writer: DataSource = {
    call: (name, args) => {
      calls.push({ name, args });
      return answer(name);
    },
    subscribe: () => ({ close: () => undefined }),
  };
  return { calls, writer };
}

const written = (status: string) => async () => successEnvelope({ id: "OR-1", status });

describe("marking a task done from its page", () => {
  it("sends work.task-done, reads the task again, and offers Undo that reopens it", async () => {
    const { source, state } = countingReads();
    const { calls, writer } = recordingWriter(written("done"));
    renderPage(source, "#/tasks/OR-1", { answers: writer });

    fireEvent.click(await screen.findByRole("button", { name: "Mark done" }));

    await waitFor(() => expect(calls).toEqual([{ name: "work.task-done", args: { slug: "orbit-relay", id: "OR-1" } }]));
    await waitFor(() => expect(state.taskReads).toBe(2));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls[1]).toEqual({ name: "work.task-done", args: { slug: "orbit-relay", id: "OR-1", undo: true } }));
    await waitFor(() => expect(state.taskReads).toBe(3));
    expect(await screen.findByRole("button", { name: "Mark done" })).toBeTruthy();
  });

  it("shows the refusal and keeps Mark done when the console refuses the write", async () => {
    const { source } = countingReads();
    const { writer } = recordingWriter(async () => errorEnvelope("owner writes are off", 77));
    renderPage(source, "#/tasks/OR-1", { answers: writer });

    fireEvent.click(await screen.findByRole("button", { name: "Mark done" }));

    expect(await screen.findByText("The task was not changed: owner writes are off")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("offers no button on a saved copy of the page, which has no daemon to write through", async () => {
    const { source } = countingReads();
    renderPage(source, "#/tasks/OR-1");
    await screen.findByText("OR-1 Retry a dropped handshake");
    expect(screen.queryByRole("button", { name: "Mark done" })).toBeNull();
  });
});
