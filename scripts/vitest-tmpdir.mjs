// vitest globalSetup: every test run gets its own temp root, removed when the run ends on success or failure, so
// test mkdtemp calls that never clean up cannot pile up in a /tmp other agents share.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"];
// Each project that extends the root config runs this setup; the first one owns the dir and the rest reuse it.
const OWNER_VAR = "TITAN_TEST_TMPDIR";

export function createRunTmpdir(env = process.env, base = tmpdir()) {
  if (env[OWNER_VAR]) return () => {};
  const dir = mkdtempSync(path.join(base, "vt-titan-platform-"));
  const saved = Object.fromEntries([OWNER_VAR, ...TEMP_VARS].map((name) => [name, env[name]]));
  env[OWNER_VAR] = dir;
  for (const name of TEMP_VARS) env[name] = dir;
  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    process.off("exit", remove);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
  };
  // A run that throws past vitest's teardown still exits through here.
  process.on("exit", remove);
  return remove;
}

export default function setup() {
  return createRunTmpdir();
}
