import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeContext } from "./context.js";
import type { ReadFs } from "./context.js";
import { decide } from "./decide.js";
import { handle } from "./hook.js";
import type { HookPort } from "./hook.js";
import { REDIRECT_OPS } from "./line-writes.js";
import { ParseError, tokenize } from "./shell/lexer.js";

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

/** Every redirect spelling of bash(1) REDIRECTION and zshmisc(1) REDIRECTION, as fd prefix × operator × spacing. */
const PREFIXES = ["", "1", "2", "3", "11", "{fd}"];
const OPS = [">", ">|", ">!", ">>", ">>|", ">>!", "&>", "&>|", "&>!", "&>>", "&>>|", "&>>!", ">&", ">&|", ">&!", ">>&", ">>&|", ">>&!", "<>", "<&", "<"];
const SPACINGS = [" f", "f"];
const COMPOSITIONS = ["> f > g", "> f >&2", ">&2 > f", "9> f 1>&9", "> f 1>&-", "> g | cat > f"];
const MANUAL_SPELLINGS = [...PREFIXES.flatMap((p) => OPS.flatMap((op) => SPACINGS.map((s) => `${p}${op}${s}`))), ...COMPOSITIONS];

/** The text before the sourcing line, for a redirect spelling; `other` holds the push, so `cat other` writes it unmodelled. */
const WRITERS: Record<string, (form: string) => string> = {
  echo: (form) => `echo '${PUSH}' ${form}`,
  printf: (form) => `printf '%s' '${PUSH}' ${form}`,
  "a here-string": (form) => `cat <<< '${PUSH}' ${form}`,
  "a heredoc": (form) => `cat <<'E' ${form}\n${PUSH}\nE`,
  "a tab-stripped heredoc": (form) => `cat <<-'E' ${form}\n\t${PUSH}\n\tE`,
  "zsh print": (form) => `print -r -- '${PUSH}' ${form}`,
  "a NULLCMD here-string": (form) => `<<< '${PUSH}' ${form}`,
  "cat of another file": (form) => `cat other ${form}`,
};
/** Writers whose text the guard reproduces; the others are only ever followed as untracked. */
const MODELLED = new Set(["echo", "printf", "a here-string", "a heredoc", "a tab-stripped heredoc"]);
/** Spellings the model claims to read exactly, so a deny there with no shell writing the push is a false deny. */
const EXACT = new Set([
  ...["", "1"].flatMap((p) => [">", ">|", ">>", ">&"].flatMap((op) => SPACINGS.map((s) => `${p}${op}${s}`))),
  ...["&>", "&>>"].flatMap((op) => SPACINGS.map((s) => `${op}${s}`)),
  ...PREFIXES.flatMap((p) => SPACINGS.map((s) => `${p}<${s}`)),
  "> f > g",
  "> f >&2",
  ">&2 > f",
]);
const FILES = ["f", "g"];

/** Each shell runs with no startup files, so zsh's defaults, MULTIOS among them, are what it shows. */
const SHELLS: Record<string, { path: string | undefined; args: string[] }> = {
  bash: { path: ["/bin/bash", "/usr/bin/bash"].find(existsSync), args: ["--norc", "--noprofile"] },
  zsh: { path: ["/bin/zsh", "/usr/bin/zsh"].find(existsSync), args: ["-f"] },
};
const missing = Object.entries(SHELLS).flatMap(([name, s]) => (s.path ? [] : [name]));

interface Row {
  writer: string;
  form: string;
  line: string;
}

const rows: Row[] = Object.entries(WRITERS).flatMap(([writer, line]) => MANUAL_SPELLINGS.map((form) => ({ writer, form, line: line(form) })));

const work = mkdtempSync(join(tmpdir(), "tool-guard-redirect-corpus-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Runs every row under one shell, each in its own empty directory, in one process; a row's syntax error stays in its subshell. */
function runAll(shell: string, path: string, args: string[]): void {
  const driver = rows.map((_, i) => `(cd ${shell}/d${i} && eval "$(<../../r${i})") </dev/null >/dev/null 2>&1`).join("\n");
  rows.forEach((_, i) => {
    mkdirSync(join(work, shell, `d${i}`), { recursive: true });
    writeFileSync(join(work, shell, `d${i}`, "other"), `${PUSH}\n`);
  });
  writeFileSync(join(work, `${shell}.sh`), `${driver}\n`);
  const run = spawnSync(path, [...args, join(work, `${shell}.sh`)], { cwd: work, env: { PATH: process.env.PATH ?? "" }, timeout: 120_000 });
  if (run.error) throw run.error;
}

/** For each row and file, the shells that left the push in that file. */
function shellResults(): string[][][] {
  rows.forEach((row, i) => writeFileSync(join(work, `r${i}`), row.line));
  for (const [name, { path, args }] of Object.entries(SHELLS)) if (path !== undefined) runAll(name, path, args);
  return rows.map((_, i) => FILES.map((file) => Object.keys(SHELLS).filter((shell) => holdsPush(join(work, shell, `d${i}`, file)))));
}

/** The push as a command, so text glued onto it (`HEAD:main{fd}`, a push to another branch) does not count. */
const PUSH_RE = /git push origin HEAD:main(\s|$)/;

function holdsPush(path: string): boolean {
  return existsSync(path) && PUSH_RE.test(readFileSync(path, "utf-8"));
}

function corpus(): [string, string, string[], boolean][] {
  const results = shellResults();
  return rows.flatMap((row, i) =>
    FILES.map((file, j): [string, string, string[], boolean] => {
      const shells = results[i]?.[j] ?? [];
      const by = shells.length > 0 ? `written by ${shells.join(" and ")}` : "written by neither";
      return [`${row.writer} ${JSON.stringify(row.form)}, then . ./${file} (${by})`, `${row.line}\n. ./${file}`, shells, MODELLED.has(row.writer) && EXACT.has(row.form)];
    }),
  );
}

function bashEvent(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
}

/** The redirect ops the lexer reads in `line`; a line it refuses to parse is denied whole, so it adds none. */
function lexedOps(line: string): string[] {
  try {
    return tokenize(line).flatMap((t) => (t.type === "redirect" ? [t.op] : []));
  } catch (error) {
    if (error instanceof ParseError) return [];
    throw error;
  }
}

describe("the redirect table and corpus", () => {
  it("the table names every op the lexer emits", () => {
    const lexed = new Set(MANUAL_SPELLINGS.flatMap((form) => lexedOps(`echo P ${form}`)));

    expect([...lexed].filter((op) => !REDIRECT_OPS.has(op))).toEqual([]);
  });

  it("the corpus exercises every op in the table", () => {
    const lexed = new Set(rows.flatMap((row) => lexedOps(row.line)));

    expect([...REDIRECT_OPS].filter((op) => !lexed.has(op))).toEqual([]);
  });

  it("fails on CI without bash and zsh", () => {
    if (process.env.CI) expect(missing, "bash and zsh must be installed on CI").toEqual([]);
  });
});

const title = "every redirect spelling bash and zsh document, against the guard";

if (missing.length > 0) {
  describe.skip(`${title} (skipped: ${missing.join(" and ")} not installed)`, () => {
    it("needs both shells", () => undefined);
  });
} else {
  describe(title, () => {
    it.each(corpus())("%s", async (_, command, shells, exact) => {
      const denied = (await handle(bashEvent(command), {}, port)).stdout.includes('"permissionDecision":"deny"');

      if (shells.length > 0) expect(denied).toBe(true);
      if (exact) expect(denied).toBe(shells.length > 0);
    });
  });
}
