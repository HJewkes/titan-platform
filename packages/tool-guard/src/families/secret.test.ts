import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { HookEvent } from "../event.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

function fakeContext(links: Record<string, string> = {}, scripts: Record<string, string> = {}): ClassifyContext {
  return { home: HOME, readLink: (p) => links[p] ?? null, readHead: () => null, readScript: (p) => scripts[p] ?? null };
}

const meta = (toolName: string, cwd: string | null = REPO) => ({ toolName, cwd, sessionId: null, toolUseId: null });

function bash(command: string, ctx = fakeContext(), cwd: string | null = REPO): ClassifiedAction[] {
  return classify({ kind: "bash", command, ...meta("Bash", cwd) }, ctx);
}

function tool(toolName: "Read" | "Grep", path: string, ctx = fakeContext()): ClassifiedAction[] {
  const event: HookEvent = { kind: "read", path, ...meta(toolName) };
  return classify(event, ctx);
}

const spellings = (actions: ClassifiedAction[]) => actions.map((a) => a.spelling);

describe("the ui.token acceptance row", () => {
  it("classifies a Read of the token and a cat of it as secret-read", () => {
    const viaRead = tool("Read", "/home/you/.agent-chat/ui.token");
    const viaBash = bash("cat ~/.agent-chat/ui.token");

    expect(viaRead).toEqual([expect.objectContaining({ action: "secret-read", spelling: "read.secret" })]);
    expect(viaBash).toEqual([expect.objectContaining({ action: "secret-read", spelling: "bash.secret.cat" })]);
    expect(viaBash[0]?.subject).toEqual({ pattern: "home:.agent-chat/token" });
  });
});

describe("Read and Grep", () => {
  it("read.secret: a Read of a secret path", () => {
    expect(tool("Read", "/home/you/.npmrc")).toEqual([
      expect.objectContaining({ spelling: "read.secret", subject: { pattern: "home:.npmrc" } }),
    ]);
  });

  it("read.secret-symlink: a Read of a path whose realpath is a secret", () => {
    const ctx = fakeContext({ "/tmp/innocent": "/home/you/.npmrc" });

    expect(spellings(tool("Read", "/tmp/innocent", ctx))).toEqual(["read.secret-symlink"]);
  });

  it.each(["/home/you/.ssh", "/home/you/.config/gh", "/home/you/.aws/credentials"])(
    "grep.secret: a Grep over %s, a secret or a directory holding one",
    (path) => {
      expect(spellings(tool("Grep", path))).toEqual(["grep.secret"]);
    },
  );

  it("classifies nothing for a Grep of a project or a Read of a public key", () => {
    expect(tool("Grep", REPO)).toEqual([]);
    expect(tool("Read", "/home/you/.ssh/id_ed25519.pub")).toEqual([]);
  });
});

