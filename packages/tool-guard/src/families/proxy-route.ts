import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";

const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);

/** Variables that send curl, wget or git traffic through another host or program, or load config that can. */
const ROUTING_VAR = new RegExp(
  "^(?:(?:https?|all|ftp)_proxy" +
    "|GIT_PROXY_COMMAND|GIT_SSH|GIT_SSH_COMMAND" +
    "|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_(?:KEY|VALUE)_\\d+" +
    "|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM" +
    "|CURL_HOME|WGETRC)$",
);
const PROXY_VAR = /^(?:https?|all|ftp)_proxy$/i;

/**
 * git keys that move where a push goes or what carries it. Matched case-insensitively as a whole: git keeps a
 * subsection's case, so this over-matches only there, which fails closed.
 */
const ROUTING_KEY = new RegExp(
  "^(?:http\\.(?:.+\\.)?(?:proxy|curloptresolve)" +
    "|remote\\..+\\.(?:proxy|url|pushurl)" +
    "|url\\..+\\.(?:insteadof|pushinsteadof)" +
    "|core\\.(?:gitproxy|sshcommand)" +
    "|include\\.path|includeif\\..+\\.path)$",
  "i",
);

/** Whether setting `name` can route HTTP or git traffic elsewhere. `no_proxy` only narrows routing, so it is not one. */
export function isRoutingVar(name: string): boolean {
  return PROXY_VAR.test(name) || ROUTING_VAR.test(name);
}

/** Whether `cmd` is a declarer that exports, or may export, a routing variable to the commands after it. */
export function declaresRouting(cmd: SimpleCommand): boolean {
  if (cmd.name === null || !DECLARERS.has(cmd.name)) return false;
  const { options, names } = splitDeclaration(cmd.args);
  if (cmd.name === "export" && options.some((o) => o.startsWith("-") && o.includes("n"))) return false;
  return names.some(namesRouting);
}

/** Whether the git global words `globals`, before the subcommand, set a routing key or one only known at run time. */
export function gitConfigRoutes(globals: WordToken[]): boolean {
  let takesValue: string | null = null;
  for (const word of globals) {
    if (takesValue !== null) {
      if (settingRoutes(word, takesValue === "--config-env")) return true;
      takesValue = null;
    } else if (word.value === "-c" || word.value === "--config-env") takesValue = word.value;
    else if (word.value.startsWith("--config-env=")) {
      if (word.dynamic || ROUTING_KEY.test(envKey(word.value.slice("--config-env=".length)))) return true;
    }
  }
  return false;
}

function splitDeclaration(args: WordToken[]): { options: string[]; names: WordToken[] } {
  const options: string[] = [];
  for (const [i, word] of args.entries()) {
    if (word.value === "--") return { options, names: args.slice(i + 1) };
    if (word.dynamic || !/^[-+]./.test(word.value) || word.value.includes("=")) return { options, names: args.slice(i) };
    options.push(word.value);
  }
  return { options, names: [] };
}

/** An append (`NAME+=`) exports whatever value the variable already held, so even an empty one counts. */
function namesRouting(word: WordToken): boolean {
  const eq = word.value.indexOf("=");
  const end = eq < 0 ? word.value.length : eq;
  if (dynamicBefore(word, end)) return true;
  const name = word.value.slice(0, end).replace(/\[.*$/s, "");
  const append = name.endsWith("+");
  if (!isRoutingVar(append ? name.slice(0, -1) : name)) return false;
  return eq < 0 || append || word.dynamic || eq < word.value.length - 1;
}

/**
 * `-c` splits its setting at the first `=`, which run-time text after it cannot move. `--config-env` splits at the
 * last, since its value names an environment variable, so run-time text anywhere can move the key's end.
 */
function settingRoutes(word: WordToken, fromEnv: boolean): boolean {
  if (fromEnv) return word.dynamic || ROUTING_KEY.test(envKey(word.value));
  const eq = word.value.indexOf("=");
  const end = eq < 0 ? word.value.length : eq;
  return dynamicBefore(word, end) || ROUTING_KEY.test(word.value.slice(0, end));
}

function envKey(setting: string): string {
  const eq = setting.lastIndexOf("=");
  return eq < 0 ? setting : setting.slice(0, eq);
}

/** Whether run-time text lands in `word.value` before index `end`, through a variable or a substitution. */
function dynamicBefore(word: WordToken, end: number): boolean {
  if (!word.dynamic) return false;
  return word.refs.some((r) => r.start < end) || (word.cuts ?? []).some((c) => c.at <= end) || /[$`]/.test(word.value.slice(0, end));
}
