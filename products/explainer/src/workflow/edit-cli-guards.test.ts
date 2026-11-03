import { afterAll, afterEach, describe, expect, it } from "vitest";
import { editHarness, recordingSpawn } from "./edit-cli.test-helpers.js";
import { linkEditRun, readLedger } from "./edit-ledger.js";
import { dropSeeds, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, run on fakes end to end; no real script, run, render or note.
let fx: Fixture;
afterEach(() => fx.cleanup());
afterAll(dropSeeds);

const { baseRun, editFile, cli } = editHarness(() => fx, (next) => (fx = next));
const figures = [{ id: "scan-rate", value: 4, label: "Scans a minute" }];
const LINKED_RUN = "run-linked-synthetic";

/** `edit apply --start` on a fresh base, then the launched run linking itself, as the detached run does on start. */
async function startedEdit() {
  const base = await baseRun();
  const file = editFile(base, { h1: { slots: { figures } } });
  const { spawn, launched } = recordingSpawn();
  const { editId } = JSON.parse((await cli(["apply", file, "--start", "--json"], { spawn })).text);
  linkEditRun(fx.dataDir, editId, LINKED_RUN);
  return { file, editId, spawn, launched };
}

describe("explainer edit apply on an edit that already started a run", () => {
  it("refuses a second --start and launches nothing more", async () => {
    const { file, editId, spawn, launched } = await startedEdit();

    const { code, text } = await cli(["apply", file, "--start", "--json"], { spawn });

    expect(code).toBe(1);
    expect(text).toContain(`already started run ${LINKED_RUN}`);
    expect(launched).toHaveLength(1);
    expect(readLedger(fx.dataDir, editId)).toMatchObject({ status: "started", runId: LINKED_RUN });
  });

  it("refuses a plain apply, so the started row keeps its run and a later --start is still refused", async () => {
    const { file, editId, spawn, launched } = await startedEdit();

    const plain = await cli(["apply", file, "--json"], { spawn });
    const again = await cli(["apply", file, "--start", "--json"], { spawn });

    expect([plain.code, again.code]).toEqual([1, 1]);
    expect(readLedger(fx.dataDir, editId)).toMatchObject({ status: "started", runId: LINKED_RUN });
    expect(launched).toHaveLength(1);
  });
});
