import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";

const HOME = "/home/you";
const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

const PUSH = "git push origin HEAD:main";
const WRITERS: Record<string, string> = { echo: `echo '${PUSH}'`, printf: `printf '%s' '${PUSH}'`, "a here-string": `cat <<< '${PUSH}'` };
const REDIRECTS = ["> f > g", "> f >&2", ">&2 > f", "> f >> g", ">| f > g", "1> f 2> g", "&> f", "> f 2>&1", "2> g > f", ">> f > g"];
const FILES = ["f", "g"];

/** Each shell runs with no startup files, so zsh's defaults, MULTIOS among them, are what it shows. */
const SHELLS: Record<string, { path: string | undefined; args: string[] }> = {
  bash: { path: ["/bin/bash", "/usr/bin/bash"].find(existsSync), args: ["--norc", "--noprofile", "-c"] },
  zsh: { path: ["/bin/zsh", "/usr/bin/zsh"].find(existsSync), args: ["-f", "-c"] },
};
const missing = Object.entries(SHELLS).flatMap(([name, s]) => (s.path ? [] : [name]));

/** The files each real shell writes the push into when it runs `line` in an empty directory. */
function filesWritten(line: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>(FILES.map((f) => [f, []]));
  for (const [name, { path, args }] of Object.entries(SHELLS)) {
    if (path === undefined) continue;
    const dir = mkdtempSync(join(tmpdir(), "tool-guard-redirect-corpus-"));
    try {
      spawnSync(path, [...args, line], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, encoding: "utf-8", timeout: 5000 });
      for (const file of FILES) {
        if (existsSync(join(dir, file)) && readFileSync(join(dir, file), "utf-8").includes(PUSH)) byFile.get(file)?.push(name);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return byFile;
}

/** One row per writer, redirect and file: the sourcing line, and the shells whose run leaves the push in that file. */
function corpus(): [string, string, string[]][] {
  return Object.entries(WRITERS).flatMap(([writer, command]) =>
    REDIRECTS.flatMap((redirect) =>
      [...filesWritten(`${command} ${redirect}`)].map(([file, shells]): [string, string, string[]] => [
        `${writer} ${redirect}, then . ./${file} (${shells.length > 0 ? `written by ${shells.join(" and ")}` : "written by neither"})`,
        `${command} ${redirect}; . ./${file}`,
        shells,
      ]),
    ),
  );
}

function bashEvent(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
}

const title = "stdout redirects, as bash and zsh actually write them";

if (missing.length > 0) {
  describe.skip(`${title} (skipped: ${missing.join(" and ")} not installed)`, () => {
    it("needs both shells", () => undefined);
  });
} else {
  describe(title, () => {
    it.each(corpus())("%s", async (_, command, shells) => {
      const result = await handle(bashEvent(command), {}, port);

      expect(result.stdout.includes('"permissionDecision":"deny"')).toBe(shells.length > 0);
    });
  });
}
