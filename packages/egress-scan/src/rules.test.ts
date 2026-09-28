import { describe, expect, it } from "vitest";
import { matchesAwDataPath, matchesHomePath, matchRules } from "./rules.js";

// Planted paths are assembled at runtime so this file never trips the scanner itself.
const user = "planted" + "-name";
const join = (sep: string, ...parts: string[]) => parts.join(sep);

describe("home-path", () => {
  it.each([
    ["macOS", join("/", "", "Users", user, "src")],
    ["Linux", join("/", "", "home", user, ".config")],
    ["Windows backslash", join("\\", "C:", "Users", user, "Desktop")],
    ["Windows forward slash", join("/", "C:", "Users", user)],
    ["lower-case Windows", join("\\", "d:", "users", user)],
    ["file URL", `file://${join("/", "", "Users", user, "a.txt")}`],
    ["JSON-escaped backslashes", `"${join("\\\\", "C:", "Users", user)}"`],
    ["JSON-escaped slashes", `"${join("\\/", "", "Users", user)}"`],
    ["quoted in prose", `see '${join("/", "", "home", user)}' for details`],
  ])("flags a %s home path", (_label, text) => {
    expect(matchesHomePath(text)).toBe(true);
  });

  it.each([
    ["angle placeholder", join("/", "", "Users", "<you>", "src")],
    ["brace placeholder", join("/", "", "home", "{user}")],
    ["shell variable", join("/", "", "home", "$USER", "x")],
    ["GitHub runner", join("/", "", "home", "runner", "work")],
    ["macOS shared", join("/", "", "Users", "Shared")],
    ["listed placeholder, any case", join("/", "", "Users", "Example", "repo")],
    ["placeholder ending a sentence", `under ${join("/", "", "Users", "you")}.`],
    ["a word that only starts like the root", join("/", "docs", "UsersGuide", user)],
    ["a route under a relative home directory", join("/", "app", "home", user)],
    ["an API route in lower case", join("/", "", "users", user)],
    ["a bare root", join("/", "", "Users", "")],
  ])("ignores a %s", (_label, text) => {
    expect(matchesHomePath(text)).toBe(false);
  });

  it("flags a line where a real segment follows a placeholder one", () => {
    const text = `${join("/", "", "Users", "you")} and ${join("/", "", "home", user)}`;
    expect(matchesHomePath(text)).toBe(true);
  });
});

describe("aw-data-path", () => {
  const shapes = {
    macOS: ["Library", "Application Support", "active-work"],
    Linux: [".local", "share", "active-work"],
    Windows: ["AppData", "Local", "active-work"],
  };

  it.each(Object.entries(shapes).flatMap(([os, parts]) =>
    ["~", "$HOME", join("/", "", "Users", "you")].map((prefix) => [os, prefix, join("/", prefix, ...parts, "x")]),
  ))("flags the %s shape with a %s prefix", (_os, _prefix, text) => {
    expect(matchesAwDataPath(text)).toBe(true);
  });

  it.each([
    ["percent-encoded space", join("/", "~", "Library", "Application%20Support", "active-work")],
    ["shell-escaped space", join("/", "~", "Library", "Application\\ Support", "active-work")],
    ["Windows backslashes", join("\\", "%USERPROFILE%", "AppData", "Local", "active-work", "Data")],
  ])("flags the %s spelling", (_label, text) => {
    expect(matchesAwDataPath(text)).toBe(true);
  });

  it.each([
    ["the bare product name", "the active-work CLI"],
    ["a different app in the same root", join("/", "~", ".local", "share", "other-app")],
    ["a longer name", join("/", "~", ".local", "share", "active-workshop")],
  ])("ignores %s", (_label, text) => {
    expect(matchesAwDataPath(text)).toBe(false);
  });
});

describe("matchRules", () => {
  it("reports each rule once with the term's line number", () => {
    const term = { index: 7, matches: (text: string) => text.includes("zq") };
    const text = `zq ${join("/", "", "home", user)} ${join("/", "", "home", user)}`;
    expect(matchRules(text, [term])).toEqual([{ rule: "home-path" }, { rule: "private-term", termIndex: 7 }]);
  });
});
