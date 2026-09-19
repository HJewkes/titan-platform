// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { parseSnapshot, staticSource, type DataSource } from "@titan-design/rpc-client";
import { exportSnapshot } from "@titan-design/rpc-client/node";
import { RpcProvider, createRpcHooks } from "./index.js";
import { createTestRegistry, registryCaller, resetNotes, startTestDaemon, testLiveSource, type Commands, type TestDaemon } from "./test-fixtures.js";

const { useQuery } = createRpcHooks<Commands>();

/** Report-app component code: it knows the command map and nothing about where answers come from. */
function NoteView({ id }: { id: string }) {
  const note = useQuery("note.get", { id });
  if (note.status === "loading") return <p>loading {id}</p>;
  if (note.status === "error") return <p role="alert">{`${note.error.code}: ${note.error.message}`}</p>;
  return <li>{`${note.data.id}: ${note.data.text} [${note.data.tags.join(",")}]`}</li>;
}

function Report() {
  const all = useQuery("note.list");
  const ui = useQuery("note.list", { tag: "ui" });
  if (all.status !== "success" || ui.status !== "success") return <p>loading report</p>;
  return (
    <section>
      <h1>{`${all.data.ids.length} notes, ${ui.data.ids.length} tagged ui`}</h1>
      <ul>{all.data.ids.map((id) => <NoteView key={id} id={id} />)}</ul>
      <NoteView id="missing" />
    </section>
  );
}

const PLAN = [
  { command: "note.list" },
  { command: "note.list", args: { tag: "ui" } },
  ...["n1", "n2", "n3", "missing"].map((id) => ({ command: "note.get", args: { id } })),
];

async function renderReport(source: DataSource): Promise<string> {
  const { container, unmount } = render(
    <RpcProvider source={source}>
      <Report />
    </RpcProvider>,
  );
  await screen.findByRole("alert");
  await screen.findByText("n3: Export a snapshot [ui,export]");
  const html = container.innerHTML;
  unmount();
  return html;
}

let daemon: TestDaemon;
let dir: string;

beforeEach(async () => {
  resetNotes();
  daemon = await startTestDaemon(createTestRegistry());
  dir = await mkdtemp(path.join(tmpdir(), "react-app-parity-"));
});

afterEach(async () => {
  cleanup();
  await daemon.close();
  await rm(dir, { recursive: true, force: true });
});

describe("one component tree, two data sources", () => {
  it("renders the same markup from a live daemon and from an exported snapshot file", async () => {
    const file = path.join(dir, "snapshot.json");
    await exportSnapshot(file, registryCaller(createTestRegistry()), { calls: PLAN });
    const snapshot = parseSnapshot(JSON.parse(await readFile(file, "utf8")));

    const live = await renderReport(testLiveSource(daemon));
    const offline = await renderReport(staticSource({ snapshot }));

    expect(offline).toBe(live);
    expect(live).toContain("<h1>3 notes, 2 tagged ui</h1>");
    expect(live).toContain("66: No note missing");
  });
});
