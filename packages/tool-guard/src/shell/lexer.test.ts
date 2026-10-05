import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";
import { parseGit, splitArgs } from "./git.js";
import { ParseError, tokenize } from "./lexer.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

const show = (w: WordToken) => (w.computed ? "<computed>" : w.value);

/** Each git invocation as `sub args...`, in the order the shell would run them. */
function gitLines(src: string): string[] {
  return extractCommands(src, { cwd: REPO, home: HOME })
    .filter((c) => c.name === "git")
    .map((c) => {
      const inv = parseGit(c.args, c.dir, HOME);
      return [inv.sub ?? "<none>", ...inv.subArgs.map(show)].join(" ");
    });
}

const redirects = (tokens: Token[]) => tokens.filter((t): t is RedirectToken => t.type === "redirect");

// Ported from git-safety's evaluate cases: the parsing each rule relied on, without the rules.
const GIT_SAFETY_CASES: Array<[string, string, string[]]> = [
  ["force push to main", "git push --force origin main", ["push --force origin main"]],
  ["-f push to master", "git push -f origin master", ["push -f origin master"]],
  ["+refspec to main", "git push origin +main", ["push origin +main"]],
  ["full ref", "git push origin HEAD:refs/heads/release/2.0 --force", ["push origin HEAD:refs/heads/release/2.0 --force"]],
  ["dynamic branch", 'git push --force-with-lease origin "$BRANCH"', ["push --force-with-lease origin $BRANCH"]],
  ["force push of all branches", "git push --force --all origin", ["push --force --all origin"]],
  ["bare --force", "git push --force", ["push --force"]],
  ["bundled -uf", "git push -uf origin feat/x", ["push -uf origin feat/x"]],
  ["lease with expect value", "git push --force-with-lease=feat/x:abc123 origin feat/x", ["push --force-with-lease=feat/x:abc123 origin feat/x"]],
  ["mirror push", "git push --mirror backup", ["push --mirror backup"]],
  ["delete by :refspec", "git push origin :master", ["push origin :master"]],
  ["push option value", "git push -o ci.skip origin main", ["push -o ci.skip origin main"]],
  ["reset --hard", "git reset --hard HEAD~1", ["reset --hard HEAD~1"]],
  ["clean exclude", "git clean -e '*.log' -n", ["clean -e *.log -n"]],
  ["checkout -- .", "git checkout -- .", ["checkout -- ."]],
  ["restore from a source", "git restore --source=HEAD~2 .", ["restore --source=HEAD~2 ."]],
  ["stash message named drop", "git stash -m drop", ["stash -m drop"]],
  ["rebase -i", "git rebase -i HEAD~3", ["rebase -i HEAD~3"]],
  ["scripted editor", "GIT_SEQUENCE_EDITOR=true git rebase -i HEAD~3", ["rebase -i HEAD~3"]],
  ["after &&", "npm test && git push --force origin main", ["push --force origin main"]],
  ["after ||", "git status || git push --force origin main", ["status", "push --force origin main"]],
  ["between semicolons", "echo hi; git push --force origin main; ls", ["push --force origin main"]],
  ["in a pipeline", "git log | git push --force origin main", ["log", "push --force origin main"]],
  ["in a subshell", "(git push --force origin main)", ["push --force origin main"]],
  ["in bash -c", 'bash -c "git push --force origin main"', ["push --force origin main"]],
  ["in sh -lc", "sh -lc 'git push --force origin main'", ["push --force origin main"]],
  ["behind env", "env FOO=1 git push --force origin main", ["push --force origin main"]],
  ["behind assignments", "FOO=1 BAR=2 git push --force origin main", ["push --force origin main"]],
  ["behind command", "command git push --force origin main", ["push --force origin main"]],
  ["behind sudo", "sudo -u deploy git push --force origin main", ["push --force origin main"]],
  ["behind xargs", "echo | xargs git push --force origin main", ["push --force origin main"]],
  ["with -C", "git -C ../other push --force origin main", ["push --force origin main"]],
  ["with -c and --no-pager", "git -c core.quotepath=off --no-pager push --force origin main", ["push --force origin main"]],
  ["absolute git path", "/usr/bin/git push --force origin main", ["push --force origin main"]],
  ["in a quoted substitution", 'echo "$(git push --force origin main)"', ["push --force origin main"]],
  ["in backticks", "echo `git rebase -i HEAD~3`", ["rebase -i HEAD~3"]],
  ["in eval", 'eval "git rebase -i HEAD~3"', ["rebase -i HEAD~3"]],
  ["inside if", "if git diff --quiet; then git push --force origin main; fi", ["diff --quiet", "push --force origin main"]],
  ["across a line continuation", "git push \\\n  --force origin main", ["push --force origin main"]],
  ["two commands", "git push --force origin main && git rebase -i HEAD~3", ["push --force origin main", "rebase -i HEAD~3"]],
  ["echo of the text", 'echo "git push --force origin main"', []],
  ["grep for the text", "grep 'branch -D' notes.md", []],
  ["commit message mentioning it", 'git commit -m "undo the git reset --hard mistake"', ["commit -m undo the git reset --hard mistake"]],
  [
    "heredoc commit message with apostrophe",
    "git commit -m \"$(cat <<'EOF'\nDon't (ever) git push --force origin main\nEOF\n)\"",
    ["commit -m <computed>"],
  ],
  ["log grep for it", 'git log --grep="push --force"', ["log --grep=push --force"]],
  ["trailing comment", "ls # git push --force origin main", []],
  ["comment containing an operator", "ls # tidy; git push --force origin main", []],
  ["heredoc body", "cat <<EOF > notes.txt\ngit push --force origin main\nEOF", []],
  ["printf of the text", "printf '%s\\n' 'git push --force'", []],
  ["command -v git", "command -v git", []],
];