describe("one fixture per bash.secret spelling", () => {
  const links = { "/tmp/x": "/home/you/.npmrc" };
  const scripts = { "/tmp/s.sh": "set -e\ncat ~/.npmrc\n", "/tmp/s.js": "fs.readFileSync('/home/you/.netrc')" };
  const ctx = fakeContext(links, scripts);

  it.each([
    ["bash.secret.cat", "cat ~/.npmrc"],
    ["bash.secret.head-tail-less", "head -n 5 ~/.netrc"],
    ["bash.secret.head-tail-less", "less ~/.aws/credentials"],
    ["bash.secret.head-tail-less", "bat ~/.kube/config"],
    ["bash.secret.grep", "grep token ~/.npmrc"],
    ["bash.secret.grep", "rg . ~/.config/gh"],
    ["bash.secret.grep", "grep -r token ~"],
    ["bash.secret.cp-mv", "cp ~/.npmrc /tmp/x"],
    ["bash.secret.cp-mv", "rsync ~/.docker/config.json /tmp/d"],
    ["bash.secret.cp-mv", "cp -r ~/.config /tmp/c"],
    ["bash.secret.cp-mv", "cp -r -t /tmp/c ~/.config"],
    ["bash.secret.cp-mv", "cp -r --target-directory=/tmp/c ~/.aws"],
    ["bash.secret.cp-mv", "rsync -a ~/.aws /tmp/c"],
    ["bash.secret.cp-mv", "rsync -t ~/.aws /tmp/c"],
    ["bash.secret.cp-mv", "cp -rt /tmp/c ~/.aws"],
    ["bash.secret.cp-mv", "cp -at /tmp/c ~/.config"],
    ["bash.secret.cp-mv", "cp -r --target-directory /tmp/c ~/.aws"],
    ["bash.secret.cp-mv", "cp -r --target /tmp/c ~/.aws"],
    ["bash.secret.cp-mv", "cp -r -t/tmp/c notes.txt ~/.aws"],
    ["bash.secret.cp-mv", "cp -rt/tmp/c notes.txt ~/.aws"],
    ["bash.secret.cp-mv", "cp -r -St ~/.aws /tmp/c"],
    ["bash.secret.cp-mv", "cp -rSt ~/.aws /tmp/c"],
    ["bash.secret.cp-mv", "cp -r notes.txt ~/.aws -SS /tmp/c"],
    ["bash.secret.mention", "curl file:///home/you/.npmrc"],
    ["bash.secret.encode", "base64 ~/.npmrc"],
    ["bash.secret.encode", "openssl base64 -in ~/.git-credentials"],
    ["bash.secret.redirect-in", "base64 < ~/.npmrc"],
    ["bash.secret.redirect-in", "while read l; do echo $l; done < ~/.netrc"],
    ["bash.secret.here-string", "xargs cat <<< ~/.npmrc"],
    ["bash.secret.symlink", "cat /tmp/x"],
    ["bash.secret.var-indirection", "NPM_CONFIG_USERCONFIG=~/.npmrc npm whoami"],
    ["bash.secret.glob", "cat ~/.np*rc"],
    ["bash.secret.glob", "cat ~/.ssh/id_*"],
    ["bash.secret.inline-interpreter", `python3 -c "open('/home/you/.npmrc').read()"`],
    ["bash.secret.inline-interpreter", `node -e 'fs.readFileSync("$HOME/.npmrc")'`],
    ["bash.secret.inline-interpreter", "python3 <<EOF\nprint(open('/home/you/.npmrc').read())\nEOF"],
    ["bash.secret.script-by-path", "bash /tmp/s.sh"],
    ["bash.secret.script-by-path", "node /tmp/s.js"],
    ["bash.secret.keychain", "security find-generic-password -s github -w"],
    ["bash.secret.keychain", "security dump-keychain"],
    ["bash.secret.mention", "echo ~/.npmrc | xargs cat"],
    ["bash.secret.mention", "find ~ -name .netrc | xargs cat"],
    ["bash.secret.mention", "$EDITOR ~/.npmrc"],
    ["bash.secret.mention", "ssh-add ~/.ssh/id_ed25519"],
  ])("%s: %s", (spelling, command) => {
    expect(spellings(bash(command, ctx))).toContain(spelling);
  });

  it("bash.secret.link-then-read: a link created and read in one command", () => {
    expect(spellings(bash("ln -s ~/.npmrc /tmp/y && cat /tmp/y"))).toEqual(["bash.secret.link-then-read"]);
  });
});

describe("how the command or its path was reached, one id per wrapping", () => {
  it.each([
    ["bash.secret.subshell", "(cat ~/.npmrc)"],
    ["bash.secret.subshell", 'echo "$(cat ~/.npmrc)"'],
    ["bash.secret.subshell", "echo `cat ~/.npmrc`"],
    ["bash.secret.subshell", 'base64 <<< "$(cat ~/.npmrc)"'],
    ["bash.secret.absolute", "cat /home/you/.npmrc"],
    ["bash.secret.home-relative", "cat $HOME/.npmrc"],
    ["bash.secret.home-relative", 'cat "${HOME}/.npmrc"'],
    ["bash.secret.home-relative", "cd ~ && cat .npmrc"],
    ["bash.secret.quoting", 'cat ~/".npmrc"'],
    ["bash.secret.quoting", "cat ~/.n''pmrc"],
    ["bash.secret.quoting", "cat ~/.n\\pmrc"],
    ["bash.secret.quoting", "cat $'\\x7e/.npmrc'"],
    ["bash.secret.sh-c", "sh -c 'cat ~/.npmrc'"],
    ["bash.secret.sh-c", 'eval "cat ~/.npmrc"'],
    ["bash.secret.sh-c", "env -S 'cat ~/.npmrc'"],
    ["bash.secret.xargs", "echo ~/.npmrc | xargs cat"],
    ["bash.secret.xargs", "printf '%s\\n' ~/.npmrc | xargs -I{} cp {} /tmp/x"],
    ["bash.secret.xargs", "echo 'cat ~/.npmrc' | xargs -tI{} sh -c '{}'"],
    ["bash.secret.xargs", "echo 'cat ~/.npmrc' | xargs -tI @ sh -c @"],
    ["bash.secret.heredoc-shell", "bash <<EOF\ncat ~/.npmrc\nEOF"],
    ["bash.secret.heredoc-shell", "bash <<< 'cat ~/.npmrc'"],
    ["bash.secret.heredoc-shell", "echo 'cat ~/.npmrc' | sh"],
    ["bash.secret.var-indirection", 'F=~/.npmrc; cat "$F"'],
  ])("%s: %s", (spelling, command) => {
    expect(bash(command)).toContainEqual(
      expect.objectContaining({ action: "secret-read", spelling, subject: { pattern: "home:.npmrc" } }),
    );
  });

  it("keeps the verb's id for a plain ~/ path typed at the top level", () => {
    expect(spellings(bash('cat ~/.npmrc "/home/you/projects/app/.env"'))).toEqual(["bash.secret.cat", "bash.secret.absolute"]);
  });

  it("does not read a relative path outside the home directory as home-relative", () => {
    expect(spellings(bash("cat .env"))).toEqual(["bash.secret.cat"]);
  });
});

