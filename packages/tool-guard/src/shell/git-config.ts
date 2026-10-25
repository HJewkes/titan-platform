import type { GitInvocation } from "./git.js";

/** What the command's own `-c` and `--config-env` overrides do to a push git routes through config. */
export interface PushConfig {
  /** Config that pushes every branch: a mirror remote, `push.default=matching`, or a glob or `:` push refspec. */
  all: boolean;
  /** Config whose effect the classifier cannot read: an environment value, an included file, a run-time key or value. */
  unknown: boolean;
  /** `remote.<r>.push` refspecs, which git maps a colon-less refspec or a push with none through. */
  specs: string[];
  /** `push.default` is `upstream` or `tracking`, which sends a branch to its `branch.<name>.merge`. */
  upstream: boolean;
  /** `branch.<name>.merge` values by branch name, the last one given winning. */
  merges: Map<string, string>;
}

interface ConfigKey {
  /** Section and variable, lower-cased as git reads them; the subsection keeps its case. */
  section: string;
  subsection: string | null;
  variable: string;
}

/** A run-time key may be any key; git keys are letters, digits and `-`, with `.`-separated parts. */
const PLAIN_KEY_RE = /^[A-Za-z0-9._-]+$/;
/** git's boolean parser reads these, and the empty string, as false; any other value turns `remote.<r>.mirror` on. */
const FALSE_RE = /^(?:false|no|off|0*)$/i;
const INERT_DEFAULTS = new Set(["current", "simple", "nothing"]);

function parseKey(key: string): ConfigKey | null {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first <= 0 || last === key.length - 1) return null;
  const section = key.slice(0, first).toLowerCase();
  const variable = key.slice(last + 1).toLowerCase();
  return { section, subsection: first === last ? null : key.slice(first + 1, last), variable };
}

function split(item: string): { key: string; value: string | null } {
  const eq = item.indexOf("=");
  return eq < 0 ? { key: item, value: null } : { key: item.slice(0, eq), value: item.slice(eq + 1) };
}

/** Whether a config key can change which branch a push lands on, or pull in config that can. */
export function isPushShapingKey(key: string): boolean {
  const k = parseKey(key);
  if (!k) return false;
  const sub = k.subsection !== null;
  if (k.section === "remote") return sub && (k.variable === "push" || k.variable === "mirror");
  if (k.section === "branch") return sub && k.variable === "merge";
  if (k.section === "push") return !sub && k.variable === "default";
  if (k.section === "include") return !sub && k.variable === "path";
  return k.section === "includeif" && sub && k.variable === "path";
}

/** A key the classifier cannot read in full may be a shaping one. */
const mayShape = (item: string) => {
  const { key } = split(item);
  return !PLAIN_KEY_RE.test(key) || isPushShapingKey(key);
};

/** Reads the push-shaping entries of the command's own config; `remote.<r>.pushDefault` and `branch.<name>.remote` pick a remote, not a branch. */
export function pushConfig(inv: GitInvocation): PushConfig {
  const config: PushConfig = { all: false, unknown: false, specs: [], upstream: false, merges: new Map() };
  for (const item of inv.config) readEntry(config, item);
  if (inv.configEnv.some(mayShape) || inv.configUnsure.some(mayShape)) config.unknown = true;
  return config;
}

function readEntry(config: PushConfig, item: string): void {
  const { key, value } = split(item);
  const k = parseKey(key);
  if (!k || !isPushShapingKey(key)) return;
  if (k.section === "include" || k.section === "includeif") config.unknown = true;
  else if (k.variable === "mirror") config.all ||= value === null || !FALSE_RE.test(value);
  else if (k.variable === "push") readPushSpec(config, value);
  else if (k.variable === "merge") readMerge(config, k.subsection as string, value);
  else readDefault(config, value);
}

function readPushSpec(config: PushConfig, value: string | null): void {
  if (!value) return;
  if (value.includes("*") || /^\+?:$/.test(value)) config.all = true;
  else config.specs.push(value);
}

function readMerge(config: PushConfig, branch: string, value: string | null): void {
  if (value) config.merges.set(branch, value);
}

/** `upstream` follows the last `push.default`, as git does; `matching` or a value this reader does not know, given anywhere, fails closed. */
function readDefault(config: PushConfig, value: string | null): void {
  config.upstream = value === "upstream" || value === "tracking";
  if (value === "matching") config.all = true;
  else if (!config.upstream && !INERT_DEFAULTS.has(value ?? "")) config.unknown = true;
}
