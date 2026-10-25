import { compileGlobs } from "@titan-design/fix-proof";
import { resolveConfig, type BurdenConfig, type ChangedFile, type PackageJsonChange } from "./config.js";
import type { Door } from "./footer.js";
import { removedSurface } from "./package-json.js";

export type ChangesetBump = "major" | "minor" | "patch";

export type OneWayFactKind = "migration" | "major-changeset" | "authority-path" | "package-key-removed" | "stored-data-deleted";

/** One reason a revert would not restore the old behaviour; `path` and `detail` name what to look at. */
export interface OneWayFact {
  kind: OneWayFactKind;
  path?: string;
  detail?: string;
}

export interface DoorInput {
  files: readonly ChangedFile[];
  /** Every bump the PR's changesets declare, one entry per package line. */
  changesetBumps?: readonly ChangesetBump[];
  packageJsons?: readonly PackageJsonChange[];
  config?: Partial<BurdenConfig>;
}

export interface DoorFacts {
  door: Door;
  facts: OneWayFact[];
}

/** The computed door: one-way when any fact holds, each fact listed in a fixed order. */
export function doorFacts(input: DoorInput): DoorFacts {
  const config = resolveConfig(input.config);
  const facts = [
    ...pathFacts(input.files, config.migrationGlobs, "migration"),
    ...majorFacts(input.changesetBumps ?? []),
    ...pathFacts(input.files, config.protectedPaths, "authority-path"),
    ...(input.packageJsons ?? []).flatMap(surfaceFacts),
    ...storedDataFacts(input.files, config.storedDataGlobs),
  ];
  return { door: facts.length > 0 ? "one-way" : "two-way", facts };
}

/** The stricter of the declared and computed doors; a missing declaration defers to the facts. */
export function effectiveDoor(declared: Door | undefined, computed: Door): Door {
  return declared === "one-way" || computed === "one-way" ? "one-way" : "two-way";
}

/** True when the author declared two-way and a fact makes the PR one-way. */
export function underDeclared(declared: Door | undefined, computed: Door): boolean {
  return declared === "two-way" && computed === "one-way";
}

// A rename moves the base path away too, so both sides of it are checked.
function pathsOf(file: ChangedFile): string[] {
  return file.previousPath && file.previousPath !== file.path ? [file.path, file.previousPath] : [file.path];
}

function pathFacts(files: readonly ChangedFile[], globs: readonly string[], kind: OneWayFactKind): OneWayFact[] {
  const matches = compileGlobs(globs);
  const hits = files.flatMap(pathsOf).filter(matches);
  return [...new Set(hits)].map((path) => ({ kind, path }));
}

function majorFacts(bumps: readonly ChangesetBump[]): OneWayFact[] {
  return bumps.includes("major") ? [{ kind: "major-changeset" }] : [];
}

function surfaceFacts(change: PackageJsonChange): OneWayFact[] {
  return removedSurface(change).map(({ key, value }) => ({ kind: "package-key-removed", path: change.path, detail: `${key} ${value}` }));
}

function storedDataFacts(files: readonly ChangedFile[], globs: readonly string[]): OneWayFact[] {
  const matches = compileGlobs(globs);
  const gone = files.flatMap((file) => (file.status === "removed" ? [file.path] : file.status === "renamed" && file.previousPath ? [file.previousPath] : []));
  return gone.filter(matches).map((path) => ({ kind: "stored-data-deleted", path }));
}
