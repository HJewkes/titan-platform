import { describe, expect, it } from "vitest";
import { CommandRebindingError } from "./command-rebinding.js";
import { extractCommands } from "./commands.js";
import { writesHookedParam } from "./hooked-params.js";
import { tokenize } from "./lexer.js";
import type { RedirectToken, WordToken } from "./lexer.js";
import { unwrap } from "./unwrap.js";

const hooked = (line: string) => {
  const tokens = tokenize(line);
  const words = tokens.filter((t): t is WordToken => t.type === "word");
  const cmd = unwrap(words);
  return cmd && writesHookedParam(cmd, words, tokens.filter((t): t is RedirectToken => t.type === "redirect"));
};

// Every place a shell evaluates math inside a command's words and redirects. `S` stands for a store into a protected
// parameter: both readers must see it in each place, so a place one skips fails here.
const PLACES: Array<[string, string]> = [
  ["a $(( )) body", "echo $(( S ))"],
  ["a legacy $[ ] body", "echo $[ S ]"],
  ["an element read subscript", "echo ${a[S]}"],
  ["an element assignment subscript", "a[S]=1"],
  ["a quoted segment inside an element assignment subscript", "a['S']=1"],
  ["a quoted assignment argument to declare", "declare 'a[S]=1'"],
  ["a substring offset", "echo ${x:S}"],
  ["a substring length", "echo ${x:0:S}"],
  ["a redirect target", ": > f$(( S ))"],
  ["a here-string", "cat <<< $(( S ))"],
  ["an unquoted heredoc body", "cat <<EOF\n$(( S ))\nEOF"],
  ["a descriptor variable subscript", "exec {a[S]}>f"],
  ["a compound array element key", "a=([S]=1)"],
  ["a later compound array element key", "a=(x [S]=1)"],
  ["a compound array element key inside a subscript", "a=([b[S]]=1)"],
  ["a later compound array element's $(( ))", "a=(x $(( S )))"],
];

describe("every place a shell evaluates math is read by both protected-parameter readers", () => {
  it.each(PLACES)("rebinding reader: %s", (_, template) => {
    expect(() => extractCommands(template.replace("S", "commands[y]=0"))).toThrow(CommandRebindingError);
  });

  it.each(PLACES)("hooked-parameter reader: %s", (_, template) => {
    expect(hooked(template.replace("S", "PS4=1"))).toBe("PS4");
  });

  it.each([
    ["a quoted heredoc body", "cat <<'EOF'\n$(( commands[y]=0 ))\nEOF"],
    ["a single-quoted word", "echo '$(( commands[y]=0 ))'"],
    ["a fully quoted word that is no assignment", "gh api x -f 'a[$K]=b'"],
    ["a fully quoted element write that is no assignment", "gh api x -f 'a[commands[y]=0]=b'"],
  ])("reads no store in %s, which nothing evaluates", (_, line) => {
    expect(() => extractCommands(line)).not.toThrow();
  });
});

// The walk folds `NAME=( … )` into one word holding element 0, so each element is read from the elements kept beside it.
describe("a compound array assignment's elements", () => {
  it.each([
    ["an element key storing into BASH_CMDS", "a=([BASH_CMDS[y]=0]=1); git push"],
    ["an element key storing into commands", "a=([commands[y]=0]=1); git push"],
    ["a later element's key", "a=(x [commands[y]=0]=1); git push"],
    ["an appended element's key", "a+=([commands[y]=0]=1); git push"],
    ["a declare element's key", "declare a=([commands[y]=0]=1); git push"],
    ["a typeset -a element's key", "typeset -a a=([BASH_CMDS[y]=0]=1); git push"],
    ["a local element's key in a function", "f() { local a=([commands[y]=0]=1); }; git push"],
    ["a key nested in a key's subscript", "a=([b[commands[y]=0]]=1); git push"],
    ["a double-quoted key", 'a=(["commands[y]=0"]=1); git push'],
    ["a later element's $(( ))", "a=(x $(( commands[y]=0 ))); git push"],
    ["a later element's subscript read", "a=(x ${b[commands[y]=0]}); git push"],
    ["a later element's substring offset", "a=(x ${b:commands[y]=0}); git push"],
    ["a key that expands at run time", "a=([$i]=x); git push"],
    ["a key after a process substitution, which the walk does not fold", "a=(x <(true) [BASH_CMDS[y]=0]=1); git push"],
  ])("refuses %s", (_, line) => {
    expect(() => extractCommands(line)).toThrow(CommandRebindingError);
  });

  it.each([
    ["literal keys", "a=([0]=x [1]=y); git push"],
    ["a key that reads a name", "a=([i+1]=x); git push"],
    ["plain elements", "a=(x y $z); git push"],
    ["a single-quoted element, which is no key", "a=(x '[commands[y]=0]=1'); git push"],
    ["literal keys after a process substitution", "a=(x <(true) [0]=y [i+1]=z); git push"],
  ])("passes %s", (_, line) => {
    expect(() => extractCommands(line)).not.toThrow();
  });

  it("refuses an element key storing into a hooked parameter alike", () => {
    expect(hooked("b=([PS4=7]=x)")).toBe("PS4");
    expect(hooked("declare b=([PS4=7]=x)")).not.toBeNull();
  });
});

// A substring opener reaches its whole offset before any subscript in it, or the store past `[y]` goes unread.
describe("a substring offset holding a subscript", () => {
  it.each([
    ["a compound assignment", "echo ${b:commands[y]+=0}; git push"],
    ["an increment", "echo ${b:commands[y]++}; git push"],
    ["a length", "echo ${b:0:commands[y]|=1}; git push"],
    ["a parenthesized store", "echo ${b:a[0]+(commands[y]+=1)}; git push"],
  ])("refuses %s", (_, line) => {
    expect(() => extractCommands(line)).toThrow(CommandRebindingError);
  });

  it("passes zsh's alternate value, which is no offset", () => {
    expect(() => extractCommands("echo ${b:++commands[y]}; git push")).not.toThrow();
  });
});
