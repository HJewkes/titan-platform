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
