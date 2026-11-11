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
}

const WORKSPACE_YAML_FIELD = "pnpm-workspace.yaml overrides";

export const record = (value: unknown): [string, unknown][] => (value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : []);

/** The target package of an override key, by pnpm's own selector grammar; a key it cannot parse pins nothing. */
function targetName(key: string): string | null {
  try {
    return parsePkgAndParentSelector(key).targetPkg.name;
  } catch {
    return null;
  }
}

function flatPins(value: unknown, field: string, path: string): OverridePin[] {
  return record(value).flatMap(([key, spec]) => {
    const name = targetName(key);
    return name !== null && typeof spec === "string" ? [{ name, spec, field, path }] : [];
  });
}

/** npm nests objects as parent scopes; a string value, or the "." key of a scope, pins that key's package. */
function npmPins(value: unknown, scope: string | null, path: string): OverridePin[] {
  return record(value).flatMap(([key, child]): OverridePin[] => {
    const name = key === "." ? scope : targetName(key);
    if (name === null) return [];
    if (typeof child === "string") return [{ name, spec: child, field: "overrides", path }];
    return key === "." ? [] : npmPins(child, name, path);
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
