/**
 * `titan-console inbox link <item-id>`: the console URL that opens the inbox focused on one item (TP-4389), for a
 * seat to put in a message the owner reads on a phone. It names the LAN origin the certificate covers, so the phone
 * can dial it; only a console with no LAN listener gets a loopback link. It reads config alone, never the daemon, so
 * it prints a link for an id whether or not the item is still open: the page says when it is not.
 */
import type { ConsoleConfig } from "./config.js";
import { lanOrigin } from "./daemon.js";

export function inboxLinkArgs(argv: readonly string[]): { id: string } | null {
  const [noun, verb, id, ...rest] = argv;
  if (noun !== "inbox" || verb !== "link" || id === undefined || id === "" || id.startsWith("--") || rest.length > 0) return null;
  return { id };
}

/** The whole id is one hash segment, encoded as the page's `href` does, so a `/` in a gate id stays in the id. */
export function inboxLink(config: ConsoleConfig, id: string): string {
  if (config.port === 0) throw new Error("TITAN_CONSOLE_PORT is 0, so there is no fixed port to put in an inbox link");
  const origin = config.lanHost === null ? `http://127.0.0.1:${config.port}` : lanOrigin(config, config.port);
  return `${origin}/#/inbox/${encodeURIComponent(id)}`;
}
