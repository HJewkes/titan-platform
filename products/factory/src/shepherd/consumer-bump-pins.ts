import { parsePkgAndParentSelector } from "@pnpm/parse-overrides";
import type { RepoFile } from "@titan-design/github";
import { parse as parseYaml } from "yaml";

/** A package an override field forces to one spec; `name` is the target package, never a parent in a selector. */
export interface OverridePin {
  name: string;
  spec: string;
  field: string;
  /** The file that holds the override. */
  path: string;
  /** True when a parent selector limits the pin to that parent's dependency tree, so it never pins a direct dependency. */
  scoped: boolean;
  /** The version range a `name@range` selector limits the pin to; null when the selector names none. */
  range: string | null;
  /** True when the key names a titan package in a shape this reader cannot resolve (glob, yarn path); `name` is then the raw key. */
  unreadable: boolean;
}

const WORKSPACE_YAML_FIELD = "pnpm-workspace.yaml overrides";
const TITAN_SCOPE = "@titan-design/";
const TITAN_NAME = /^@titan-design\/[a-z0-9][a-z0-9._-]*$/;

export const record = (value: unknown): [string, unknown][] => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []);

interface Selector {
  name: string;
  scoped: boolean;
  range: string | null;
}

/** The target package of an override key, by pnpm's own selector grammar; a key it cannot parse is null. */
function parseSelector(key: string): Selector | null {
  try {
    const { targetPkg, parentPkg } = parsePkgAndParentSelector(key);
    return { name: targetPkg.name, scoped: parentPkg !== undefined, range: targetPkg.bareSpecifier ?? null };
  } catch {
    return null;
  }
}

function makePin(key: string, spec: unknown, field: string, path: string, inherited: boolean, selector: Selector | null): OverridePin[] {
  if (selector !== null && TITAN_NAME.test(selector.name)) {
    return typeof spec === "string" ? [{ name: selector.name, spec, field, path, scoped: selector.scoped || inherited, range: selector.range, unreadable: false }] : [];
  }
  const naming = selector === null || selector.name.startsWith(TITAN_SCOPE);
  return naming && key.includes(TITAN_SCOPE) ? [{ name: key, spec: typeof spec === "string" ? spec : "", field, path, scoped: false, range: null, unreadable: true }] : [];
}

function flatPins(value: unknown, field: string, path: string): OverridePin[] {
  return record(value).flatMap(([key, spec]) => makePin(key, spec, field, path, false, parseSelector(key)));
}

/** npm nests objects as parent scopes; a string value, or the "." key of a scope, pins that key's package. */
function npmPins(value: unknown, scope: Selector | null, path: string): OverridePin[] {
  return record(value).flatMap(([key, child]): OverridePin[] => {
    const selector = key === "." ? scope : parseSelector(key);
    // Inside a scope, a nested key names a package under that parent; only the scope's own "." entry keeps the scope's reach.
    const inherited = key === "." ? false : scope !== null;
    if (typeof child === "string") return makePin(key === "." ? (scope?.name ?? key) : key, child, "overrides", path, inherited, selector);
    if (key === ".") return [];
    const unreadable = selector !== null && TITAN_NAME.test(selector.name) ? [] : makePin(key, null, "overrides", path, false, selector);
    return [...unreadable, ...npmPins(child, selector !== null ? { ...selector, scoped: selector.scoped || scope !== null } : null, path)];
  });
}

/** Every override pin in a parsed `package.json`, from `pnpm.overrides`, npm `overrides` and `resolutions`. */
export function manifestPins(fields: ReadonlyMap<string, unknown>, path: string): OverridePin[] {
  const pnpm = record(fields.get("pnpm")).find(([key]) => key === "overrides")?.[1];
  return [...flatPins(pnpm, "pnpm.overrides", path), ...npmPins(fields.get("overrides"), null, path), ...flatPins(fields.get("resolutions"), "resolutions", path)];
}

/** Pins from pnpm-workspace.yaml `overrides`; they apply to every manifest in the workspace. */
export function workspacePins(workspaceYaml: RepoFile | null): OverridePin[] {
  if (workspaceYaml === null) return [];
  const root: unknown = parseYaml(workspaceYaml.content);
  const overrides = record(root).find(([key]) => key === "overrides")?.[1];
  return flatPins(overrides, WORKSPACE_YAML_FIELD, workspaceYaml.path);
}

const SPEC_VERSION = /^[\^~]?(\d+)\.(\d+)\.(\d+)$/;
const SELECTOR_RANGE = /^([\^~]?)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

type Triple = [number, number, number];

const compare = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The half-open `[lower, upper)` span of a caret, tilde or partial-version range. */
function rangeSpan(op: string, major: number, minor: number | null, patch: number | null): [Triple, Triple] {
  const lower: Triple = [major, minor ?? 0, patch ?? 0];
  const caretUpper: Triple = major > 0 ? [major + 1, 0, 0] : minor !== null && minor > 0 ? [0, minor + 1, 0] : patch !== null ? [0, 0, patch + 1] : [0, (minor ?? 0) + 1, 0];
  const partialUpper: Triple = minor === null ? [major + 1, 0, 0] : patch === null ? [major, minor + 1, 0] : [major, minor, patch + 1];
  const tildeUpper: Triple = minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0];
  return [lower, op === "^" ? caretUpper : op === "~" ? tildeUpper : partialUpper];
}

/**
 * Whether a pin reaches a direct dependency declared with `spec`. A parent-scoped pin never does; a `name@range`
 * selector does only when the dependency's own version sits in that range. A spec or range this reader cannot
 * compare counts as reached, so the dependency stays unbumped rather than being rewritten under a live pin.
 */
export function pinReaches(pin: Pick<OverridePin, "scoped" | "range" | "unreadable">, spec: string): boolean {
  if (pin.scoped || pin.unreadable) return false;
  if (pin.range === null) return true;
  const version = SPEC_VERSION.exec(spec);
  const range = SELECTOR_RANGE.exec(pin.range);
  if (version === null || range === null) return true;
  const current: Triple = [Number(version[1]), Number(version[2]), Number(version[3])];
  const optional = (part: string | undefined): number | null => (part === undefined ? null : Number(part));
  const [lower, upper] = rangeSpan(range[1] ?? "", Number(range[2]), optional(range[3]), optional(range[4]));
  return compare(current, lower) >= 0 && compare(current, upper) < 0;
}
