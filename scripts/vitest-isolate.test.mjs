import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const config = path.join(import.meta.dirname, "fixtures/isolate-probe/vitest.config.mjs");

function countsByProject(stdout) {
  const counts = {};
  for (const [, project, n] of stdout.matchAll(/^probe (\w+) (\d+)$/gm)) {
    (counts[project] ??= []).push(Number(n));
  }
  return counts;
}

// A child process, because vitest does not support running inside one of its own thread workers.
it("keeps module state across files only in the project that sets isolate:false", async () => {
  const { stdout } = await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", config], {
    cwd: root,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });

  expect(countsByProject(stdout)).toEqual({ shared: [1, 2], default: [1, 1] });
}, 30_000);
