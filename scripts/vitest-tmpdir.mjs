// vitest globalSetup: every test run gets its own temp root, removed when the run ends on success or failure, so
// test mkdtemp calls that never clean up cannot pile up in a /tmp other agents share.
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const TEMP_VARS = ["TMPDIR", "TMP", "TEMP"];
// Each project that extends the root config runs this setup; the first one owns the dir and the rest reuse it.
const OWNER_VAR = "TITAN_TEST_TMPDIR";
const PREFIX = "vt-titan-platform-";
const OWNED_NAME = new RegExp(`^${PREFIX}(\\d+)-`);
// Each operator-state root, relative to the run's empty home. Assigned, not defaulted: agent-chat exports several of
// these into every agent it spawns, so a test run by an agent otherwise read the live event log (TP-4603). HOME is here
// because most readers fall back to os.homedir(), and a thread only sees a HOME set before the pool starts.
const STATE_ROOTS = {
  HOME: ".",
  USERPROFILE: ".",
  AGENT_CHAT_HOME: ".agent-chat",
  ACTIVE_ROOT: "active-work",
  CLAUDE_CONFIG_DIR: ".claude",
  CODEX_HOME: ".codex",
  XDG_CONFIG_HOME: ".config",
  XDG_DATA_HOME: ".local/share",
  XDG_STATE_HOME: ".local/state",
};
// Overrides that would point past that home. Unset, each falls back to a default under it.
const STATE_OVERRIDES = [
  "AGENT_CHAT_INBOX_SPOOL",
  "AUTONOMY_ROOT",
  "CLAUDE_CONFIG_DIRS",
  "CLAUDE_PROFILE_ROOT",
  "CLAUDE_PROJECTS_ROOT",
  "CLAUDE_TRANSCRIPT_MIRRORS",
  "TITAN_CONSOLE_AGENT_CHAT_TOKEN",
  "TITAN_CONSOLE_AUTONOMY_DIR",
  "TITAN_CONSOLE_CLAUDE_DIRS",
  "TITAN_CONSOLE_COORDINATOR_FILE",
  "TITAN_CONSOLE_DECISIONS_FILE",
  "TITAN_CONSOLE_EVENTS_DB",
  "TITAN_CONSOLE_FACTORY_CONFIG",
  "TITAN_CONSOLE_INBOX_DIR",
  "TITAN_CONSOLE_REVIEWS_DIR",
  "TITAN_CONSOLE_ROUNDS_DIR",
  "TITAN_CONSOLE_SESSION_GRAPH",
  "TITAN_CONSOLE_STATE",
  "TITAN_FACTORY_CONFIG",
  "TITAN_FACTORY_DB",
  "TITAN_MINER_BROKER_LOG",
  "TITAN_MINER_CODEX_HOME",
  "TITAN_MINER_CORPUS",
  "TITAN_MINER_EVENTS_DB",
  "TITAN_MINER_GRAPH",
  "TITAN_MINER_INITIATIVES_ROOT",
  "TITAN_MINER_STATE",
  "TITAN_TOOL_GUARD_LOG",
  "TITAN_YT_SCOUT_CONFIG",
  "TITAN_YT_SCOUT_DB",
];
// Downloaded tools, not operator state: moving them with HOME would refetch browsers and package managers in every run.
const TOOL_CACHES = {
  COREPACK_HOME: ".cache/node/corepack",
  NPM_CONFIG_CACHE: ".npm",
  PLAYWRIGHT_BROWSERS_PATH: process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright",
  XDG_CACHE_HOME: ".cache",
};
// A run that means to read the machine it is on, such as a local smoke over real transcripts, says so with this.
const HOST_STATE_OPT_IN = "TITAN_TEST_HOST_STATE";
const ISOLATION_VARS = [...Object.keys(STATE_ROOTS), ...STATE_OVERRIDES, ...Object.keys(TOOL_CACHES)];

function isolateHostState(env, dir) {
  const stateHome = path.join(dir, "host-state");
  mkdirSync(stateHome);
  const realHome = env.HOME || homedir();
  for (const [name, relative] of Object.entries(TOOL_CACHES)) env[name] ||= path.join(realHome, relative);
  for (const [name, relative] of Object.entries(STATE_ROOTS)) env[name] = path.resolve(stateHome, relative);
  for (const name of STATE_OVERRIDES) delete env[name];
}

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
  const saved = Object.fromEntries([OWNER_VAR, ...TEMP_VARS, ...ISOLATION_VARS].map((name) => [name, env[name]]));
  env[OWNER_VAR] = dir;
  for (const name of TEMP_VARS) env[name] = dir;
  if (!env[HOST_STATE_OPT_IN]) isolateHostState(env, dir);
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
