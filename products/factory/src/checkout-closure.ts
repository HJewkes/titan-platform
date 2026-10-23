import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closureDirs, readWorkspace } from "./deploy-closure.js";

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
  } catch {
    return [];
  }
}

/** The factory build's package dirs in the checkout at `root`, as the deployer reads them; undefined when they cannot be read, so callers count every path. */
export function checkoutClosure(root: string): string[] | undefined {
  try {
    const dirs = closureDirs(readWorkspace({ readFile: (path) => readIfPresent(join(root, path)), listDirs: (dir) => listDirs(join(root, dir)) }));
    return dirs.length === 0 ? undefined : dirs;
  } catch {
    return undefined;
  }
}

/** The closure of the checkout this build runs from; serve cannot import cli-service's ownCheckout, which imports serve. */
export const ownClosure = (): string[] | undefined => checkoutClosure(fileURLToPath(new URL("../../../", import.meta.url)));
