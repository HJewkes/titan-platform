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

// Review gaps on #259: each spelling runs `git push`, and each was missed before its fix.
const HIDDEN_GIT_PUSH: Array<[string, string]> = [
  ["bash --norc -c", "bash --norc -c 'git push'"],
  ["bash --login -c", "bash --login -c 'git push'"],
  ["bash --rcfile <file> -c", "bash --rcfile x.rc -c 'git push'"],
  ["bash -c --", "bash -c -- 'git push'"],
  ["bash -- with a heredoc", "bash -- <<EOF\ngit push\nEOF"],
  ["npx -c", "npx -c 'git push'"],
  ["npm exec -c", "npm exec -c 'git push'"],
  ["npm exec --call=", "npm exec --call='git push'"],
  ["pnpm exec -c", "pnpm exec -c 'git push'"],
  ["env -S", "env -S 'git push'"],
  ["env --split-string=", "env --split-string='git push'"],
  ["env -S with the text attached", "env -S'git push'"],
  ["env with -S ending a short cluster (-iS)", "env -iS 'git push'"],
  ["env with -S ending a short cluster (-vS)", "env -vS 'git push'"],
  ["env with -S attached after a cluster", "env -iS'git push'"],
  ["npm exec with -c ending a short cluster", "npm exec -yc 'git push'"],
  ["pnpm's global -c before exec", "pnpm -c exec 'git push'"],
  ["pnpm's global --shell-mode before exec", "pnpm --shell-mode exec 'git push'"],
  ["pnpm's global -c after another option", "pnpm -r -c exec 'git push'"],
  ["pnpm's global -c in a cluster", "pnpm -rc exec 'git push'"],
  ["line continuation inside a double-quoted name", '"gi\\\nt" push'],
  ["substitution in a ${x:-...} default", "echo ${x:-$(git push)}"],
  ["backticks in a ${x:-...} default", "echo ${x:-`git push`}"],
  ["substitution in arithmetic", "echo $(( $(git push) ))"],
  ["substitution in an unquoted heredoc body", "cat <<EOF\n$(git push)\nEOF"],
  ["backticks in an unquoted heredoc body", "git commit -F - <<EOF\n`git push`\nEOF"],
];

describe("commands hidden from git-safety's parser", () => {
  it.each(HIDDEN_GIT_PUSH)("finds git push through %s", (_how, src) => {
    const git = extract(src).find((c) => c.name === "git");

    expect(values(git)?.[0]).toBe("push");
  });

  it("appends the words after env -S's string as arguments", () => {
    expect(values(extract("env -S 'git push' origin \"it's\"").find((c) => c.name === "git"))).toEqual([
      "push",
      "origin",
      "it's",
    ]);
  });

  // npm 11 reads `-c'x'` as an unknown config named `--cx` and runs nothing.
  it.each([
    ["npx", "npx -c'git push'"],
    ["npm exec", "npm exec -c'git push'"],
  ])("runs nothing for %s with -c's text attached, as npm does", (_how, src) => {
    expect(extract(src).some((c) => c.name === "git" || c.name?.includes(" "))).toBe(false);
  });

  it("keeps pnpm's global options as pnpm's when there is no exec", () => {
    expect(extract("pnpm -c publish").map((c) => c.name)).toEqual(["pnpm"]);
  });

  it("reads a word after bash -- as a script path even when it looks like -c", () => {
    expect(extract("bash -- -c 'git push'").map((c) => c.name)).toEqual(["bash"]);
  });

  it.each([
    ["single-quoted", "cat <<'EOF'\n$(git push)\nEOF"],
    ["double-quoted", 'cat <<"EOF"\n$(git push)\nEOF'],
    ["backslash-quoted", "cat <<\\EOF\n$(git push)\nEOF"],
  ])("leaves substitutions in a %s heredoc body unrun", (_how, src) => {
    expect(extract(src).map((c) => c.name)).toEqual(["cat"]);
  });
});

const gitArgs = (src: string) => extract(src).filter((c) => c.name === "git").map(values);

