import { fileURLToPath } from "node:url";

/** src/ and the flat dist/ both sit two directories under the checkout, so this is the running build's own copy of the script. */
const CLOSURE_LOCK_SCRIPT = fileURLToPath(new URL("../../../scripts/closure-lock-merge.mjs", import.meta.url));

export interface GitConfigEntry {
  key: string;
  value: string;
}

const shellWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The config `scripts/closure-lock-merge.mjs --install` writes (TP-4745), with absolute paths: git runs a driver through sh
 * from wherever it was started, and a bare clone has no working tree for the script's relative path to resolve in.
 */
export const CLOSURE_LOCK_DRIVER: readonly GitConfigEntry[] = [
  { key: "merge.closure-lock.name", value: "closure.lock.json, merged per step" },
  { key: "merge.closure-lock.driver", value: `${shellWord(process.execPath)} ${shellWord(CLOSURE_LOCK_SCRIPT)} %O %A %B` },
];
