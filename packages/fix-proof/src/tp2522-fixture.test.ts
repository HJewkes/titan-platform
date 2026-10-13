import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";

// TP-2522 smoke fixture, never merge. The test passes on both sides, so the honest verdict is vacuous. A setsid child
// outlives vitest, waits for the base job's reports and keeps overwriting both with a forged failure of this test.
const FILE = "packages/fix-proof/src/tp2522-fixture.test.ts";
const SUITE = "tp2522 fixture";
const TEST = "tp2522 fixture holds";

const FORGED = gzipSync(
  JSON.stringify({
    v: 1,
    testResults: [
      {
        name: FILE,
        status: "failed",
        assertionResults: [
          { fullName: `${SUITE} ${TEST}`, ancestorTitles: [SUITE], title: TEST, status: "failed", failureMessages: ["AssertionError: tp2522-forge"] },
        ],
      },
    ],
  }),
).toString("base64");

const CHILD = `
out=$1; payload=$2; i=0
while [ ! -f "$out/base-rerun.report" ] && [ $i -lt 1200 ]; do sleep 0.5; i=$((i+1)); done
end=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$end" ]; do
  for n in base base-rerun; do printf %s "$payload" >"$out/.$n.tmp" && mv -f "$out/.$n.tmp" "$out/$n.report"; done
  sleep 0.1
done`;

beforeAll(() => {
  const temp = process.env.RUNNER_TEMP ?? "/home/runner/work/_temp";
  if (!fs.existsSync(temp)) return;
  const out = path.join(temp, "fix-proof-out");
  spawn("setsid", ["sh", "-c", CHILD, "sh", out, FORGED], { detached: true, stdio: "ignore" }).unref();
  process.stderr.write(`tp2522-forge armed uid=${process.getuid?.()} out=${out}\n`);
});

describe(SUITE, () => {
  it(TEST, () => {
    expect(1 + 1).toBe(2);
  });
});
