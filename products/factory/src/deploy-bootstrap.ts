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

const START_BOUNDARY = /["'\s>=]/;
const END_BOUNDARY = /["'\s<]/;
const xmlEscaped = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Whether the installed plist or unit starts the deploy checkout's bin. Until `service install` has
 * re-rendered it, the service runs from another tree, so a restart would only bring that tree back
 * and the sha check would roll the deploy back.
 */
export function serviceRunsFromCheckout(ports: DeployPorts, checkout: string): boolean {
  const raw = ports.readFile(installedServiceFile(ports));
  if (raw === undefined) return false;
  const text = withoutInertLines(raw);
  const bin = deployedBinPath(checkout);
  return namesWholePath(text, bin) || namesWholePath(text, xmlEscaped(bin));
}

const SYSTEMD_ASSIGNMENT = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/;
const EXEC_PREFIX = /^\s*[-@:+!]*/;

/**
 * Keeps what can start the service: in a systemd unit only `ExecStart` values (after joining `\`
 * continuations, as systemd does), since comments, `Environment=` and every other key are data.
 * Lines that are not `Key=value` (plist XML) pass through unchanged.
 */
function withoutInertLines(text: string): string {
  return text
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .filter((line) => !/^\s*[#;]/.test(line))
    .flatMap((line) => {
      const assignment = SYSTEMD_ASSIGNMENT.exec(line);
      if (assignment === null) return [line];
      return assignment[1] === "ExecStart" ? [(assignment[2] ?? "").replace(EXEC_PREFIX, "")] : [];
    })
    .join("\n");
}

/**
 * A path match must sit between token boundaries, both chosen from short accept lists:
 * `/x/<bin>`, `<bin>.old` and `<bin>+old` are other files. A quote that opens the match must also close it.
 */
function namesWholePath(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const before = at === 0 ? "" : text.charAt(at - 1);
    const after = text.charAt(at + path.length);
    const startsClean = before === "" || START_BOUNDARY.test(before);
    const endsClean = after === "" || END_BOUNDARY.test(after);
    const quoteClosed = !/["']/.test(before) || after === before;
    if (startsClean && endsClean && quoteClosed) return true;
  }
  return false;
}
