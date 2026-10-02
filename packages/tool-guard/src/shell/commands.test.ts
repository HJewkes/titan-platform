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
    ["cat with - after a file", "echo git push | cat f - | sh"],
    ["cat with - before a file", "echo git push | cat - f | sh"],
    ["cat --", "echo git push | cat -- | sh"],
    ["cat with a long flag", "echo git push | cat --show-all | sh"],
    ["xargs -I{} sh -c '{}'", "echo git push | xargs -I{} sh -c '{}'"],
    ["xargs -I with a separate string", "echo git push | xargs -I @ sh -c 'ls; @'"],
    ["xargs --replace", "echo git push | xargs --replace sh -c '{}'"],
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
    ["a negative * precision", "printf '%.*s' -1 'git push' | bash", ["printf", "bash"]],
    ["a hex * precision", "printf '%.*s' 0x8 'git push' | bash", ["printf", "bash"]],
    ["a hex * precision before literal text", "printf '%.*s push' 0x8 git | bash", ["printf", "bash"]],
    ["a hex * width", "printf '%*s' 0x8 'git push' | bash", ["printf", "bash"]],
    ["a non-literal * precision", 'printf \'%.*s\' "$N" \'git push\' | bash', ["printf", "bash"]],
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

describe("how a command was reached", () => {
  const reach = (src: string, name: string) => extract(src).find((c) => c.name === name);

  it.each([
    ["typed at the top level", "cat f", []],
    ["a ( ) subshell", "(cat f)", ["subshell"]],
    ["a command substitution", 'echo "$(cat f)"', ["subshell"]],
    ["a sh -c string", "sh -c 'cat f'", ["sh-c"]],
    ["a wrapper's script option", "env -S 'cat f'", ["sh-c"]],
    ["eval", "eval 'cat f'", ["eval"]],
    ["xargs", "echo f | xargs cat", ["xargs"]],
    ["a heredoc fed to a shell", "bash <<EOF\ncat f\nEOF", ["heredoc-shell"]],
    ["a here-string fed to a shell", "bash <<< 'cat f'", ["heredoc-shell"]],
    ["text piped into a shell", "echo 'cat f' | sh", ["piped-shell"]],
    ["find -exec", "find . -exec cat {} ;", ["find-exec"]],
    ["nested wrappings, outermost first", "(sh -c 'echo f | xargs cat')", ["subshell", "sh-c", "xargs"]],
  ])("records %s", (_how, src, wrapping) => {
    expect(reach(src, "cat")?.wrapping).toEqual(wrapping);
  });

  it("leaves the wrapping of a ( ) subshell behind once it closes", () => {
    expect(extract("(ls); cat f").map((c) => c.wrapping)).toEqual([["subshell"], []]);
  });

  it.each([
    ["./x.sh", "./x.sh"],
    ["a home-relative path", "~/bin/x.sh"],
    ["an absolute path", "/usr/bin/git"],
    ["a path from a variable", "D=/opt; $D/x.sh"],
  ])("keeps the command word as typed: %s", (_how, src) => {
    const typed = src.replace(/^D=\/opt; \$D/, "/opt");

    expect(extract(src).at(-1)?.path).toBe(typed);
  });

  it("records the operator joining each command to the next", () => {
    const src = "a && b || c; d | e |& f\ng & h";

    expect(extract(src).map((c) => [c.name, c.next])).toEqual([
      ["a", "&&"], ["b", "||"], ["c", ";"], ["d", "|"], ["e", "|&"], ["f", "\n"], ["g", "&"], ["h", null],
    ]);
  });
});

describe("xargs options", () => {
  it.each([
    ["-tI{} clustered", "echo git push | xargs -tI{} sh -c '{}'"],
    ["-tI with a separate string", "echo git push | xargs -tI @ sh -c @"],
    ["-ti clustered", "echo git push | xargs -ti sh -c '{}'"],
    ["-I{} into a command's arguments", "echo push | xargs -I{} git {}"],
  ])("runs the piped text through %s", (_how, src) => {
    expect(gitArgs(src).at(-1)).toEqual(["push"]);
  });

  it("appends the piped words to the command's arguments", () => {
    expect(gitArgs("echo origin main | xargs git push")).toEqual([["push", "origin", "main"]]);
  });

  it("does not take the value of a clustered option as the command", () => {
    expect(extract("sudo -Eu root git push").map((c) => c.name)).toEqual(["git"]);
  });
});

