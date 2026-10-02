import { parse } from "yaml";

export const FACTORY_PACKAGE = "@titan-design/factory";
/** Root files every workspace build reads; a lockfile change for an unrelated package over-triggers, which a drain makes harmless. */
export const ROOT_BUILD_INPUTS: readonly string[] = ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", ".npmrc"];
const ROOT_TSCONFIG = /^tsconfig[^/]*\.json$/;
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
/** Stands in for the changed paths when git could not list them, so an unknown diff deploys. */
export const UNKNOWN_DIFF = "<unknown diff>";

export interface WorkspacePackage {
  /** Relative to the checkout root, with forward slashes. */
  dir: string;
  name: string;
  deps: readonly string[];
}

/** What the closure reads from a checkout; paths are relative to its root. */
export interface WorkspaceReader {
  readFile: (path: string) => string | undefined;
  /** The names of the directories directly inside `dir`, or none when it is missing. */
  listDirs: (dir: string) => readonly string[];
}

/** The directories `pnpm-workspace.yaml` names; only literal paths and a trailing `/*` occur in this repo. */
export function workspaceDirs(workspaceYaml: string, listDirs: WorkspaceReader["listDirs"]): string[] {
  const globs = (parse(workspaceYaml) as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(globs)) return [];
  return globs.flatMap((glob) => {
    if (typeof glob !== "string" || glob.startsWith("!")) return [];
    if (!glob.endsWith("/*")) return [glob];
    const parent = glob.slice(0, -2);
    return listDirs(parent).map((name) => `${parent}/${name}`);
  });
}

export function readWorkspace(reader: WorkspaceReader): WorkspacePackage[] {
  const yaml = reader.readFile("pnpm-workspace.yaml");
  if (yaml === undefined) return [];
  return workspaceDirs(yaml, reader.listDirs).flatMap((dir) => {
    const text = reader.readFile(`${dir}/package.json`);
    if (text === undefined) return [];
    const manifest = JSON.parse(text) as Record<string, unknown>;
    if (typeof manifest.name !== "string") return [];
    const deps = DEP_FIELDS.flatMap((field) => Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}));
    return [{ dir, name: manifest.name, deps }];
  });
}

/** The package dirs `pnpm --filter "<root>..."` selects: the root and every workspace package it reaches by dependency. */
export function closureDirs(packages: readonly WorkspacePackage[], root: string = FACTORY_PACKAGE): string[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const seen = new Set<string>();
  const visit = (name: string): void => {
    const pkg = byName.get(name);
    if (pkg === undefined || seen.has(name)) return;
    seen.add(name);
    pkg.deps.forEach(visit);
  };
  visit(root);
  return [...seen].map((name) => byName.get(name)!.dir).sort();
}

function isRootInput(path: string): boolean {
  return ROOT_BUILD_INPUTS.includes(path) || ROOT_TSCONFIG.test(path);
}

/** The changed paths a factory build reads; `undefined` means git could not list them, which counts as touched. */
export function touchedPaths(changed: readonly string[] | undefined, closure: readonly string[]): string[] {
  if (changed === undefined) return [UNKNOWN_DIFF];
  return changed.filter((path) => isRootInput(path) || closure.some((dir) => path.startsWith(`${dir}/`)));
}
