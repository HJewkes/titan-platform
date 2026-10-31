import { expandBraces } from "./glob.js";

/** Where a target repo keeps its fix-proof config; read at the merge base, never at head. */
export const CONFIG_PATH = ".github/fix-proof.json";
export const DEFAULT_TEST_GLOBS: readonly string[] = ["**/*.{test,spec}.{ts,tsx,mts,js,mjs}"];
export const DEFAULT_CARRY_GLOBS: readonly string[] = [
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/test-support/**",
  "**/testdata/**",
];

/**
 * Mutation specs sit next to their test as `<test file minus extension>.mutations.json`. A fixed glob, not a config key:
 * the config parser refuses unknown keys, so a key would fail every run whose merge base predates it. A new key needs
 * this parser on main before any config uses it; CI builds the parser from the merge-base tree, so ordering on main is
 * enough.
 */
export const MUTATION_SPEC_GLOB = "**/*.mutations.json";
export const CHANGESET_GLOB = ".changeset/*.md";
/**
 * On `pull_request` the PR merge ref supplies the workflow file and the run script, so a PR touching any of these
 * chose the code that printed its own result line. Each entry is a path prefix.
 */
export const FIX_PROOF_HARNESS: readonly string[] = [
  ".github/workflows/",
  ".github/actions/",
  CONFIG_PATH,
  "scripts/fix-proof-run.sh",
];

export function isHarnessPath(path: string): boolean {
  return FIX_PROOF_HARNESS.some((prefix) => path.startsWith(prefix));
}

export interface FixProofConfig {
  tests: string[];
  carry: string[];
  /**
   * Carry or test paths that ship or run in production, such as published fixtures. Never test-only: they read as
   * source, yet stay carried so the fix-proof overlay is unchanged.
   */
  runtime: string[];
  command?: string;
  build?: string;
}

export type ConfigResult = { ok: true; config: FixProofConfig } | { ok: false; error: string };

const KEYS = new Set(["tests", "carry", "runtime", "command", "build"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGlobList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((glob) => typeof glob === "string" && glob !== "");
}

function readGlobs(value: unknown, key: string, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!isGlobList(value)) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  value.forEach((glob) => expandBraces(glob));
  return [...value];
}

function readString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

function readConfig(raw: unknown): FixProofConfig {
  if (!isRecord(raw)) throw new Error("config must be a JSON object");
  const record = raw;
  const unknownKey = Object.keys(record).find((key) => !KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`unknown config key: ${unknownKey}`);
  const config: FixProofConfig = {
    tests: readGlobs(record.tests, "tests", DEFAULT_TEST_GLOBS),
    carry: readGlobs(record.carry, "carry", DEFAULT_CARRY_GLOBS),
    runtime: readGlobs(record.runtime, "runtime", []),
  };
  const command = readString(record.command, "command");
  const build = readString(record.build, "build");
  if (command !== undefined) config.command = command;
  if (build !== undefined) config.build = build;
  return config;
}

/** Parses the config text found at the merge base; absent text gives the defaults. */
export function parseFixProofConfig(text: string | null | undefined): ConfigResult {
  if (text === null || text === undefined) return { ok: true, config: readConfig({}) };
  try {
    return { ok: true, config: readConfig(JSON.parse(text)) };
  } catch (error) {
    return { ok: false, error: `${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
