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
  "^(?:http\\.(?:.+\\.)?proxy" +
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
  for (let i = 0; i < globals.length; i++) {
    const v = (globals[i] as WordToken).value;
    if (v === "-c" || v === "--config-env") {
      const value = globals[++i];
      if (value && settingRoutes(value, v === "--config-env")) return true;
    } else if (v.startsWith("--config-env=")) {
      if (settingRoutes(dropPrefix(globals[i] as WordToken, "--config-env=".length), true)) return true;
    }
  }
  return false;
}

function splitDeclaration(args: WordToken[]): { options: string[]; names: WordToken[] } {
  const options: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const v = (args[i] as WordToken).value;
    if (v === "--") {
      i++;
      break;
    }
    if ((args[i] as WordToken).dynamic || !/^[-+]./.test(v) || v.includes("=")) break;
    options.push(v);
  }
  return { options, names: args.slice(i) };
}

function namesRouting(word: WordToken): boolean {
  const eq = word.value.indexOf("=");
  const end = eq < 0 ? word.value.length : eq;
  if (dynamicBefore(word, end)) return true;
  if (!isRoutingVar(word.value.slice(0, end).replace(/\[.*$/s, ""))) return false;
  return eq < 0 || word.dynamic || eq < word.value.length - 1;
}

/**
 * `-c` splits its setting at the first `=`, and `--config-env` at the last, since its value is an environment
 * variable's name. A dynamic key may name anything; a dynamic value under a static key changes nothing here.
 */
function settingRoutes(word: WordToken, fromEnv: boolean): boolean {
  const eq = fromEnv ? word.value.lastIndexOf("=") : word.value.indexOf("=");
  const end = eq < 0 ? word.value.length : eq;
  return dynamicBefore(word, end) || ROUTING_KEY.test(word.value.slice(0, end));
}

/** Whether run-time text lands in `word.value` before index `end`, through a variable or a substitution. */
function dynamicBefore(word: WordToken, end: number): boolean {
  if (!word.dynamic) return false;
  return word.refs.some((r) => r.start < end) || (word.cuts ?? []).some((c) => c.at <= end) || /[$`]/.test(word.value.slice(0, end));
}

function dropPrefix(word: WordToken, by: number): WordToken {
  const refs = word.refs.map((r) => ({ ...r, start: r.start - by, end: r.end - by }));
  const cuts = word.cuts?.map((c) => ({ ...c, at: c.at - by }));
  return { ...word, value: word.value.slice(by), refs, ...(cuts ? { cuts } : {}) };
}