describe("git-safety parsing cases", () => {
  it.each(GIT_SAFETY_CASES)("%s", (_scenario, src, expected) => {
    expect(gitLines(src)).toEqual(expected);
  });

  it("resolves -C against the working directory and records -c overrides", () => {
    const [cmd] = extractCommands("git -C ../other -c core.editor=true push", { cwd: REPO, home: HOME });

    const inv = parseGit(cmd?.args ?? [], cmd?.dir ?? null, HOME);

    expect(inv).toMatchObject({ dir: "/home/you/projects/other", config: ["core.editor=true"], sub: "push" });
  });

  it("records --git-dir so the working directory alone no longer locates the repository", () => {
    const [cmd] = extractCommands("git --git-dir=~/elsewhere/.git status", { cwd: REPO, home: HOME });

    expect(parseGit(cmd?.args ?? [], REPO, HOME).otherPaths).toEqual(["/home/you/elsewhere/.git"]);
  });

  it("splits short clusters, value options and --flag=value the way git reads them", () => {
    const [cmd] = extractCommands("git push -uf -o ci.skip --force-with-lease=feat/x:abc origin feat/x");
    const { subArgs } = parseGit(cmd?.args ?? [], null);

    const { flags, positionals } = splitArgs(subArgs, new Set(["-o"]));

    expect([...flags].sort()).toEqual(["--force-with-lease", "-f", "-o", "-u"]);
    expect(positionals.map((p) => p.value)).toEqual(["origin", "feat/x"]);
  });
});

describe("redirections", () => {
  it("keeps the target of an input redirect", () => {
    expect(redirects(tokenize("base64 < x"))).toEqual([
      expect.objectContaining({ op: "<", fd: null, target: expect.objectContaining({ value: "x" }) }),
    ]);
  });

  it("keeps output targets with their file descriptor, and none of them become words", () => {
    const tokens = tokenize("cmd 2> err.log >> ~/.x &> both");

    expect(redirects(tokens).map((r) => [r.op, r.fd, r.target?.value])).toEqual([
      [">", "2", "err.log"],
      [">>", null, "~/.x"],
      ["&>", null, "both"],
    ]);
    expect(tokens.filter((t) => t.type === "word").map((t) => (t as WordToken).value)).toEqual(["cmd"]);
  });

  it("keeps a here-string's word as its target", () => {
    expect(redirects(tokenize("base64 <<< hello"))[0]).toMatchObject({ op: "<<<", target: { value: "hello" } });
  });
});