describe("xargs -I runs the command once per input line", () => {
  const PUSH = ["push", "origin", "HEAD:main"];
  const LINE = ["push origin HEAD:main"];

  it("runs each piped line as its own command", () => {
    expect(gitArgs("printf 'status\\npush origin HEAD:main' | xargs -I{} git {}")).toEqual([["status"], LINE, PUSH]);
  });

  it("keeps a single read-only line as one command", () => {
    expect(gitArgs("printf 'status' | xargs -I{} git {}")).toEqual([["status"]]);
  });

  it("emits no empty command for a trailing newline", () => {
    expect(gitArgs("printf 'status\\n' | xargs -I{} git {}")).toEqual([["status"]]);
  });

  it("splits CRLF input without leaving a carriage return in the command", () => {
    expect(gitArgs("printf 'status\\r\\npush origin HEAD:main\\r\\n' | xargs -I{} git {}")).toEqual([["status"], LINE, PUSH]);
  });

  it("runs each line of a here-string", () => {
    expect(gitArgs("xargs -I{} git {} <<< $'status\\npush origin HEAD:main'")).toEqual([["status"], LINE, PUSH]);
  });

  it("runs each line of a heredoc", () => {
    expect(gitArgs("xargs -I{} git {} <<EOF\nstatus\npush origin HEAD:main\nEOF")).toEqual([["status"], LINE, PUSH]);
  });

  it("appends the words of a here-string to a command without -I", () => {
    expect(gitArgs("xargs git <<< 'push origin HEAD:main'")).toEqual([PUSH]);
  });

  it("runs each line of a shell script fed through -I", () => {
    expect(gitArgs("printf 'true\\ngit push' | xargs -I{} sh -c '{}'")).toEqual([["push"]]);
  });

  it("reads a here-string over the pipe, as the shell does", () => {
    expect(gitArgs("printf status | xargs -I{} git {} <<< 'push origin HEAD:main'")).toEqual([LINE, PUSH]);
  });

  it("reads a multi-word line both as one argument and as words", () => {
    expect(gitArgs("printf 'my repo' | xargs -I{} git -C {} push")).toEqual([["-C", "my repo", "push"], ["-C", "my", "repo", "push"]]);
  });

  it("appends a here-string's words over the pipe without -I", () => {
    expect(gitArgs("printf status | xargs git <<< 'push origin HEAD:main'")).toEqual([PUSH]);
  });

  it("does not read the pipe when a file is the stdin, and adds the worst case for git", () => {
    expect(gitArgs("printf status | xargs -I{} git {} < list.txt")).toEqual([["{}"], ["push", "origin", "HEAD:main"]]);
  });

  it("leaves {} as a value alone when stdin is unknown", () => {
    expect(gitArgs("xargs -I{} git -C {} status < repos.txt")).toEqual([["-C", "{}", "status"]]);
  });

  it("reads input from a pipe that is not literal as unknown", () => {
    expect(gitArgs("cat <<EOF | xargs -I{} git {}\nstatus\nEOF")).toEqual([["{}"], ["push", "origin", "HEAD:main"]]);
  });

  it("splits on every character when -d is not static", () => {
    expect(gitArgs("printf 'echo hiXgit push origin HEAD:main' | xargs -I{} -d \"$D\" git {}")).toContainEqual(["push", "origin", "HEAD:main"]);
  });

  it("gives each line's command the xargs wrapping", () => {
    const git = extract("printf 'status\\npush' | xargs -I{} git {}").filter((c) => c.name === "git");

    expect(git.map((c) => c.wrapping)).toEqual([["xargs"], ["xargs"]]);
  });
});

