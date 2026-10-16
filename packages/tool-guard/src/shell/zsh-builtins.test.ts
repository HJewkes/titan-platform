import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { writesProtectedParam } from "./hooked-params.js";
import { tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

/**
 * The 152 builtins of zsh 5.9 with every module of its `$module_path` loaded. The live comparison skips loading
 * `zsh/example`, whose `example` builtin is a demo that stores nowhere. A writer stores into
 * a parameter its operand or an option value names, and maps to a command that stores into `options`. A
 * non-writer stores into no parameter it is told to name: it stores nowhere, only into fixed parameters such as
 * REPLY, into name-keyed tables other readers own (`alias`, `hash`, `functions`), or into math, which the
 * arithmetic half of the reader covers. A builtin in neither list fails the closure row.
 */
const WRITERS: Record<string, string> = {
  declare: "declare options",
  export: "export options",
  float: "float options",
  integer: "integer options",
  local: "local options",
  private: "private options",
  readonly: "readonly options",
  typeset: "typeset options",
  read: "read options",
  vared: "vared options",
  getopts: "getopts s options",
  getln: "getln options",
  set: "set -A options a",
  wait: "wait -p options",
  print: "print -v options",
  printf: "printf -v options",
  zparseopts: "zparseopts -A options",
  zformat: "zformat -f options x",
  zstyle: "zstyle -a :x y options",
  strftime: "strftime -s options 0",
  zstat: "zstat -A options f",
  stat: "stat -A options f",
  zselect: "zselect -A options",
  sysread: "sysread options",
  zregexparse: "zregexparse options",
  pcre_match: "pcre_match -v options x",
  zpty: "zpty -r p options",
  zsystem: "zsystem flock -f options f",
  syserror: "syserror -e options",
  sysopen: "sysopen -u options -r f",
  zgetattr: "zgetattr f a options",
  zlistattr: "zlistattr f options",
  ztie: "ztie -d db/gdbm -f db options",
  zcurses: "zcurses input w options",
  shift: "shift 1 options",
  compadd: "compadd -O options a",
  compquote: "compquote options",
  comparguments: "comparguments -O options",
  compvalues: "compvalues -O options",
  compdescribe: "compdescribe -g options",
  comptags: "comptags -i options",
  compfiles: "compfiles -p options",
  syswrite: "syswrite -c options x",
  zmodload: "zmodload -F -l -P options zsh/zutil",
};

/** `zftp` is listed though its module may not load where its libc lacks a symbol; `-` is the precommand modifier. */
const NON_WRITERS = [
  "-",
  "example",
  ".",
  ":",
  "[",
  "alias",
  "autoload",
  "bg",
  "bindkey",
  "break",
  "builtin",
  "bye",
  "cap",
  "cd",
  "chdir",
  "chgrp",
  "chmod",
  "chown",
  "clone",
  "command",
  "compcall",
  "compctl",
  "compgroups",
  "compset",
  "comptry",
  "continue",
  "dirs",
  "disable",
  "disown",
  "echo",
  "echotc",
  "echoti",
  "emulate",
  "enable",
  "eval",
  "exec",
  "exit",
  "false",
  "fc",
  "fg",
  "functions",
  "getcap",
  "hash",
  "history",
  "jobs",
  "kill",
  "let",
  "limit",
  "ln",
  "log",
  "logout",
  "mkdir",
  "mv",
  "noglob",
  "pcre_compile",
  "pcre_study",
  "popd",
  "pushd",
  "pushln",
  "pwd",
  "r",
  "rehash",
  "return",
  "rm",
  "rmdir",
  "sched",
  "setcap",
  "setopt",
  "source",
  "suspend",
  "sync",
  "sysseek",
  "test",
  "times",
  "trap",
  "true",
  "ttyctl",
  "type",
  "ulimit",
  "umask",
  "unalias",
  "unfunction",
  "unhash",
  "unlimit",
  "unset",
  "unsetopt",
  "whence",
  "where",
  "which",
  "zcompile",
  "zdelattr",
  "zf_chgrp",
  "zf_chmod",
  "zf_chown",
  "zf_ln",
  "zf_mkdir",
  "zf_mv",
  "zf_rm",
  "zf_rmdir",
  "zf_sync",
  "zftp",
  "zgdbmpath",
  "zle",
  "zprof",
  "zsetattr",
  "zsocket",
  "ztcp",
  "zuntie",
];

const OPTIONS: ReadonlySet<string> = new Set(["options"]);

const writesOptions = (line: string) => {
  const words = tokenize(line).filter((t): t is WordToken => t.type === "word");
  const cmd = unwrap(words);
  return cmd !== null && writesProtectedParam(cmd, words, [], OPTIONS) !== null;
};

describe("the zsh builtin universe", () => {
  it("tags exactly 152 builtins", () => {
    expect(Object.keys(WRITERS).length + NON_WRITERS.length).toBe(152);
  });

  it("tags no builtin as both a writer and a non-writer", () => {
    expect(NON_WRITERS.filter((name) => Object.hasOwn(WRITERS, name))).toEqual(
      []
    );
  });

  it.each(Object.entries(WRITERS))("reads %s as a writer", (_name, sample) => {
    expect(writesOptions(sample)).toBe(true);
  });
});

const LIVE_SCRIPT = `
for dir in $module_path; do
  for f in $dir/zsh/*.so $dir/zsh/*/*.so; do
    m=\${f#$dir/}
    m=\${m%.so}
    [[ $m == zsh/example ]] || zmodload $m 2>/dev/null
  done
done
print -rl -- \${(k)builtins}
`;

const zsh = spawnSync("zsh", ["-f", "-c", "true"]);

describe.skipIf(zsh.error !== undefined || zsh.status !== 0)(
  "the live zsh",
  () => {
    it("has no builtin the checked-in list leaves untagged", () => {
      const live = spawnSync("zsh", ["-f", "-c", LIVE_SCRIPT], {
        encoding: "utf8",
      })
        .stdout.split("\n")
        .filter(Boolean);
      const tagged = new Set([...Object.keys(WRITERS), ...NON_WRITERS]);
      expect(live.filter((name) => !tagged.has(name))).toEqual([]);
    });
  }
);
