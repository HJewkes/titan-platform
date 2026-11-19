import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerOp } from "@titan-design/owner-queue";
import { afterEach, describe, expect, it } from "vitest";
import { actOnOp } from "../console-action/op.js";
import type { Outcome } from "../console-action/outcome.js";
import type { CommandResult } from "../run-command.js";
import { runHostCommand, systemHostCommandPorts, type HostCommandDeps } from "./host-command.js";
import { doneResults, ownerOpsLedger, runLogged } from "./ledger.js";

const OP: OwnerOp = { kind: "host-command", command: "broker-restart-window" };
const CONFIRM = `action:${"d".repeat(64)}`;
const NOW = () => Date.parse("2026-11-19T12:00:00.000Z");
const INVOCATION = "0123456789abcdef0123456789abcdef";
const STARTED: CommandResult = { code: 0, stdout: "", stderr: `Running as unit: titan-host-broker-restart-window.service; invocation ID: ${INVOCATION}\n` };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A synthetic agent-chat checkout with its CLI under dist/ and a `bin/agent-chat` symlink to it, as an install links it. */
function checkout(): { root: string; bin: string; script: string } {
  const root = mkdtempSync(join(tmpdir(), "factory-host-command-"));
  dirs.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "bin"));
  const script = join(root, "scripts", "restart-window.sh");
  writeFileSync(script, "#!/bin/sh\nexit 0\n");
  writeFileSync(join(root, "dist", "cli.js"), "");
  const bin = join(root, "bin", "agent-chat");
  symlinkSync(join(root, "dist", "cli.js"), bin);
  return { root, bin, script };
}

function world(result: CommandResult | "absent" = STARTED, agentChatBin?: string) {
  const { root, bin, script } = checkout();
  const calls: (readonly string[])[] = [];
  const hostPorts = { ...systemHostCommandPorts(), systemdRun: async (args: readonly string[]) => (calls.push(args), result === "absent" ? undefined : result) };
  const ledger = ownerOpsLedger(root);
  const deps: HostCommandDeps = { agentChatBin: agentChatBin ?? bin, hostPorts, done: (id) => doneResults(root, id) };
  const tap = (op: OwnerOp = OP, actionId = "act-1"): Promise<Outcome> =>
    runLogged(ledger, { actionId, op, now: NOW }, () => runHostCommand(actionId, { op, confirmEvent: CONFIRM }, deps));
  return { calls, script, tap, deps, ledger };
}

describe("a host-command op", () => {
  it("starts the vetted script found beside the installed CLI as a transient user unit, with no argument from the deposit", async () => {
    const w = world();

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "host-command-started", command: "broker-restart-window", unit: "titan-host-broker-restart-window", invocationId: INVOCATION });
    expect(w.calls).toEqual([["--user", "--unit", "titan-host-broker-restart-window", "--collect", "--", w.script]]);
  });

  it("answers already for a replayed record and never starts a second run", async () => {
    const w = world();
    await w.tap();

    const replay = await w.tap();

    expect(replay).toEqual({ outcome: "already", unit: "titan-host-broker-restart-window" });
    expect(w.calls).toHaveLength(1);
  });

  it("refuses as busy while systemd still holds the unit from an earlier run", async () => {
    const w = world({ code: 1, stdout: "", stderr: "Failed to start transient service unit: Unit titan-host-broker-restart-window.service already exists.\n" });

    const outcome = await w.tap();

    expect(outcome).toMatchObject({ outcome: "refused", reason: "host-busy" });
  });

  it("refuses as unavailable when systemd-run is not on PATH", async () => {
    const outcome = await world("absent").tap();

    expect(outcome).toEqual({ outcome: "refused", reason: "host-unavailable", detail: "systemd-run is not on PATH" });
  });

  it("refuses without starting anything when no checkout above the CLI holds the script", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "factory-host-command-bare-"));
    dirs.push(elsewhere);
    writeFileSync(join(elsewhere, "agent-chat"), "");
    const w = world(STARTED, join(elsewhere, "agent-chat"));

    const outcome = await w.tap();

    expect(outcome).toMatchObject({ outcome: "refused", reason: "host-unavailable" });
    expect(w.calls).toEqual([]);
  });

  it("refuses without starting anything when serve has no agent-chat binary", async () => {
    const w = world();
    const outcome = await runHostCommand("act-1", { op: OP, confirmEvent: CONFIRM }, { ...w.deps, agentChatBin: undefined });

    expect(outcome).toMatchObject({ outcome: "refused", reason: "agent-chat-unavailable" });
    expect(w.calls).toEqual([]);
  });

  it("is refused by the authority table before it reaches the host, until the owner picks its row", async () => {
    const w = world();

    const outcome = await actOnOp("act-1", { op: OP, confirmEvent: CONFIRM }, { effects: { "host-command": runHostCommand }, ledger: w.ledger, now: NOW }, w.deps);

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class" });
    expect(w.calls).toEqual([]);
    expect(await w.ledger.read("act-1")).toEqual([]);
  });
});
