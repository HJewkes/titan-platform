import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HostCommand } from "@titan-design/owner-queue";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import { runCommand, type CommandResult } from "../run-command.js";

/**
 * Each vetted command as data: the script it runs, relative to the installed agent-chat checkout. A deposit names only the
 * id, so no path or argument it carries ever reaches the host. Each script takes no arguments.
 */
const VETTED: Readonly<Record<HostCommand, { checkoutScript: string }>> = Object.freeze({
  "broker-restart-window": { checkoutScript: "scripts/restart-window.sh" },
});

/** The host boundary a host command needs: the installed CLI's real path, a file check, and `systemd-run --user`. */
export interface HostCommandPorts {
  realpath(path: string): string;
  exists(path: string): boolean;
  systemdRun(args: readonly string[]): Promise<CommandResult | undefined>;
}

export interface HostCommandDeps {
  /** The agent-chat CLI whose checkout holds the vetted scripts; absent, every host command answers 503. */
  agentChatBin: string | undefined;
  hostPorts: HostCommandPorts;
  /** The `done` results this action id already logged, so a replayed record never starts a second run. */
  done: (actionId: string) => Promise<object[]>;
}

export const systemHostCommandPorts = (): HostCommandPorts => ({
  realpath: (path) => realpathSync(path),
  exists: (path) => existsSync(path),
  systemdRun: (args) => runCommand("systemd-run", args),
});

/** One fixed unit per command, so systemd itself refuses a second run while the first is still loaded. */
export const hostUnitName = (command: HostCommand): string => `titan-host-${command}`;

/**
 * Starts the vetted command as a transient `systemd-run --user` unit and returns once systemd has started it. The unit is a
 * child of the user's systemd manager and takes the manager's environment, never the factory's or an agent's, so a broker
 * restart can never inherit an agent session's shims (CC-1653). It runs for minutes, past the console's post timeout, so the
 * tap answers `host-command-started` and the run's exit code and log are read from the unit's journal afterwards.
 */
export async function runHostCommand(actionId: string, { op }: OpRead, deps: HostCommandDeps): Promise<Outcome> {
  if (op.kind !== "host-command") return refused("record", `host-command cannot run a ${op.kind} op`);
  const unit = hostUnitName(op.command);
  if ((await deps.done(actionId)).some(startedUnit)) return { outcome: "already", unit };
  const script = vettedScript(op.command, deps);
  if (typeof script !== "string") return script;
  const run = await deps.hostPorts.systemdRun(["--user", "--unit", unit, "--collect", "--", script]);
  if (run === undefined) return refused("host-unavailable", "systemd-run is not on PATH");
  if (run.code !== 0) return startFailure(unit, run);
  return { outcome: "host-command-started", command: op.command, unit, invocationId: invocationIdOf(run.stderr) };
}

const startedUnit = (result: object): boolean => "outcome" in result && result.outcome === "host-command-started";

/** The script beside the installed CLI: the nearest ancestor of its real path that holds the command's script. */
function vettedScript(command: HostCommand, { agentChatBin, hostPorts }: HostCommandDeps): string | Outcome {
  if (agentChatBin === undefined) return refused("agent-chat-unavailable", "serve has no shepherd.agentChatBin");
  const { checkoutScript } = VETTED[command];
  let dir = dirname(realpathOr(hostPorts, agentChatBin));
  for (;;) {
    const candidate = join(dir, checkoutScript);
    if (hostPorts.exists(candidate)) return candidate;
    if (dirname(dir) === dir) return refused("host-unavailable", `no ${checkoutScript} above the installed agent-chat (${agentChatBin})`);
    dir = dirname(dir);
  }
}

function realpathOr({ realpath }: HostCommandPorts, path: string): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

function startFailure(unit: string, { code, stderr }: CommandResult): Outcome {
  const detail = stderr.trim() || `systemd-run exited ${code}`;
  if (/already (exists|loaded)/i.test(stderr)) return refused("host-busy", `${unit} is still loaded from an earlier run: ${detail}`);
  return refused("host-unavailable", detail);
}

/** systemd-run names the run's invocation on stderr; the journal reads one run's log by it. */
const invocationIdOf = (stderr: string): string | null => /invocation ID:?\s*([0-9a-f]{32})/i.exec(stderr)?.[1] ?? null;
