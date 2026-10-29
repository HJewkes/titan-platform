import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { editHarness } from "./edit-cli.test-helpers.js";
import { editLogFile } from "./edit-ledger.js";
import type { LaunchIo } from "./edit-launch.js";
import { fixture, type Fixture } from "./run-fakes.test-helpers.js";

// Synthetic: an invented parcel desk, run on fakes end to end; no real script, run, render or note.
let fx: Fixture;
afterEach(() => fx.cleanup());

const { baseRun, editFile, cli } = editHarness(() => fx);
const figures = [{ id: "scan-rate", value: 4, label: "Scans a minute" }];

function fakeLaunch(reachable: boolean) {
  const ran: { command: string; args: readonly string[] }[] = [];
  const detached: { argv: readonly string[]; logFile: string }[] = [];
  const launch: LaunchIo = {
    systemdReachable: () => reachable,
    run: (command, args) => (ran.push({ command, args }), 0),
    detach: (argv, logFile) => void detached.push({ argv, logFile }),
    node: "/opt/node",
    bin: "/opt/explainer.js",
  };
  return { launch, ran, detached };
}

async function applyStarted(launch: LaunchIo) {
  fx = fixture();
  const base = await baseRun();
  const { text } = await cli(["apply", editFile(base, { h1: { slots: { figures } } }), "--start", "--json"], { launch });
  return z.object({ editId: z.string() }).parse(JSON.parse(text)).editId;
}

describe("explainer edit apply --start through the default launcher", () => {
  it("starts the run as the edit's own transient unit, logging to the edit's log file", async () => {
    const { launch, ran, detached } = fakeLaunch(true);

    const editId = await applyStarted(launch);

    const log = editLogFile(fx.dataDir, editId);
    expect(detached).toEqual([]);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.args).toEqual(expect.arrayContaining(["--unit", `explainer-run-${editId}`, `--property=StandardOutput=append:${log}`, "--", "/opt/node", "/opt/explainer.js", "run"]));
  });

  it("launches a detached child logging to the edit's log file when no user manager is reachable", async () => {
    const { launch, ran, detached } = fakeLaunch(false);

    const editId = await applyStarted(launch);

    expect(ran).toEqual([]);
    expect(detached).toHaveLength(1);
    expect(detached[0]).toMatchObject({ logFile: editLogFile(fx.dataDir, editId) });
    expect(detached[0]!.argv.slice(0, 2)).toEqual(["run", "--from"]);
  });
});
