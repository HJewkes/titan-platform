import { dirname, join } from "node:path";
import { deployedBinPath } from "./deploy-checkout.js";
import type { DeployPorts } from "./deploy.js";
import { installedServiceFile } from "./service-control.js";
import type { CommandResult } from "./run-command.js";

/** `undefined` when the checkout already exists; otherwise the clone's result, or `no-remote`. Never copies a working tree. */
export async function cloneIfAbsent(ports: DeployPorts, checkout: string, remote: string | undefined): Promise<CommandResult | "no-remote" | undefined> {
  if (ports.exists(join(checkout, ".git"))) return undefined;
  if (remote === undefined) return "no-remote";
  ports.mkdir(dirname(checkout));
  return ports.clone(remote, checkout);
}

const PATH_CHAR = /[\w.\-/~]/;
const xmlEscaped = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Whether the installed plist or unit starts the deploy checkout's bin. Until `service install` has
 * re-rendered it, the service runs from another tree, so a restart would only bring that tree back
 * and the sha check would roll the deploy back.
 */
export function serviceRunsFromCheckout(ports: DeployPorts, checkout: string): boolean {
  const text = ports.readFile(installedServiceFile(ports));
  const bin = deployedBinPath(checkout);
  return text !== undefined && (namesWholePath(text, bin) || namesWholePath(text, xmlEscaped(bin)));
}

/** A path match must start at a token boundary, so `/x/<checkout>/...` does not count as `<checkout>/...`. */
function namesWholePath(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    if (at === 0 || !PATH_CHAR.test(text.charAt(at - 1))) return true;
  }
  return false;
}
