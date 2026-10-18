import type { GuardedPath } from "../paths.js";
import type { SimpleCommand } from "../shell/commands.js";
import { resolveValue } from "../shell/path.js";
import type { ClassifyContext } from "../types.js";

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
/** With no known cwd a relative script could sit in any directory, so any `cli` script counts. */
const UNPLACED_SCRIPT_RE = /(?:^|\/)cli\.[cm]?[jt]s$/;
const SCRIPT_RUNNERS = new Set(["node", "tsx", "bun", "deno", "ts-node"]);

/**
 * Two-word owner verbs by group: `token rotate` resets the owner's LAN session (TP-3579 K2), and `config import`
 * seeds revision 0 of the config store, which an agent running first would fill with caps of its own choosing.
 */
const GROUPED_OWNER_VERBS: Readonly<Record<string, string>> = { token: "rotate", config: "import" };

/** One argument as the console reads it: a known word, or one only known at run time. */
interface ConsoleWord {
  value: string;
  dynamic: boolean;
}

/** `titan-console login-link`, `token rotate` or `config import`, as the subject pattern; null for any other verb. */
export function consoleOwnerVerb(cmd: SimpleCommand, ctx: ClassifyContext): string | null {
  const words = consoleArgs(cmd, ctx);
  if (words === null) return null;
  const [first, second] = words;
  if (first === undefined) return null;
  if (first.dynamic || first.value === "login-link") return "titan-console:login-link";
  const verb = Object.hasOwn(GROUPED_OWNER_VERBS, first.value) ? GROUPED_OWNER_VERBS[first.value] : undefined;
  if (verb === undefined || second === undefined) return null;
  return second.dynamic || second.value === verb ? `titan-console:${first.value}-${verb}` : null;
}

/** The words after the console's command word or script path, or null when the command does not run the console. */
function consoleArgs(cmd: SimpleCommand, ctx: ClassifyContext): ConsoleWord[] | null {
  if (cmd.name === CONSOLE_BIN) return asReceived(cmd.args);
  if (cmd.name === null || !SCRIPT_RUNNERS.has(cmd.name)) return null;
  const at = cmd.args.findIndex((a) => !a.dynamic && isConsoleScript(a.value, cmd.dir, ctx));
  return at < 0 ? null : asReceived(cmd.args.slice(at + 1));
}

/** Tested where the runner finds it: resolved from the command's cwd, and through a symlink to the script. */
function isConsoleScript(value: string, dir: string | null, ctx: ClassifyContext): boolean {
  const path = resolveValue(dir, value, ctx.home);
  if (path === null) return UNPLACED_SCRIPT_RE.test(value);
  const real = ctx.readLink(path);
  return CONSOLE_SCRIPT_RE.test(path) || (real !== null && CONSOLE_SCRIPT_RE.test(real));
}

/** The CLI matches its verbs against `argv.join(" ")`, so one argument `"token rotate"` is the two words `token rotate`. */
function asReceived(args: SimpleCommand["args"]): ConsoleWord[] {
  return args.flatMap((a) => (a.dynamic ? [{ value: a.value, dynamic: true }] : splitWords(a.value)));
}

function splitWords(value: string): ConsoleWord[] {
  return value
    .split(/\s+/)
    .filter((w) => w !== "")
    .map((w) => ({ value: w, dynamic: false }));
}
