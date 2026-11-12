import { dirname, join } from "node:path";
import { deployedBinPath } from "./deploy-checkout.js";
import type { DeployPorts } from "./deploy.js";
import { UNIT_NAME } from "./service.js";
import { isSystemd, serviceTarget } from "./service-control.js";
import type { CommandResult } from "./run-command.js";

/** `undefined` when the checkout already exists; otherwise the clone's result, or `no-remote`. Never copies a working tree. */
export async function cloneIfAbsent(ports: DeployPorts, checkout: string, remote: string | undefined): Promise<CommandResult | "no-remote" | undefined> {
  if (ports.exists(join(checkout, ".git"))) return undefined;
  if (remote === undefined) return "no-remote";
  ports.mkdir(dirname(checkout));
  return ports.clone(remote, checkout);
}

const WHITESPACE_OR_QUOTING = /[\s;"'\\]/;
const KEY_VALUE = (text: string, key: string): string | undefined => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];

/**
 * Whether the service manager's loaded job starts the deploy checkout's bin. Until `service install` has
 * re-rendered and reloaded it, the service runs from another tree, so a restart would only bring that tree
 * back and the sha check would roll the deploy back. Anything unclear answers false.
 */
export async function serviceRunsFromCheckout(ports: DeployPorts, checkout: string): Promise<boolean> {
  const bin = deployedBinPath(checkout);
  const argv = isSystemd(ports) ? await systemdExecArgv(ports, bin) : await launchdArguments(ports, bin);
  return argv !== undefined && argv[1] === bin;
}

/** systemd joins argv with spaces, so a bin holding a separator or quote cannot be told from two arguments. */
async function systemdExecArgv(ports: DeployPorts, bin: string): Promise<string[] | undefined> {
  if (WHITESPACE_OR_QUOTING.test(bin)) return undefined;
  const shown = await ports.systemctl(["--user", "show", UNIT_NAME, "--property=LoadState,ExecStart"]);
  if (shown.code !== 0 || KEY_VALUE(shown.stdout, "LoadState") !== "loaded") return undefined;
  const exec = KEY_VALUE(shown.stdout, "ExecStart") ?? "";
  if (exec.split("{").length !== 2 || exec.split("}").length !== 2) return undefined;
  const argv = /argv\[\]=(.*?)(?: ; |\s*\}$)/.exec(exec)?.[1];
  return argv?.split(" ");
}

/** launchd prints one unescaped argument per line inside the job's top-level `arguments = {` block. */
async function launchdArguments(ports: DeployPorts, bin: string): Promise<string[] | undefined> {
  if (bin !== bin.trim()) return undefined;
  const printed = await ports.launchctl(["print", serviceTarget(ports)]);
  if (printed.code !== 0) return undefined;
  const lines = printed.stdout.split("\n");
  const opens = lines.flatMap((line, at) => (line === "\targuments = {" ? [at] : []));
  const start = opens[0];
  if (opens.length !== 1 || start === undefined) return undefined;
  const end = lines.indexOf("\t}", start);
  return end === -1 ? undefined : lines.slice(start + 1, end).map((line) => line.trim());
}
