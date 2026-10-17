import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const APP = `${HOME}/app`;
const PUSH = "git push origin HEAD:main";

/** Benign scripts on disk, plus `evil.sh` and a `stash/` directory holding the push, which a copy or move brings to the name that runs. */
const files: Record<string, string> = {
  [`${APP}/real.sh`]: "echo hi\n",
  [`${APP}/a.sh`]: "echo a\n",
  [`${APP}/b.sh`]: "echo b\n",
  [`${APP}/dir/evil.sh`]: "echo benign\n",
  [`${APP}/dir/x.sh`]: "echo benign\n",
  [`${APP}/build.sh`]: "echo build\n",
  [`${APP}/config.example`]: "KEY=1\n",
  [`${APP}/old.log`]: "log\n",
  [`${APP}/disk-evil.sh`]: `${PUSH}\n`,
  [`${APP}/stash/x.sh`]: `${PUSH}\n`,
};
const dirs = new Set([`${APP}/dir`, `${APP}/stash`]);

const fs: ReadFs = {
  realpath: (p) => {
    if (p in files || dirs.has(p)) return p;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  },
  readHead: (p) => {
    const text = files[p];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  },
  isFile: (p) => p in files,
};
const port: HookPort = { context: nodeContext(HOME, fs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

function bash(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: APP, tool_input: { command } });
}

async function verdict(command: string): Promise<string | null> {
  const { stdout } = await handle(bash(command), {}, port);
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

const WRITE_EVIL = `echo ${PUSH} > evil.sh`;

const denyRows: [string, string][] = [
  ["tee then bash", `echo ${PUSH} | tee real.sh; bash real.sh`],
  ["tee -a then bash", `echo ${PUSH} | tee -a real.sh; bash real.sh`],
  ["tee then a by-path run", `echo ${PUSH} | tee real.sh; ./real.sh`],
  ["cp of a file the line wrote", `${WRITE_EVIL}; cp evil.sh real.sh; bash real.sh`],
  ["cp of a file printf wrote, whose text the model does not follow", `printf '${PUSH}\\n' > evil.sh; cp evil.sh real.sh; bash real.sh`],
  ["cp of a file the disk holds", `cp disk-evil.sh real.sh; bash real.sh`],
  ["mv then sh", `${WRITE_EVIL}; mv evil.sh real.sh && sh real.sh`],
  ["install", `${WRITE_EVIL}; install -m 755 evil.sh real.sh; bash real.sh`],
  ["dd", `${WRITE_EVIL}; dd if=evil.sh of=real.sh; bash real.sh`],
  ["ln -sf", `${WRITE_EVIL}; ln -sf evil.sh real.sh; bash real.sh`],
  ["ln", `${WRITE_EVIL}; ln -f evil.sh real.sh; bash real.sh`],
  ["cp into a directory", `${WRITE_EVIL}; cp evil.sh dir/; bash dir/evil.sh`],
  ["cp into a directory spelled without a slash", `${WRITE_EVIL}; cp evil.sh dir; bash dir/evil.sh`],
  ["cp -t", `${WRITE_EVIL}; cp -t dir evil.sh; bash dir/evil.sh`],
  ["cp --target-directory=", `${WRITE_EVIL}; cp --target-directory=dir evil.sh; bash dir/evil.sh`],
  ["cp of several files into a directory", `${WRITE_EVIL}; cp a.sh evil.sh dir; bash dir/evil.sh`],
  ["cp to a dynamic target", `${WRITE_EVIL}; cp evil.sh "$D"; bash real.sh`],
  ["cp of a directory tree", `cp -r stash dir; bash dir/x.sh`],
  ["mv of a directory tree", `mv stash dir; bash dir/x.sh`],
  ["cp of a dynamic source", `cp "$S" real.sh; bash real.sh`],
  ["cp after a clustered option", `${WRITE_EVIL}; cp -pt dir evil.sh; bash dir/evil.sh`],
  ["a copy of a copy", `${WRITE_EVIL}; cp evil.sh b.sh; cp b.sh real.sh; bash real.sh`],
];

const passRows: [string, string][] = [
  ["cp of benign files", `cp a.sh b.sh; bash b.sh`],
  ["tee to a log, then another script", `tee log.txt < out; bash build.sh`],
  ["cp of a config, then another script", `cp config.example config; bash build.sh`],
  ["mv of a log, then another script", `mv old.log new.log && bash build.sh`],
  ["tee -a to a log", `echo ok | tee -a log.txt`],
  ["cp -r with no later run", `cp -r src dst`],
  ["cp of a missing file", `cp missing.sh real.sh; bash real.sh`],
  ["install -d", `install -d out; bash real.sh`],
];

describe("a script the line writes by name and then runs", () => {
  it.each(denyRows)("denies %s", async (_, command) => {
    expect(await verdict(command)).toBe("deny");
  });

  it.each(passRows)("passes %s", async (_, command) => {
    expect(await verdict(command)).toBeNull();
  });
});

describe("a writer behind a wrapper", () => {
  it.each(["command", "env", "sudo", "nice"])("denies %s cp then bash", async (wrapper) => {
    expect(await verdict(`${WRITE_EVIL}; ${wrapper} cp evil.sh real.sh; bash real.sh`)).toBe("deny");
  });
});
