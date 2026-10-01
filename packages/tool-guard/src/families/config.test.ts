import { describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifiedAction, ClassifyContext } from "../types.js";

const HOME = "/home/you";
const REPO = "/home/you/projects/app";

function fakeContext(links: Record<string, string> = {}): ClassifyContext {
  return { home: HOME, readLink: (p) => links[p] ?? null, readScript: () => null };
}

const meta = (toolName: string) => ({ toolName, cwd: REPO, sessionId: null, toolUseId: null });

function bash(command: string): ClassifiedAction[] {
  return classify({ kind: "bash", command, ...meta("Bash") }, fakeContext());
}

function write(toolName: string, path: string, ctx = fakeContext()): ClassifiedAction[] {
  return classify({ kind: "write", path, ...meta(toolName) }, ctx);
}

const spellings = (actions: ClassifiedAction[]) => actions.map((a) => a.spelling);

describe("write.config", () => {
  it.each([
    ["Write", "/home/you/.claude/settings.json", "any:.claude/settings"],
    ["Edit", "/home/you/projects/app/.claude/settings.local.json", "any:.claude/settings"],
    ["MultiEdit", "/home/you/.claude/hooks/guard.sh", "any:.claude/hooks"],
    ["Write", "/home/you/.claude-profiles/work/settings.json", "home:.claude-profiles/settings"],
    ["Edit", "/home/you/.claude.json", "home:.claude.json"],
    ["Edit", "/home/you/.claude/CLAUDE.md", "home:.claude/CLAUDE.md"],
    ["Write", "/home/you/CLAUDE.md", "home:CLAUDE.md"],
    ["Write", "/home/you/.agent-chat/config.json", "home:.agent-chat/config.json"],
    ["Write", "/home/you/.agent-chat/profiles/worker.json", "home:.agent-chat/profiles"],
    ["Write", "/home/you/projects/app/.git/hooks/pre-push", "any:.git/hooks"],
    ["Write", "/home/you/.config/titan-egress/private-terms", "home:egress-terms"],
    ["Edit", "/etc/claude-code/managed-settings.json", "managed-settings:linux"],
    ["NotebookEdit", ".claude/settings.json", "any:.claude/settings"],
  ])("%s of %s", (toolName, path, pattern) => {
    expect(write(toolName, path)).toEqual([expect.objectContaining({ action: "authority-config", spelling: "write.config", subject: { pattern } })]);
  });

  it("classifies a write through a symlink to a config path", () => {
    const ctx = fakeContext({ "/tmp/s.json": "/home/you/.claude/settings.json" });

    expect(spellings(write("Write", "/tmp/s.json", ctx))).toEqual(["write.config"]);
  });

  it.each([
    ["a memory directory", "/home/you/.claude/projects/-home-you-projects-app/memory/note.md"],
    ["a repository CLAUDE.md", "/home/you/projects/app/CLAUDE.md"],
    ["a skill", "/home/you/.claude/skills/review/SKILL.md"],
    ["an ordinary source file", "/home/you/projects/app/src/settings.json"],
  ])("classifies nothing for a write to %s", (_what, path) => {
    expect(write("Write", path)).toEqual([]);
  });
});

describe("one fixture per bash.config spelling", () => {
  it.each([
    ["bash.config.redirect-out", "echo '{}' > ~/.claude/settings.json"],
    ["bash.config.redirect-out", "echo x >> ~/.claude/settings.local.json"],
    ["bash.config.redirect-out", "make &> ~/.claude.json"],
    ["bash.config.redirect-out", "echo x >| ~/CLAUDE.md"],
    ["bash.config.tee", "jq '.hooks = {}' s.json | tee ~/.claude/settings.json"],
    ["bash.config.cp-mv-ln", "cp /tmp/s.json ~/.claude/settings.json"],
    ["bash.config.cp-mv-ln", "cp /tmp/settings.json ~/.claude/"],
    ["bash.config.cp-mv-ln", "mv ~/.claude/hooks/guard.sh /tmp/"],
    ["bash.config.cp-mv-ln", "install -m 755 guard.sh ~/.claude/hooks/guard.sh"],
    ["bash.config.cp-mv-ln", "ln -sf /tmp/s.json ~/.claude/settings.json"],
    ["bash.config.cp-mv-ln", "cp -t ~/.agent-chat/profiles worker.json"],
    ["bash.config.in-place", "sed -i '' 's/deny/allow/' ~/.claude/settings.json"],
    ["bash.config.in-place", "gsed -i 's/a/b/' ~/.claude/settings.json"],
    ["bash.config.in-place", "perl -pi -e 's/a/b/' ~/.claude/settings.json"],
    ["bash.config.remove", "rm ~/.claude/hooks/guard.sh"],
    ["bash.config.remove", "truncate -s 0 ~/.claude/settings.json"],
    ["bash.config.remove", "chmod -x ~/.claude/hooks/guard.sh"],
    ["bash.config.interpreter", `python3 -c "open('/home/you/.claude/settings.json', 'w').write('{}')"`],
    ["bash.config.interpreter", "node <<EOF\nfs.writeFileSync('/home/you/.claude/settings.json', '{}')\nEOF"],
    ["bash.config.git-hooks", "echo 'exit 0' > .git/hooks/pre-push"],
    ["bash.config.git-hooks", "rm .git/hooks/pre-commit"],
    ["bash.config.git-hooks", "cp /tmp/noop .git/hooks/pre-push"],
    ["bash.config.git-config-hookspath", "git config core.hooksPath /dev/null"],
    ["bash.config.git-config-hookspath", "git -C /home/you/projects/app config --global core.hooksPath x"],
    ["bash.config.claude-cli", "claude config set -g autoUpdates false"],
    ["bash.config.claude-cli", "claude mcp add server npx server"],
    ["bash.config.claude-cli", "claude plugin uninstall guard"],
    ["bash.config.mention", "vim ~/.claude/settings.json"],
  ])("%s: %s", (spelling, command) => {
    expect(bash(command)).toContainEqual(expect.objectContaining({ action: "authority-config", spelling }));
  });
});

describe("config reads classify nothing", () => {
  it.each([
    "cat ~/.claude/settings.json",
    "jq .permissions ~/.claude/settings.json",
    "jq . < ~/.claude/settings.json",
    "python3 check.py < ~/.claude/settings.json",
    "diff ~/.claude/settings.json /tmp/s.json",
    "grep -n hooks ~/.claude/settings.json",
    "sed -n 1,5p ~/.claude/settings.json",
    "cp ~/.claude/settings.json /tmp/backup.json",
    "ls ~/.claude/hooks",
    "git config --get core.hooksPath",
    "claude mcp list",
    "claude -p 'summarise the diff'",
    "echo x > /home/you/projects/app/CLAUDE.md",
  ])("%s", (command) => {
    expect(bash(command)).toEqual([]);
  });
});
