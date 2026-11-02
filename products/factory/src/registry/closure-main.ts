import { readFileSync } from "node:fs";
import { checkClosures, computeLock } from "./closure.js";
import { factoryRegistry } from "./steps/index.js";

/**
 * What scripts/step-closure-check.mjs runs, built by tsup so the script needs no TypeScript loader. `--print` writes
 * the computed lock; otherwise stdin carries `{ base, committed, attestations }` and stdout gets the check's result.
 */
const [root = process.cwd(), mode] = process.argv.slice(2);
const computed = computeLock(root, factoryRegistry);
const result = mode === "--print" ? computed : checkClosures({ ...JSON.parse(readFileSync(0, "utf8")), computed });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
