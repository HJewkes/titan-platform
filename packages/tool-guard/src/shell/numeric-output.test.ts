import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer.js";
import { numericOutput } from "./numeric-output.js";

const prints = (command: string) => numericOutput(tokenize(command));

describe("a substitution whose output is only digits", () => {
  it.each([
    ["date +%s", "date +%s"],
    ["nanoseconds", "date +%s%N"],
    ["an hour without padding", "date +%-H"],
    ["another day", "date -d tomorrow +%s"],
    ["a file's time", "date -r f +%s"],
    ["UTC", "date -u +%Y%m%d"],
    ["wc reading its input", "wc -l < f"],
    ["wc at the end of a pipe", "git status --porcelain | wc -l"],
    ["wc after a longer pipe", "ls | grep x | wc -lc"],
    ["grep -c over one file", "grep -c ok log"],
    ["grep -c over input", "grep -ci ok"],
    ["grep -c over files with -h", "grep -ch ok a b"],
    ["stat sizes", "stat -c %s f"],
    ["stat times", "stat --format=%Y f g"],
    ["nproc", "nproc"],
    ["nproc --all", "nproc --all"],
    ["id -u", "id -u"],
    ["id of a user", "id -g someone"],
    ["tput cols", "tput cols"],
    ["seq", "seq 1 3"],
    ["seq -w", "seq -w 1 10"],
    ["a commit count", "git rev-list --count HEAD"],
    ["du -s through cut", "du -sk . | cut -f1"],
  ])("reads %s as digits", (_name, command) => {
    expect(prints(command)).toBe(true);
  });

  it.each([
    ["date with no format", "date"],
    ["a date format with text", "date +%Y-%m-%d"],
    ["a locale directive", "date +%a"],
    ["a run-time format", "date +$f"],
    ["cat", "cat count"],
    ["wc naming its file", "wc -l f"],
    ["wc with a run-time option", "wc $o"],
    ["grep -c over two files", "grep -c ok a b"],
    ["grep without -c", "grep ok log"],
    ["grep -c with an unread option", "grep -cr ok ."],
    ["stat printing a name", "stat -c %n f"],
    ["stat without a format", "stat f"],
    ["id with names", "id -un"],
    ["id with no option", "id"],
    ["tput of a string", "tput setaf"],
    ["seq with a format", "seq -f %g 1 3"],
    ["git with a global option", "git -C x rev-list --count HEAD"],
    ["rev-list printing commits", "git rev-list HEAD"],
    ["rev-list with a format", "git rev-list --count --format=%s HEAD"],
    ["du with human sizes", "du -sh . | cut -f1"],
    ["du without -s", "du -k . | cut -f1"],
    ["two commands", "date +%s; cat f"],
    ["a pipe into a counter that is not last", "wc -l < f | cat"],
  ])("refuses %s", (_name, command) => {
    expect(prints(command)).toBe(false);
  });
});
