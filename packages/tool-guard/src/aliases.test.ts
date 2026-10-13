import { describe, expect, it } from "vitest";
import { parseSnapshotAliases, withFloor } from "./aliases.js";

const SNAPSHOT = [
  "# Snapshot file",
  "# Unset all aliases to avoid conflicts with functions",
  "unalias -a 2>/dev/null || true",
  "# Functions",
  "setup () {",
  "alias foo=bar",
  "}",
  "# Shell Options",
  "setopt nohashdirs",
  "# Aliases",
  "alias -- -='cd -'",
  "alias -- ...=../..",
  "alias -- cp='nocorrect cp'",
  "alias -- g=git",
  "alias -- reload!='source ~/.zshrc'",
  "alias -- say='echo '\\''hi'\\'''",
  "alias -- x='cd /r && git push'",
  "# Check for rg availability",
  "alias rg=ripgrep",
].join("\n");

describe("parseSnapshotAliases", () => {
  it("reads the zsh alias section with quoting removed", () => {
    expect(Object.fromEntries(parseSnapshotAliases(SNAPSHOT))).toEqual({
      "-": ["cd -"],
      "...": ["../.."],
      cp: ["nocorrect cp"],
      g: ["git"],
      "reload!": ["source ~/.zshrc"],
      say: ["echo 'hi'"],
      x: ["cd /r && git push"],
    });
  });

  it("ignores alias lines in function bodies and sections outside the alias section", () => {
    const table = parseSnapshotAliases(SNAPSHOT);
    expect(table.has("foo")).toBe(false);
    expect(table.has("rg")).toBe(false);
  });

  it("reads bash-style definitions when the file has no alias section", () => {
    const table = parseSnapshotAliases("alias gp='git push'\nalias ll='ls -l' la='ls -a'\necho done");
    expect(Object.fromEntries(table)).toEqual({ gp: ["git push"], ll: ["ls -l"], la: ["ls -a"] });
  });

  it("skips lines the lexer rejects or that are not plain definitions, and keeps reading after them", () => {
    const section = [
      "# Aliases",
      "alias -- bad='unterminated",
      "alias -- home=$HOME",
      "alias -s txt=vim",
      "alias -- noequals",
      "alias -- a=b; rm -rf /",
      "alias -- g=git",
    ].join("\n");
    expect(Object.fromEntries(parseSnapshotAliases(section))).toEqual({ g: ["git"] });
  });

  it("reads a value whose quotes span a newline as one definition", () => {
    const table = parseSnapshotAliases("# Aliases\nalias -- two='cd /r\ngit push'\nalias -- g=git");
    expect(Object.fromEntries(table)).toEqual({ two: ["cd /r\ngit push"], g: ["git"] });
  });

  it("reads global aliases, which also expand in command position", () => {
    expect(parseSnapshotAliases("# Aliases\nalias -g -- G='git push'").get("G")).toEqual(["git push"]);
  });
});

describe("withFloor", () => {
  it("holds g as git when the snapshot gave nothing", () => {
    expect(withFloor(new Map()).get("g")).toEqual(["git"]);
  });

  it("keeps the snapshot's own value for g beside the floor's", () => {
    const snapshot = new Map([["g", ["grep"]]]);
    expect(withFloor(snapshot).get("g")).toEqual(["grep", "git"]);
    expect(snapshot.get("g")).toEqual(["grep"]);
  });
});
