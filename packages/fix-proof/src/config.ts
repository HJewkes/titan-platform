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

export interface FixProofConfig {
  tests: string[];
  carry: string[];
  command?: string;
  build?: string;
}

export type ConfigResult = { ok: true; config: FixProofConfig } | { ok: false; error: string };

const KEYS = new Set(["tests", "carry", "command", "build"]);

function readGlobs(value: unknown, key: string, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || !value.every((glob) => typeof glob === "string" && glob !== "")) {
    throw new Error(`${key} must be an array of non-empty strings`);
  }
  value.forEach((glob: string) => expandBraces(glob));
  return [...value] as string[];
}

function readString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value === "") throw new Error(`${key} must be a non-empty string`);
  return value;
}

function readConfig(raw: unknown): FixProofConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("config must be a JSON object");
  const record = raw as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !KEYS.has(key));
  if (unknownKey !== undefined) throw new Error(`unknown config key: ${unknownKey}`);
  const config: FixProofConfig = {
    tests: readGlobs(record.tests, "tests", DEFAULT_TEST_GLOBS),
    carry: readGlobs(record.carry, "carry", DEFAULT_CARRY_GLOBS),
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
    return { ok: false, error: `${CONFIG_PATH}: ${(error as Error).message}` };
  }
}
