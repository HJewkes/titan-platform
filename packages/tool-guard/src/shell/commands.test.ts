import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";
import type { SimpleCommand } from "./commands.js";
import { ParseError } from "./lexer.js";
import { resolvePath } from "./path.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";
const NPMRC = "/home/you/.npmrc";

const extract = (src: string) => extractCommands(src, { cwd: REPO, home: HOME });
const values = (cmd: SimpleCommand | undefined) => cmd?.args.map((a) => a.value);

/** Absolute paths a command's arguments and redirect targets name. */
function pathsOf(cmd: SimpleCommand): Array<string | null> {
  const words = [...cmd.args, ...cmd.redirects.flatMap((r) => (r.target ? [r.target] : []))];
  return words.map((w) => resolvePath(cmd.dir, w, HOME));
}

/** Names of the commands through which `path` is reachable. */
function namesReaching(src: string, path: string): Array<string | null> {
  return extract(src)
    .filter((c) => pathsOf(c).includes(path))
    .map((c) => c.name);
}

describe("literal assignments", () => {
  it("expands a variable assigned earlier in the string", () => {
    const cat = extract('F=~/.x; cat "$F"').find((c) => c.name === "cat");

    expect(values(cat)).toEqual(["~/.x"]);
    expect(cat?.args[0]?.dynamic).toBe(false);
  });

  it("expands $HOME and ${HOME} from the home option", () => {
    expect(values(extract("cat $HOME/.a ${HOME}/.b")[0])).toEqual(["/home/you/.a", "/home/you/.b"]);
  });

  it("expands braced references, export and a value built from another variable", () => {
    const src = "export D=$HOME/.config; F=${D}/gh/hosts.yml; cat ${F}";

    expect(values(extract(src).find((c) => c.name === "cat"))).toEqual(["/home/you/.config/gh/hosts.yml"]);
  });

  it("expands a variable that names the command", () => {
    expect(extract("G=git; $G push origin main")[0]).toMatchObject({ name: "git" });
  });

  it.each([
    ["a substitution", "F=$(echo ~/.x); cat $F"],
    ["read", "read F; cat $F"],
    ["printf -v", "printf -v F %s x; cat $F"],
    ["a for loop", "for F in a b; do cat $F; done"],
    ["an unassigned variable", "cat $F"],
  ])("leaves a value set by %s dynamic", (_how, src) => {
    const cat = extract(src).find((c) => c.name === "cat");

    expect(cat?.args[0]).toMatchObject({ value: "$F", dynamic: true });
  });

  it("does not carry an assignment out of a subshell", () => {
    const cat = extract("(F=~/.x); cat $F").find((c) => c.name === "cat");

    expect(cat?.args[0]?.dynamic).toBe(true);
  });

  it("keeps a prefix assignment as env for that command only", () => {
    const [first, second] = extract("F=~/.x printenv F; cat $F");

    expect(first?.env).toEqual({ F: "~/.x" });
    expect(second?.args[0]?.dynamic).toBe(true);
  });
});

describe("package runners", () => {
  it.each([
    ["pnpm exec changeset publish", "changeset", ["publish"]],
    ["pnpm --filter app exec changeset publish", "changeset", ["publish"]],
    ["pnpm dlx @changesets/cli publish", "@changesets/cli", ["publish"]],
    ["npx changeset publish", "changeset", ["publish"]],
    ["npx -y wrangler@3 deploy", "wrangler", ["deploy"]],
    ["npm exec -- wrangler deploy", "wrangler", ["deploy"]],
    ["yarn dlx wrangler deploy", "wrangler", ["deploy"]],
    ["bunx wrangler deploy", "wrangler", ["deploy"]],
  ])("unwraps %s", (src, name, args) => {
    const [cmd] = extract(src);

    expect(cmd?.name).toBe(name);
    expect(values(cmd)).toEqual(args);
  });

  it.each([
    ["pnpm -r publish", ["-r", "publish"]],
    ["pnpm --filter x publish", ["--filter", "x", "publish"]],
    ["npm -w pkg publish", ["-w", "pkg", "publish"]],
  ])("leaves %s as a package-manager command", (src, args) => {
    const [cmd] = extract(src);

    expect(cmd?.name).toBe(src.split(" ")[0]);
    expect(values(cmd)).toEqual(args);
  });
});

describe("parse errors", () => {
  it("throws ParseError on an unterminated quote", () => {
    expect(() => extract("cat '~/.npmrc")).toThrow(ParseError);
  });

  it("throws ParseError inside a heredoc fed to a shell", () => {
    expect(() => extract("bash <<EOF\necho 'x\nEOF\n")).toThrow(ParseError);
  });

  it("throws ParseError past the nesting cap", () => {
    const deep = Array.from({ length: 10 }).reduce<string>((inner) => `eval ${JSON.stringify(inner)}`, "ls");

    expect(() => extract(deep)).toThrow(ParseError);
  });
});