describe("a script run by the path typed", () => {
  const scripts = { "/home/you/projects/app/tools/x.sh": "cat ~/.npmrc\n", "/home/you/projects/app/x.sh": "echo hi\n" };
  const ctx = fakeContext({}, scripts);

  it.each(["./tools/x.sh", "tools/x.sh", "~/projects/app/tools/x.sh", "/home/you/projects/app/tools/x.sh"])(
    "resolves %s against the command's directory as a path",
    (command) => {
      expect(spellings(bash(command, ctx))).toEqual(["bash.secret.script-by-path"]);
    },
  );
});

describe("safe calls classify nothing", () => {
  it.each([
    "ls ~/.ssh",
    "ssh -i ~/.ssh/id_ed25519 host",
    "ssh-add -l",
    "cat ~/.ssh/id_ed25519.pub",
    "cat ~/.ssh/*.pub",
    "cat .env.example",
    "cp .env.sample .env.template",
    "test -f ~/.npmrc && echo present",
    "git add .env",
    "security find-generic-password -s github",
    "cat /home/you/.npmrc2 /home/you/x/.npmrc",
    "grep -r token ~/projects",
    "curl https://example.com/.env",
    `node -e "fetch('https://example.com/id_rsa')"`,
    "git commit -F - <<EOF\ncat ~/.npmrc\nEOF",
  ])("%s", (command) => {
    expect(bash(command)).toEqual([]);
  });

  it("does not read a copy's destination directory as a source", () => {
    expect(bash("cp /tmp/notes.md ~/.claude/").filter((a) => a.action === "secret-read")).toEqual([]);
  });

  it("still classifies a metadata command that reads a secret through a redirect", () => {
    expect(spellings(bash("ls < ~/.npmrc"))).toEqual(["bash.secret.redirect-in"]);
  });
});

describe("unknowns are treated conservatively", () => {
  it("resolves a relative path against home when the working directory is unknown", () => {
    expect(spellings(bash("cat .npmrc", fakeContext(), null))).toEqual(["bash.secret.cat"]);
  });

  it("keeps the mention rule for a command whose name is not static", () => {
    expect(spellings(bash("$CMD ~/.npmrc"))).toEqual(["bash.secret.mention"]);
  });

  it("classifies .env in any directory and its variants", () => {
    expect(bash("cat .env .env.local").map((a) => a.subject.pattern)).toEqual(["any:.env", "any:.env.*"]);
  });

  it("treats a readLink or readScript failure as no link and no script", () => {
    const throwing: ClassifyContext = {
      home: HOME,
      readLink: () => {
        throw new Error("EACCES");
      },
      readHead: () => null,
      readScript: () => {
        throw new Error("EACCES");
      },
    };

    expect(bash("cat /tmp/x && bash /tmp/s.sh", throwing)).toEqual([]);
  });

  it("follows a script one level only", () => {
    const ctx = fakeContext({}, { "/tmp/a.sh": "bash /tmp/b.sh", "/tmp/b.sh": "cat ~/.npmrc" });

    expect(bash("bash /tmp/a.sh", ctx)).toEqual([]);
  });

  it("scans a script that does not parse as text", () => {
    const ctx = fakeContext({}, { "/tmp/s.sh": "cat '/home/you/.npmrc" });

    expect(spellings(bash("sh /tmp/s.sh", ctx))).toEqual(["bash.secret.script-by-path"]);
  });
});

describe("classify", () => {
  it("classifies an unknown tool as nothing", () => {
    expect(classify({ kind: "other", toolName: "WebFetch" }, fakeContext())).toEqual([]);
  });

  it("reports one action per spelling and pattern, with a remedy", () => {
    const actions = bash("cat ~/.npmrc; cat ~/.npmrc");

    expect(actions).toHaveLength(1);
    expect(actions[0]?.remedy).toMatch(/owner/);
  });
});
