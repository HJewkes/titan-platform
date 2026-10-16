import { describe, expect, it } from "vitest";
import { writesHookedParam, writesProtectedParam } from "./hooked-params.js";
import { tokenize } from "./lexer.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

const OPTIONS: ReadonlySet<string> = new Set(["options"]);

/** Each `;`-separated command of the line, read through the reader under test; the first truthy reading wins. */
function reads(
  line: string,
  read: (
    cmd: NonNullable<ReturnType<typeof unwrap>>,
    words: WordToken[],
    redirects: RedirectToken[]
  ) => string | null
) {
  const tokens = tokenize(line);
  const redirects = tokens.filter(
    (t): t is RedirectToken => t.type === "redirect"
  );
  const segments: WordToken[][] = [[]];
  for (const t of tokens) {
    if (t.type === "word") segments[segments.length - 1]?.push(t);
    else if (t.type === "op" && t.value === ";") segments.push([]);
  }
  for (const words of segments) {
    const cmd = unwrap(words);
    const hit = cmd && read(cmd, words, redirects);
    if (hit) return hit;
  }
  return null;
}

const protectedWrite = (line: string) =>
  reads(line, (cmd, words, redirects) =>
    writesProtectedParam(cmd, words, redirects, OPTIONS)
  );
const hookedWrite = (line: string) =>
  reads(line, (cmd, words, redirects) =>
    writesHookedParam(cmd, words, redirects)
  );

describe("a command that stores into zsh's options parameter", () => {
  it.each([
    "options[globsubst]=on",
    "options+=(globsubst on)",
    "options[$k]=on",
    "set -A options globsubst on",
    "read -A options",
    'read -A "$n"',
    'typeset "$n"',
    "typeset $n=on",
    "vared options",
    "getopts s options",
    "zparseopts -A options",
    "print -v options",
    "printf -v options",
    "zstyle -a :x y options",
    'zstyle -s :x y "$n"',
    "strftime -s options 0",
    "zstat -A options f",
    "sysread options",
    "pcre_match -v options x",
    "zselect -A options",
    "zpty -r p options",
    "syserror -e options",
    "sysopen -u options -r f",
    "zsystem flock -f options f",
    "zgetattr f attr options",
    "zlistattr f options",
    "ztie -d db/gdbm -f db options",
    "zcurses input w options",
    "shift 1 options",
    "compadd -O options a",
    "compquote options",
    "typeset -n r=options",
    "typeset -n r; r=options",
    "sysopen -m 600 -u options -w f",
    "syswrite -c options x",
    "zmodload -F -l -P options zsh/zutil",
    "comparguments -O options",
    "compvalues -O options",
    "comptags -i options",
    "compdescribe -g options",
    "compfiles -p options",
    "compadd -o -O options a",
    "exec {options}>|f",
    "{options}>f",
    ": {options}<f",
    ": {options}>>f",
    ": {options}<>f",
    ": {options}>&2",
    "exec {options}<<<x",
    "zlistattr {f,options}",
    "zgetattr {f,a,options}",
    "zpty -r {p,options}",
    "zpty {-r,p,options}",
    "zpty -r -- $a",
    "zlistattr x$a",
    "zgetattr $f a options",
    "read -d {x,options}",
    "read -d $d options",
    "sysread -i {0,x} options",
    "print {-v,options} x",
    "zparseopts $spec",
  ])("reads %s as a write", (line) => {
    expect(protectedWrite(line)).toBeTruthy();
  });

  it.each([
    "grep -r options .",
    "ls options",
    "cat options",
    "echo options",
    'pytest "$f"',
    './x.sh "$a"',
    "read line",
    "typeset -i n=1",
    "zstyle ':completion:*' menu select",
    "zpty -r p line",
    "syserror -e line",
    "zlistattr options line",
    "shift 1 line",
    "zmodload zsh/zutil",
    "syswrite x",
    "exec 3>f",
    "exec {fd}>f",
    "echo {options}",
    "compadd -o match a",
    ": {$n}>f",
    'jq -n "{a: $x}" > out.json',
    'curl -d "{\\"k\\":\\"$v\\"}" url > out',
    ': {options}"" >f',
    ": {\\options} >f",
    ": \\{options} >f",
    ": '{options}' >f",
    "zpty -r p 'a b'",
    'read -d "," line',
    "read -d , line",
    "zparseopts -D -E a=flag",
  ])("reads %s as no write", (line) => {
    expect(protectedWrite(line)).toBeNull();
  });
});

describe("the hooked-parameter reader on the writers added with the name set", () => {
  it.each([
    "zpty -r p PS4",
    "syserror -e PS4",
    "sysopen -u PS4 -r f",
    "zsystem flock -f PS4 f",
    "zgetattr f a PS4",
    "zlistattr f PS4",
    "sysopen -m 600 -u PS4 -w f",
    "syswrite -c PS4 x",
    "zmodload -F -l -P PS4 zsh/zutil",
    "comparguments -O PS4",
    "compadd -o -A PS4 a",
    "exec {PS4}>|f",
  ])("reads %s as a PS4 write", (line) => {
    expect(hookedWrite(line)).toBe("PS4");
  });

  it("does not read a write to options as a hooked write", () => {
    expect(hookedWrite("options[globsubst]=on")).toBeNull();
  });
});