describe("heredocs", () => {
  it("keeps the body of a heredoc fed to a shell", () => {
    const [heredoc] = redirects(tokenize("bash <<EOF\ncat ~/.x\nEOF\n"));

    expect(heredoc).toMatchObject({ op: "<<", target: { value: "EOF" }, body: "cat ~/.x\n" });
  });

  it("attaches a commit message body without parsing it as commands", () => {
    const src = "git commit -F - <<'EOF'\ngh pr merge 1 --squash\nEOF";

    const commands = extractCommands(src);

    expect(commands.map((c) => c.name)).toEqual(["git"]);
    expect(commands[0]?.redirects[0]).toMatchObject({ body: "gh pr merge 1 --squash\n" });
  });

  it("strips leading tabs from body lines and the delimiter for <<-", () => {
    const [heredoc] = redirects(tokenize("cat <<-END\n\tline\n\tEND\n"));

    expect(heredoc?.body).toBe("line\n");
  });
});

describe("words split by quoting", () => {
  it.each([
    ["a double-quoted part after text", 'cat ~/".x"', true],
    ["an empty single-quoted part", "cat .n''x", true],
    ["a backslash escape", "cat .n\\x", true],
    ["an ANSI-C string", "cat $'.x'", true],
    ["text after a quoted part", "cat \".\"x", true],
    ["a word quoted whole", 'cat "/home/you/.x"', false],
    ["a plain word", "cat ~/.x", false],
  ])("marks %s", (_how, src, spliced) => {
    expect(tokenize(src)[1]).toMatchObject({ type: "word", spliced });
  });
});

describe("ANSI-C strings", () => {
  it.each([
    ["$'\\x7e/.npmrc'", "~/.npmrc"],
    ["$'\\176/.np\\x6drc'", "~/.npmrc"],
    ["$'\\u007e/.npmrc'", "~/.npmrc"],
    ["$'a\\tb\\'c'", "a\tb'c"],
    ["~/$'\\x2e'npmrc", "~/.npmrc"],
  ])("decodes %s", (src, value) => {
    expect(tokenize(src)).toEqual([expect.objectContaining({ type: "word", value, dynamic: false })]);
  });

  it("decodes $'...' after a double-quoted part of the same word", () => {
    expect(tokenize(`"a"$'\\x62'`)).toEqual([expect.objectContaining({ type: "word", value: "ab" })]);
  });

  it("keeps $' literal inside double quotes", () => {
    expect(tokenize(`echo "$'x'"`)).toEqual([
      expect.objectContaining({ value: "echo" }),
      expect.objectContaining({ type: "word", value: "$'x'", dynamic: false }),
    ]);
  });

  it("does not let a double-quoted $' swallow the commands after it", () => {
    const src = `echo "$'" ; git push origin HEAD:main ; echo "'"`;

    expect(gitLines(src)).toEqual(["push origin HEAD:main"]);
  });
});