describe("working directory", () => {
  it("follows cd, including a bare cd to home", () => {
    expect(extract("cd ~ && cat .npmrc; cd && ls; cd /tmp && ls; cd - && ls").map((c) => c.dir)).toEqual([
      HOME,
      HOME,
      "/tmp",
      null,
    ]);
  });

  it("restores the directory after a subshell", () => {
    expect(extract("(cd /tmp && ls); ls").map((c) => c.dir)).toEqual(["/tmp", REPO]);
  });
});

describe("commands with no static name", () => {
  it("emits a bare redirection so its target is not lost", () => {
    const [cmd] = extract("> ~/.claude/settings.json");

    expect(cmd).toMatchObject({ name: null, args: [] });
    expect(pathsOf(cmd as SimpleCommand)).toEqual(["/home/you/.claude/settings.json"]);
  });

  it("emits a dynamic command name with its words as arguments", () => {
    expect(values(extract("$(which cat) ~/.npmrc").find((c) => c.name === null))).toEqual(["", "~/.npmrc"]);
  });

  it("emits a shell with its own redirects as well as the script it runs", () => {
    expect(extract("bash -c 'echo x' > out").map((c) => [c.name, c.redirects.length])).toEqual([
      ["bash", 1],
      ["echo", 0],
    ]);
  });
});

// Shell spellings of section 3.3 whose detection rests on this tokenizer: each must reach
// the named command with ~/.npmrc (or ~/.netrc) resolvable from an argument or redirect.
const SPELLINGS: Array<[string, string, string | null, string?]> = [
  ["bash.secret.cat", "cat ~/.npmrc", "cat"],
  ["bash.secret.absolute", "cat /home/you/.npmrc", "cat"],
  ["bash.secret.redirect-in", "base64 < ~/.npmrc", "base64"],
  ["bash.secret.redirect-in (loop)", "while read l; do echo $l; done < ~/.netrc", null, "/home/you/.netrc"],
  ["bash.secret.here-string", 'base64 <<< "$(cat ~/.npmrc)"', "cat"],
  ["bash.secret.subshell (parens)", "(cat ~/.npmrc)", "cat"],
  ["bash.secret.subshell (substitution)", 'echo "$(cat ~/.npmrc)"', "cat"],
  ["bash.secret.subshell (backticks)", "echo `cat ~/.npmrc`", "cat"],
  ["bash.secret.home-relative ($HOME)", "cat $HOME/.npmrc", "cat"],
  ["bash.secret.home-relative (${HOME})", "cat ${HOME}/.npmrc", "cat"],
  ["bash.secret.home-relative (cd ~)", "cd ~ && cat .npmrc", "cat"],
  ["bash.secret.var-indirection", 'F=~/.npmrc; cat "$F"', "cat"],
  ["bash.secret.quoting (double)", 'cat ~/".npmrc"', "cat"],
  ["bash.secret.quoting (empty single)", "cat ~/.n''pmrc", "cat"],
  ["bash.secret.quoting (backslash)", "cat ~/.n\\pmrc", "cat"],
  ["bash.secret.quoting (ANSI-C)", "cat $'\\x7e/.npmrc'", "cat"],
  ["bash.secret.sh-c", "sh -c 'cat ~/.npmrc'", "cat"],
  ["bash.secret.sh-c (eval)", 'eval "cat ~/.npmrc"', "cat"],
  ["bash.secret.xargs", "echo ~/.npmrc | xargs cat", "echo"],
  ["bash.secret.heredoc-shell", "bash <<EOF\ncat ~/.npmrc\nEOF", "cat"],
  ["bash.secret.heredoc-shell (here-string)", "bash <<< 'cat ~/.npmrc'", "cat"],
  ["bash.secret.link-then-read", "ln -s ~/.npmrc /tmp/x && cat /tmp/x", "ln"],
  ["chaining with &", "sleep 1 & cat ~/.npmrc", "cat"],
  ["chaining with a newline", "ls\ncat ~/.npmrc", "cat"],
  ["behind env, sudo, timeout, nohup", "env A=1 sudo timeout 5 nohup cat ~/.npmrc", "cat"],
];

describe("section 3.3 shell spellings", () => {
  it.each(SPELLINGS)("%s", (_id, src, name, path = NPMRC) => {
    expect(namesReaching(src, path)).toContain(name);
  });

  it("does not resolve a value computed at run time", () => {
    expect(namesReaching("F=$(echo ~/.npmrc); cat $F", NPMRC)).toEqual(["echo"]);
  });
});