describe("wrappers that run their command", () => {
  it("unwraps coproc", () => {
    expect(gitArgs("coproc git push")).toEqual([["push"]]);
  });

  it.each([
    ["coproc NAME { git push; }", "a brace group"],
    ["coproc NAME if true; then git push; fi", "an if"],
  ])("unwraps %s past the name before %s", (src) => {
    expect(extract(src).map((c) => [c.name, values(c)])).toContainEqual(["git", ["push"]]);
    expect(extract(src).map((c) => c.name)).not.toContain("NAME");
  });

  it("keeps a quoted brace as coproc's command word", () => {
    expect(extract("coproc NAME '{'").map((c) => c.name)).toEqual(["NAME"]);
  });

  it.each([
    ["watch git push", "the command words"],
    ["watch -n 5 -d git push", "-n's interval"],
    ["watch --interval=5 git push", "an attached interval"],
    ["watch -x git push", "-x, which runs the words directly"],
    ["watch -s /tmp git push", "-s's screenshot directory"],
    ["watch --shotsdir /tmp git push", "--shotsdir's directory"],
    ["watch -q 3 git push", "-q's cycle count"],
    ["watch --equexit 3 -s /tmp -n 1 git push", "several value options"],
  ])("unwraps %s past %s", (src) => {
    expect(gitArgs(src)).toEqual([["push"]]);
  });

  it("reads watch's words as shell text, since it hands them to sh -c", () => {
    expect(extract("watch 'ls; git push'").map((c) => c.name)).toEqual(["watch", "ls", "git"]);
  });

  it.each([["watch -x"], ["watch -tx"], ["watch --exec"]])("runs the words after %s directly", (prefix) => {
    expect(extract(`${prefix} echo 'a; git push'`).map((c) => c.name)).toEqual(["echo"]);
  });

  it.each([
    ["doas git push", "no options"],
    ["doas -u deploy git push", "-u's user"],
    ["doas -n -a bsdauth git push", "-a's style"],
  ])("unwraps %s past %s", (src) => {
    expect(gitArgs(src)).toEqual([["push"]]);
  });

  it("does not unwrap doas -C, which only checks the rule", () => {
    expect(extract("doas -C /etc/doas.conf git push")).toEqual([]);
  });

  it.each([
    ["setsid git push", "no options"],
    ["setsid -f git push", "-f"],
  ])("unwraps %s past %s", (src) => {
    expect(gitArgs(src)).toEqual([["push"]]);
  });

  it.each([
    ["flock /tmp/l git push", "the lock file"],
    ["flock -n /tmp/l git push", "-n"],
    ["flock -w 10 /tmp/l git push", "-w's seconds"],
    ["flock /tmp/l -c 'git push'", "-c after the lock file"],
    ["flock -x /tmp/l --command 'git push'", "--command after the lock file"],
  ])("unwraps %s past %s", (src) => {
    expect(gitArgs(src)).toEqual([["push"]]);
  });

  it("unwraps bun x", () => {
    expect(gitArgs("bun x git push")).toEqual([["push"]]);
  });
});

describe("find actions", () => {
  it("emits the command of find -exec as well as find", () => {
    expect(extract("find . -exec git push \\;").map((c) => [c.name, values(c)])).toEqual([
      ["find", [".", "-exec", "git", "push", ";"]],
      ["git", ["push"]],
    ]);
  });

  it.each([
    ["-exec ... \\;", "find . -exec git push \\; -exec git fetch \\;", [["push"], ["fetch"]]],
    ["-exec ... {} +", "find . -exec git push {} + -exec git fetch {} +", [["push", "{}"], ["fetch", "{}"]]],
    ["a + not after {}", "find . -exec git push + {} \\;", [["push", "+", "{}"]]],
    ["-execdir", "find . -execdir git push \\;", [["push"]]],
    ["-ok", "find . -name x -ok git push \\;", [["push"]]],
    ["-okdir", "find . -okdir git push {} +", [["push", "{}"]]],
  ])("ends each action at its terminator: %s", (_how, src, args) => {
    expect(gitArgs(src)).toEqual(args);
  });
});

describe("literal text piped into a shell", () => {
  it.each([
    ["echo", "echo git push | bash"],
    ["echo, quoted", "echo 'git push' | sh"],
    ["echo -n", "echo -n git push | zsh"],
    ["printf", "printf 'git push\\n' | sh"],
    ["printf with %s", "printf '%s push\\n' git | sh"],
    ["printf with a reused format", "printf '%s\\n' 'git fetch' 'git push' | bash"],
    ["a wrapped shell", "echo git push | sudo bash -s"],
    ["|&", "echo git push |& bash"],
    ["xargs sh -c", "printf '%s\\n' 'git push' | xargs sh -c"],
    ["a subshell", "echo git push | (bash)"],
    ["a nested subshell", "echo git push | ( (sh) )"],
    ["tee", "echo git push | tee f | bash"],
    ["cat with no file", "echo git push | cat - | sh"],
    ["printf %.3s, truncated", "printf '%.3s push\\n' 'gitlab' | bash"],
    ["printf %c, the first character", "printf '%c%c%c push' gx ix tx | bash"],
    ["printf width and precision from arguments", "printf '%*.*s push' 3 3 'gitx' | bash"],
  ])("runs the text of %s", (_how, src) => {
    expect(gitArgs(src).at(-1)).toEqual(["push"]);
  });

  it.each([
    ["truncates to %.3s's precision", "printf '%.3s' 'git push' | bash", []],
    ["pads to %5s's width without changing the words", "printf '%5s push' git | bash", ["push"]],
  ])("printf %s", (_how, src, args) => {
    expect(gitArgs(src)).toEqual([args]);
  });

  it("decodes echo's escapes unless -E is given", () => {
    expect(gitArgs("echo 'ls\\ngit push' | sh")).toEqual([["push"]]);
    expect(gitArgs("echo -E 'ls\\ngit push' | sh")).toEqual([]);
  });

  it.each([
    ["a dynamic argument", "echo git $X | bash", ["echo", "bash"]],
    ["a printf format it does not model", "printf '%q' 'git push' | bash", ["printf", "bash"]],
    ["printf -v", "printf -v X 'git push' | bash", ["printf", "bash"]],
    ["a script operand", "echo git push | bash x.sh", ["echo", "bash"]],
    ["a command that is not echo or printf", "cat git push | bash", ["cat", "bash"]],
    ["a pipe into something else", "echo git push | cat", ["echo", "cat"]],
    ["a pipe through another command", "echo git push | wc -l | bash", ["echo", "wc", "bash"]],
    ["cat reading a file", "echo git push | cat f | bash", ["echo", "cat", "bash"]],
    ["a ; before the shell", "echo git push | cat; bash", ["echo", "cat", "bash"]],
    ["a ; before a subshell", "echo git push; (bash)", ["echo", "bash"]],
  ])("runs nothing for %s", (_how, src, names) => {
    expect(extract(src).map((c) => c.name)).toEqual(names);
  });
});
