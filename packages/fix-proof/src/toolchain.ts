import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_BUILD = "pnpm build";
/** The vitest invocation; the runner appends the JSON reporter flags and the selected test paths. */
export const DEFAULT_COMMAND = "pnpm exec vitest run";

export interface Toolchain {
  /** Null when the tree has no lockfile this runner knows how to install from. */
  install: string | null;
  build: string;
  command: string;
}

const PNPM: Toolchain = { install: "pnpm install --frozen-lockfile", build: DEFAULT_BUILD, command: DEFAULT_COMMAND };

// First match wins, so a tree carrying both lockfiles keeps the pnpm behaviour it had before npm was supported.
const BY_LOCKFILE: readonly (readonly [string, Toolchain])[] = [
  ["pnpm-lock.yaml", PNPM],
  ["package-lock.json", { install: "npm ci --no-audit --no-fund", build: "npm run build --if-present", command: "npm exec --no -- vitest run" }],
];

/** The install, build and test defaults for a checked-out tree, chosen by the lockfile at its root. */
export function toolchainOf(tree: string): Toolchain {
  const match = BY_LOCKFILE.find(([lockfile]) => fs.existsSync(path.join(tree, lockfile)));
  return match?.[1] ?? { ...PNPM, install: null };
}
