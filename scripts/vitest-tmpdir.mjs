// vitest globalSetup: every test run gets its own temp root, removed when the run ends on success or failure, so
// test mkdtemp calls that never clean up cannot pile up in a /tmp other agents share.
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"];
// Each project that extends the root config runs this setup; the first one owns the dir and the rest reuse it.
const OWNER_VAR = "TITAN_TEST_TMPDIR";
const PREFIX = "vt-titan-platform-";
const OWNED_NAME = new RegExp(`^${PREFIX}(\\d+)-`);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A run killed by SIGKILL, or by a signal after vitest dropped its handlers, never reaches its exit handler (TP-4570).
// The next run under the same base removes what a dead owner left; a dir another user owns is not ours to remove.
export function removeOrphanRunDirs(base, alive = isAlive) {
  for (const name of readdirSync(base)) {
    const pid = Number(OWNED_NAME.exec(name)?.[1]);
    const dir = path.join(base, name);
    if (!pid || alive(pid) || lstatSync(dir).uid !== process.getuid?.()) continue;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

export function createRunTmpdir(env = process.env, base = tmpdir()) {
  if (env[OWNER_VAR]) return () => {};
  removeOrphanRunDirs(base);
  const dir = mkdtempSync(path.join(base, `${PREFIX}${process.pid}-`));
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
