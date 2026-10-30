import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(path.join(tmpdir(), "new-package-cleanup-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A child process, because vitest does not support running inside one of its own thread workers. Naming the scratch
// dir as the run's own temp root stops vitest-tmpdir.mjs from redirecting and then removing it, which would hide leaks.
it("leaves no new-package scratch roots behind once its test file finishes", async () => {
  const env = { ...process.env, CI: "1", NO_COLOR: "1", TMPDIR: scratch, TMP: scratch, TEMP: scratch, TITAN_TEST_TMPDIR: scratch };

  await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "scripts/new-package.test.mjs"], { cwd: root, env });

  expect(readdirSync(scratch).filter((name) => name.startsWith("new-package-"))).toEqual([]);
}, 120_000);
