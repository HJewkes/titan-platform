import type { GuardedPath } from "../paths.js";
import type { SimpleCommand } from "../shell/commands.js";
import type { ClassifyContext } from "../types.js";
import { runnerReadings, SCRIPT_RUNNERS } from "./console-script.js";

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
  // The directory alone, not what is under it: removing, moving or copying over it takes the owner state with it, while
  // agents still deposit into its inbox and rounds.
  { id: "home:titan-console", pattern: CONSOLE_STATE },
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
  for (const words of consoleArgs(cmd, ctx)) {
    const verb = ownerVerb(asReceived(words));
    if (verb !== null) return verb;
  }
  return null;
}

function ownerVerb([first, second]: ConsoleWord[]): string | null {
  if (first === undefined) return null;
  if (first.dynamic || first.value === "login-link") return "titan-console:login-link";
  const verb = Object.hasOwn(GROUPED_OWNER_VERBS, first.value) ? GROUPED_OWNER_VERBS[first.value] : undefined;
  if (verb === undefined || second === undefined) return null;
  return second.dynamic || second.value === verb ? `titan-console:${first.value}-${verb}` : null;
}

/** Each argument list the console may receive from this command; none when it does not run the console. */
function consoleArgs(cmd: SimpleCommand, ctx: ClassifyContext): SimpleCommand["args"][] {
  if (cmd.name === CONSOLE_BIN) return [cmd.args];
  return cmd.name !== null && SCRIPT_RUNNERS.has(cmd.name) ? runnerReadings(cmd, ctx) : [];
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
