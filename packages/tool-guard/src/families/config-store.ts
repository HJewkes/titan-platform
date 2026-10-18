import type { GuardedPath } from "../paths.js";
import type { SimpleCommand } from "../shell/commands.js";

const COORDINATOR_DOC = "coordinator.json";
const CONSOLE_STATE = "~/.local/state/titan-console";

/**
 * The fleet config store an agent must never write, since its caps and permissions live there (TP-3584): the
 * materialized coordinator document, under app-paths' config directory on each platform, and the console's owner
 * state (the LAN secret, the owner action records and the config revision log).
 */
export const CONFIG_STORE_PATHS: readonly GuardedPath[] = [
  coordinatorDir("xdg", "~/.config/titan-coordinator"),
  coordinatorDir("macos", "~/Library/Preferences/titan-coordinator"),
  { id: "home:titan-console/lan.token", pattern: `${CONSOLE_STATE}/lan.token` },
  consoleDir("owner-actions", "a1.json"),
  consoleDir("config", "log.jsonl"),
];

function coordinatorDir(where: string, dir: string): GuardedPath {
  return { id: `home:titan-coordinator-${where}`, pattern: `${dir}/**`, samples: [`${dir}/${COORDINATOR_DOC}`] };
}

function consoleDir(name: string, sample: string): GuardedPath {
  const dir = `${CONSOLE_STATE}/${name}`;
  return { id: `home:titan-console/${name}`, pattern: `${dir}/**`, samples: [`${dir}/${sample}`] };
}

const CONSOLE_BIN = "titan-console";
/** The console's own CLI script, run from a checkout or an installed package rather than through its bin. */
const CONSOLE_SCRIPT_RE = /(?:^|\/)(?:titan-)?console\/(?:server\/cli\.[cm]?[jt]s|dist\/cli\.[cm]?js)$/;
const SCRIPT_RUNNERS = new Set(["node", "tsx", "bun", "deno", "ts-node"]);

/**
 * Two-word owner verbs by group: `token rotate` resets the owner's LAN session (TP-3579 K2), and `config import`
 * seeds revision 0 of the config store, which an agent running first would fill with caps of its own choosing.
 */
const GROUPED_OWNER_VERBS: Readonly<Record<string, string>> = { token: "rotate", config: "import" };

/** `titan-console login-link`, `token rotate` or `config import`, as the subject pattern; null for any other verb. */
export function consoleOwnerVerb(cmd: SimpleCommand): string | null {
  const words = consoleArgs(cmd);
  if (words === null) return null;
  const [first, second] = words;
  if (first === undefined) return null;
  if (first.dynamic || first.value === "login-link") return "titan-console:login-link";
  const verb = Object.hasOwn(GROUPED_OWNER_VERBS, first.value) ? GROUPED_OWNER_VERBS[first.value] : undefined;
  if (verb === undefined || second === undefined) return null;
  return second.dynamic || second.value === verb ? `titan-console:${first.value}-${verb}` : null;
}

/** The words after the console's command word or script path, or null when the command does not run the console. */
function consoleArgs(cmd: SimpleCommand): SimpleCommand["args"] | null {
  if (cmd.name === CONSOLE_BIN) return cmd.args;
  if (cmd.name === null || !SCRIPT_RUNNERS.has(cmd.name)) return null;
  const at = cmd.args.findIndex((a) => CONSOLE_SCRIPT_RE.test(a.value));
  return at < 0 ? null : cmd.args.slice(at + 1);
}