describe("subscripts with blanks inside the brackets", () => {
  const words = (src: string) => tokenize(src).map((t) => (t.type === "word" ? t.value : `<${t.type}>`));

  it.each([
    ["a prefix assignment", "Y[ 0 ]=x git push origin HEAD:main", ["Y[ 0 ]=x", "git", "push", "origin", "HEAD:main"]],
    ["an append", "Y[ 1 ]+=x", ["Y[ 1 ]+=x"]],
    ["an assignment after another", "A=1 Y[ 0 ]=x git", ["A=1", "Y[ 0 ]=x", "git"]],
    ["an assignment after an operator", "Y=status; Y[ 0 ]=push", ["Y=status", "<op>", "Y[ 0 ]=push"]],
    ["an assignment after a reserved word", "if true; then Y[ 0 ]=x git; fi", ["if", "true", "<op>", "then", "Y[ 0 ]=x", "git", "<op>", "fi"]],
    ["an operator inside the brackets", "Y[ 0;1 ]=x git", ["Y[ 0;1 ]=x", "git"]],
    ["a quoted bracket inside the brackets", "Y[ ']' ]=x git", ["Y[ ] ]=x", "git"]],
    ["an escaped bracket inside the brackets", "Y[ \\] ]=x git", ["Y[ ] ]=x", "git"]],
    ["a nested subscript", "Y[ a[ 1 ] ]=x git", ["Y[ a[ 1 ] ]=x", "git"]],
  ])("keeps %s as one word", (_how, src, expected) => {
    expect(words(src)).toEqual(expected);
  });

  it.each([
    ["the test command", "[ 0 ]", ["[", "0", "]"]],
    ["an argument", "echo Y[ 0 ]", ["echo", "Y[", "0", "]"]],
    ["an argument shaped like an assignment", "echo Y[ 0 ]=x", ["echo", "Y[", "0", "]=x"]],
    ["an unclosed bracket", "Y[ 0", ["Y[", "0"]],
    ["a bracket with no = after it", "Y[ 0 ] x", ["Y[", "0", "]", "x"]],
    ["a word that opens a subshell", "( Y[ 0 ]=x )", ["<op>", "Y[", "0", "]=x", "<op>"]],
    ["a reserved word after an assignment", "A=1 then Y[ 0 ]=x", ["A=1", "then", "Y[", "0", "]=x"]],
    ["a word after a redirect", ">/dev/null Y[ 0 ]=x", ["<redirect>", "Y[", "0", "]=x"]],
    ["a quoted assignment before it", 'A="1" Y[ 0 ]=x', ["A=1", "Y[", "0", "]=x"]],
    ["brackets whose $'..' string holds quotes", `Y[ $'\\'"' ]; echo "]=x"`, ["Y[", "'\"", "]", "<op>", "echo", "]=x"]],
    ["a case pattern after ;;", "case a in b) :;; Y[ 0 ]=x) :;; esac", ["case", "a", "in", "b", "<op>", ":", "<op>", "Y[", "0", "]=x", "<op>", ":", "<op>", "esac"]],
  ])("splits %s as before", (_how, src, expected) => {
    expect(words(src)).toEqual(expected);
  });

  it.each([
    ["case", "Y[ 0 ]=x case", ["Y[", "0", "]=x", "case"]],
    ["esac", "Y[ 0 ]=x esac", ["Y[", "0", "]=x", "esac"]],
    ["[[", "Y[ 0 ]=x [[", ["Y[", "0", "]=x", "[["]],
    ["]]", "Y[ 0 ]=x ]]", ["Y[", "0", "]=x", "]]"]],
    ["((", "Y[ 0 ]=x ((", ["Y[", "0", "]=x", "<op>", "<op>"]],
    ["))", "Y[ 0 ]=x ))", ["Y[", "0", "]=x", "<op>", "<op>"]],
    ["$((", "Y[ 0 ]=x $((1))", ["Y[", "0", "]=x", "$((1))"]],
    ["<<", "Y[ 0 ]=x <<E\nE\n", ["Y[", "0", "]=x", "<redirect>", "<op>"]],
    ["<<-", "Y[ 0 ]=x <<-E\nE\n", ["Y[", "0", "]=x", "<redirect>", "<op>"]],
  ])("splits as before when the text holds %s anywhere", (_token, src, expected) => {
    expect(words(src)).toEqual(expected);
  });
});

describe("variable references", () => {
  it("records plain references and marks substitutions as computed", () => {
    const [plain, braced, computed] = tokenize('"$F" ${HOME}/x "$(pwd)"') as WordToken[];

    expect(plain).toMatchObject({ value: "$F", computed: false, refs: [{ name: "F", start: 0, end: 2 }] });
    expect(braced).toMatchObject({ value: "${HOME}/x", computed: false, refs: [{ name: "HOME", start: 0, end: 7 }] });
    expect(computed).toMatchObject({ dynamic: true, computed: true });
  });

  it("treats a parameter expansion with an operator as computed", () => {
    expect(tokenize("${F:-x}")[0]).toMatchObject({ dynamic: true, computed: true });
  });
});

describe("parse errors", () => {
  it.each(["echo 'x", 'echo "x', "echo `x", "echo $(x", "echo $'x", "echo ${x"])("throws on %s", (src) => {
    expect(() => tokenize(src)).toThrow(ParseError);
  });
});
