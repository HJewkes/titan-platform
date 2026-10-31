import type { ShepherdCommandName } from "./commands.js";

/**
 * Whether a command's in-process fallback is refused in an agent env (CC-1644 M2): a `write` is refused, a `read` runs
 * against the database here, and a `list-or-write` reads only when its action is `list`. Register is not declared a write:
 * without --offline it is refused before this is read.
 */
type PortAccess = "read" | "write" | "list-or-write";

/** One entry per registry command, so a new verb cannot reach the in-process fallback without saying whether it writes. */
export const SHEPHERD_PORT_ACCESS = {
  "shepherd.register": "read",
  "shepherd.status": "read",
  "shepherd.list": "read",
  "shepherd.waiting": "read",
  "shepherd.timeline": "read",
  "shepherd.hold": "write",
  "shepherd.release": "write",
  "shepherd.repair-stop": "list-or-write",
  "shepherd.freeze": "read",
  "shepherd.thaw": "read",
  "shepherd.order": "list-or-write",
  "shepherd.fix-pr": "read",
  "shepherd.merge-base": "read",
  "shepherd.merge": "write",
  "shepherd.review": "write",
  "shepherd.resync": "write",
  "shepherd.prs": "read",
  "shepherd.watch": "read",
  "shepherd.visual-delta": "read",
  "shepherd.brief": "read",
} as const satisfies Record<ShepherdCommandName, PortAccess>;

const isList = (args: object): boolean => "action" in args && args.action === "list";

export function writesPort(name: ShepherdCommandName, args: object): boolean {
  const access: PortAccess = SHEPHERD_PORT_ACCESS[name];
  return access === "write" || (access === "list-or-write" && !isList(args));
}
