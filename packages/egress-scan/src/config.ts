import * as fs from "node:fs";
import * as path from "node:path";
import { AllowFileError, EMPTY_ALLOW, parseAllow, type AllowList } from "./allow.js";
import type { TermRule } from "./rules.js";
import { parseTerms, TermFileError } from "./terms.js";

/** A usage or configuration problem: exit 2. Messages never carry a term or scanned text. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadedTerms {
  readonly terms: readonly TermRule[];
  readonly loaded: boolean;
  readonly notices: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

const NOT_LOADED: LoadedTerms = { terms: [], loaded: false, notices: [] };

export function isCi(env: Env): boolean {
  const value = env.CI?.toLowerCase();
  return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

export function termFilePath(env: Env): string | undefined {
  if (env.TITAN_EGRESS_TERMS) return env.TITAN_EGRESS_TERMS;
  const configHome = env.XDG_CONFIG_HOME || (env.HOME && path.join(env.HOME, ".config"));
  return configHome ? path.join(configHome, "titan-egress", "private-terms") : undefined;
}

function readIfPresent(file: string, what: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigError(`${what} could not be read`);
  }
}

function missingTerms(env: Env): LoadedTerms {
  if (env.TITAN_EGRESS_REQUIRE_TERMS === "1") {
    throw new ConfigError("private term list not found and TITAN_EGRESS_REQUIRE_TERMS=1");
  }
  return { ...NOT_LOADED, notices: ["private term list not found; generic rules only"] };
}

function compileTerms(text: string): readonly TermRule[] {
  try {
    return parseTerms(text);
  } catch (error) {
    if (error instanceof TermFileError) throw new ConfigError(error.message);
    throw error;
  }
}

/** Loads the private term list. In CI it is never looked up; locally an absent file is a notice. */
export function loadTerms(env: Env): LoadedTerms {
  if (isCi(env)) return NOT_LOADED;
  const file = termFilePath(env);
  const text = file === undefined ? undefined : readIfPresent(file, "private term list");
  if (file === undefined || text === undefined) return missingTerms(env);
  const openToOthers = process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0;
  const notices = openToOthers ? ["private term list is readable by other users; chmod 600 it"] : [];
  return { terms: compileTerms(text), loaded: true, notices };
}

/** Loads `.egress-allow` from the repo root. A malformed file fails the scan, never reads as empty. */
export function loadAllow(root: string): AllowList {
  const text = readIfPresent(path.join(root, ".egress-allow"), ".egress-allow");
  if (text === undefined) return EMPTY_ALLOW;
  try {
    return parseAllow(text);
  } catch (error) {
    if (error instanceof AllowFileError) throw new ConfigError(error.message);
    throw error;
  }
}