describe("xargs -L and -n run the command once per batch", () => {
  const PUSH = ["push", "origin", "HEAD:main"];

  it.each([
    ["-L1", "printf 'status\\npush origin HEAD:main' | xargs -L1 git", [["status"], PUSH]],
    ["-L 1", "printf 'status\\npush origin HEAD:main' | xargs -L 1 git", [["status"], PUSH]],
    ["-l", "printf 'status\\npush origin HEAD:main' | xargs -l git", [["status"], PUSH]],
    ["--max-lines=1", "printf 'status\\npush origin HEAD:main' | xargs --max-lines=1 git", [["status"], PUSH]],
    ["-L2", "printf 'a\\nb\\nc' | xargs -L2 git", [["a", "b"], ["c"]]],
    ["-n 3", "printf 'status a b push origin HEAD:main' | xargs -n 3 git", [["status", "a", "b"], PUSH]],
    ["-n3", "printf 'status a b push origin HEAD:main' | xargs -n3 git", [["status", "a", "b"], PUSH]],
    ["--max-args=3", "printf 'status a b push origin HEAD:main' | xargs --max-args=3 git", [["status", "a", "b"], PUSH]],
  ])("splits the input under %s", (_how, command, expected) => {
    expect(gitArgs(command)).toEqual(expect.arrayContaining(expected));
  });

  it("keeps a single batch as one command", () => {
    expect(gitArgs("printf 'status' | xargs -L1 git")).toEqual([["status"]]);
    expect(gitArgs("printf 'status\\nlog' | xargs -L 5 git")).toEqual([["status", "log"]]);
  });

  it("reads every contiguous run of words when the size is not static", () => {
    const runs = gitArgs("printf 'status\\npush origin' | xargs -L \"$N\" git");

    expect(runs).toEqual(expect.arrayContaining([["status", "push", "origin"], ["status"], ["status", "push"], ["push", "origin"], ["origin"]]));
  });

  it.each([
    ["-rL1", "printf 'status\\npush origin HEAD:main' | xargs -rL1 git"],
    ["-tL1", "printf 'status\\npush origin HEAD:main' | xargs -tL1 git"],
    ["--max-args 3", "printf 'status a b push origin HEAD:main' | xargs --max-args 3 git"],
    ["-rn3", "printf 'status a b push origin HEAD:main' | xargs -rn3 git"],
    ["-n with a size that is not static", "printf 'a b c push origin HEAD:main' | xargs -n \"$N\" git"],
    ["-L with a size that is not static", "printf 'x\\ny\\npush\\norigin HEAD:main' | xargs -L \"$N\" git"],
    ["quoted input", "printf 'a \"b c\" d push origin HEAD:main' | xargs -n 3 git"],
  ])("reads a push under %s", (_how, command) => {
    expect(gitArgs(command)).toContainEqual(PUSH);
  });

  it("joins a line ending in a blank with the next, as -L does", () => {
    expect(gitArgs("printf 'push \\norigin HEAD:main' | xargs -L1 git")).toContainEqual(PUSH);
    expect(gitArgs("printf 'x\\npush \\norigin HEAD:main' | xargs -L1 git")).toContainEqual(PUSH);
  });

  it("keeps the whole input as one command alongside the batches", () => {
    expect(gitArgs("printf 'a\\nb' | xargs -L1 git")).toContainEqual(["a", "b"]);
  });

  it("reads -eL1 as an end-of-file string, not a batch size", () => {
    expect(gitArgs("printf 'push\\norigin HEAD:main' | xargs -eL1 git")).toContainEqual(PUSH);
  });

  it("reads a protected utility's unknown stdin without -I as its worst case", () => {
    expect(gitArgs("xargs -L1 git < cmds.txt")).toContainEqual(PUSH);
    expect(gitArgs("xargs git add < files.txt")).not.toContainEqual(PUSH);
  });

  it("appends everything when no batch is named", () => {
    expect(gitArgs("printf 'a\\nb' | xargs git")).toEqual([["a", "b"]]);
  });
});

describe("how a command joins its list", () => {
  it("records the operator before each command and whether ! negates it", () => {
    const cmds = extract("! a && b || c");

    expect(cmds.map((c) => [c.name, c.prev, c.negated])).toEqual([["a", null, true], ["b", "&&", false], ["c", "||", false]]);
  });

  it("carries ! to every command of the pipeline it negates, and no further", () => {
    expect(extract("! a | b |& c && d").map((c) => [c.name, c.negated])).toEqual([["a", true], ["b", true], ["c", true], ["d", false]]);
  });

  it("shares a chain only across commands joined by &&", () => {
    const [a, b, c, d] = extract("a && b && c; d");

    expect(a?.chain).toBe(b?.chain);
    expect(b?.chain).toBe(c?.chain);
    expect(d?.chain).not.toBe(c?.chain);
  });

  it("starts a new chain after an operator on a command it does not emit", () => {
    const [a, b] = extract("a && X=1 || b");

    expect(b?.chain).not.toBe(a?.chain);
    expect(b?.chain.start).toBe("||");
  });
});
