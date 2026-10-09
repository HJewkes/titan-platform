import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classify } from "../classify.js";
import type { ClassifyContext } from "../types.js";
import { decide } from "../decide.js";
import { handle } from "../hook.js";
import type { HookPort } from "../hook.js";

const REPO = "/home/you/projects/app";

const context: ClassifyContext = {
  home: "/home/you",
  readLink: () => null,
  readHead: (dir) => (dir === REPO ? "main" : null),
  readScript: () => null,
};

const PUSH = "git push origin HEAD:main";

function classifyCommand(command: string): string[] {
  const event = { kind: "bash" as const, command, cwd: REPO, toolName: "Bash", sessionId: null, toolUseId: null };
  return classify(event, context).map((a) => a.spelling);
}

/** The hook's own verdict, which is what the agent meets: a ParseError passes unless the text names a guarded keyword. */
async function hookDenies(command: string): Promise<boolean> {
  const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
  const result = await handle(input, { PATH: "/usr/bin" }, port);
  return result.stdout !== "";
}

describe("a heredoc opened inside a process substitution", () => {
  it.each([
    ["<((cat <<EOF) )", "cat <((cat <<EOF) )"],
    [">((cat <<EOF) )", "cat >((cat <<EOF) )"],
    ["<( (cat <<EOF) )", "cat <( (cat <<EOF) )"],
    ["<(cat <<EOF)", "cat <(cat <<EOF)"],
    [">(cat <<EOF)", "cat >(cat <<EOF)"],
  ])("does not let a quote in the body of %s hide the push", async (_form, opener) => {
    const command = `${opener}\nit's\nEOF\n${PUSH}\necho \\'`;
    expect(await hookDenies(command)).toBe(true);
  });

  it("does not hide a push written in the body of a heredoc fed to a shell", async () => {
    expect(await hookDenies(`bash <(cat <<EOF)\n${PUSH}\nEOF\n`)).toBe(true);
  });

  it("keeps a heredoc whose body is inside the substitution", () => {
    expect(classifyCommand(`cat <(cat <<EOF\nbody\nEOF\n)\n${PUSH}`)).toContain("bash.merge.git-push-protected");
  });

  it("still reads a real arithmetic shift as a shift", () => {
    expect(classifyCommand(`(( x << 2 ))\n${PUSH}`)).toContain("bash.merge.git-push-protected");
  });

  it.each([
    ["a plain body", `cat <(cat <<EOF)\nbody\nEOF\n${PUSH}`],
    ["a diff operand after it", `diff <(cat <<EOF) file\nbody\nEOF\n${PUSH}`],
    ["a doubled opener", `cat <((cat <<EOF) )\nbody\nEOF\n${PUSH}`],
    ["an output substitution", `cat >(cat <<EOF)\nbody\nEOF\n${PUSH}`],
    ["a tab-stripping heredoc", `cat <(cat <<-EOF)\n\tbody\n\tEOF\n${PUSH}`],
    ["a single-quoted delimiter", `cat <(cat <<'EOF')\nbody\nEOF\n${PUSH}`],
    ["a double-quoted delimiter", `cat <(cat <<"EOF")\nbody\nEOF\n${PUSH}`],
    ["a nested substitution", `cat <(cat <(cat <<EOF))\nbody\nEOF\n${PUSH}`],
    ["a command substitution around it", `echo $(cat <(cat <<EOF))\nbody\nEOF\n${PUSH}`],
    ["a shell -c string", `bash -c 'cat <(cat <<EOF)\nbody\nEOF\n${PUSH}'`],
    ["a delimiter that never closes", `cat <(cat <<EOF)\nbody\n${PUSH}`],
    ["a body holding a closing parenthesis", `cat <(cat <<EOF)\nEOF)\nEOF\n${PUSH}`],
  ])("the hook denies a push after %s", async (_name, command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it("the hook denies a push after a pending heredoc that has a quote in its body", async () => {
    expect(await hookDenies(`cat <(cat <<EOF)\nit's\nEOF\n${PUSH}\necho \\'`)).toBe(true);
  });

  it("the hook denies a protected merge after a pending heredoc", async () => {
    expect(await hookDenies("cat <(cat <<EOF)\nbody\nEOF\ngh pr merge 1 --squash")).toBe(true);
  });

  it("the hook refuses a pending heredoc even with no push after it", async () => {
    expect(await hookDenies("cat <(cat <<EOF)\nbody\nEOF\nls")).toBe(true);
  });

  it("lexes three hundred pending heredocs without running away", async () => {
    const command = `${Array.from({ length: 300 }, () => "cat <(cat <<EOF)\nb\nEOF").join("\n")}\n${PUSH}`;
    expect(await hookDenies(command)).toBe(true);
  });

  it("the hook denies a push after a pending heredoc inside an arithmetic command that holds a quote in its body", async () => {
    expect(await hookDenies(`((cat <(cat <<EOF)) )\nit's\nEOF\n${PUSH}\necho \\'`)).toBe(true);
  });

  it("the hook denies a push after a pending heredoc inside an arithmetic command with a trailing command", async () => {
    expect(await hookDenies(`((cat <(cat <<EOF)); true )\nit's\nEOF\n${PUSH}\necho \\'`)).toBe(true);
  });

  it.each([
    ["an arithmetic expansion", "cat <(cat <<E)\nE\n$((1))\n"],
    ["a backtick substitution", "cat <(cat <<E)\nE\n`echo x`\n"],
    ["three arithmetic expansions", "cat <(cat <<E)\nE\necho $((2<<1)) $((3)) $((4))\n"],
  ])("the hook denies a push after eight kilobytes of pending heredocs with %s, in under 750 ms", async (_name, unit) => {
    const command = `${unit.repeat(Math.floor(7900 / unit.length))}${PUSH}`;
    const started = performance.now();
    const denied = await hookDenies(command);
    expect(performance.now() - started).toBeLessThan(750);
    expect(denied).toBe(true);
  });

  it.each([40, 80])("the hook denies a push when %i arithmetic openers sit in a quote only bash 3.2 opens", async (count) => {
    const command = `cat <(cat <<EOF)\nit's\nEOF\n${"((x\n".repeat(count)}x'\n(( a ))\n${PUSH}`;
    expect(await hookDenies(command)).toBe(true);
  });

  const NESTED = "$(echo ".repeat(8) + "x" + ")".repeat(8);

  it.each([
    ["on its own line", `echo ${NESTED}\n${PUSH}`],
    ["in the push's own argument", `${PUSH} ${NESTED}`],
    ["after another substitution", `echo <(cat <(cat <<F))\nb\nF\necho ${NESTED}\n${PUSH}`],
    ["inside double quotes", `echo "${NESTED}"\n${PUSH}`],
    ["inside a shell -c string", `bash -c "echo ${NESTED}"\n${PUSH}`],
  ])("the hook denies a push after a pending heredoc and substitutions nested to the limit %s", async (_name, rest) => {
    expect(await hookDenies(`cat <(cat <<EOF)\nbody\nEOF\n${rest}`)).toBe(true);
  });
});

describe("a line bash 5 reads differently because a substitution left a heredoc open", () => {
  const SWALLOW = `${PUSH}\n\\"'\n#"`;

  it.each([
    ["a heredoc opened after the substitution", `cat <(cat <<EOF) <<A\nA\nit"s\nEOF\nit's\nA\n${SWALLOW}`],
    ["a heredoc opened before the substitution", `cat <<A <(cat <<EOF)\nA\nit"s\nEOF\nit's\nA\n${SWALLOW}`],
    ["two process substitutions", `cat <(cat <<EOF) <(cat <<B)\nB\nit"s\nEOF\nit's\nB\n${SWALLOW}`],
    ["a substitution closed inside another", `cat <(cat <<B <(cat <<EOF))\nB\nit"s\nEOF\nit's\nB\n${SWALLOW}`],
    ["a command substitution", `echo $(cat <<EOF)\nit's\nEOF\n${PUSH}\necho \\'`],
    ["a command substitution then a process substitution", `echo $(cat <<EOF) <(cat <<B)\nB\nit"s\nEOF\nit's\nB\n${SWALLOW}`],
    ["a line inside a command substitution", `echo $(cat <(cat <<EOF) <<A\nA\nit"s\nEOF\nit's\nA\n${PUSH}\n)`],
    ["a body whose quote bash 3.2 never closes", `cat <(cat <<EOF)\nit"s\nEOF\n${PUSH}`],
  ])("the hook denies a push bash 5 runs after %s", async (_name, command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it.each([
    ["a heredoc of the line fed to bash", `: <(cat <<EOF); bash <<A\nA\necho x"\nEOF\n${PUSH}\nA\nx #"`],
    ["a heredoc of the line fed to bash after a command substitution", `: $(cat <<EOF); bash <<A\nA\necho x"\nEOF\n${PUSH}\nA\nx #"`],
    ["a heredoc of the line piped to bash", `: <(cat <<EOF); cat <<A | bash\nA\necho x"\nEOF\n${PUSH}\nA\nx #"`],
    ["a substitution's heredoc whose body comes second", `: $(cat <<A) <(bash <<EOF)\necho x"\nA\n${PUSH}\nEOF\nx #"`],
  ])("the hook denies a push bash 5 runs as the body of %s", async (_name, command) => {
    expect(await hookDenies(command)).toBe(true);
  });

  it("the hook names the open heredoc when it refuses the line", async () => {
    const port: HookPort = { context, now: () => new Date(0), loadDecide: async () => decide };
    const command = "cat <(cat <<EOF)\nbody\nEOF\nls";
    const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: REPO, tool_input: { command } });
    expect((await handle(input, { PATH: "/usr/bin" }, port)).stdout).toContain("close the heredoc inside the substitution");
  });

  it.each([
    ["a commit message", `git commit -m "$(cat <<'EOF'\nmsg\nEOF\n)"\nls`],
    ["a process substitution", "cat <(cat <<EOF\nbody\nEOF\n)\nls"],
    ["a substitution at the end of the text", "cat <(cat <<EOF)"],
  ])("the hook lets a heredoc closed inside %s pass", async (_name, command) => {
    expect(await hookDenies(command)).toBe(false);
  });
});

describe("a pending heredoc in a backtick substitution or a heredoc body", () => {
  const ATTACK = `cat <(cat <<EOF)\nit's\nEOF\n${PUSH}\necho \\'`;
  const padding = (n: number) => Array.from({ length: n }, () => "$(cat <(cat <<D))").map((line, k) => line.replace("D)", `D${k})`));
  const heredocs = (n: number) => Array.from({ length: n }, (_, k) => `D${k}`).join("\n");

  it.each([200, 300])("the hook denies the push behind %i pending heredocs in a backtick substitution", async (n) => {
    const command = `echo \`${padding(n).join("\n")}\n${heredocs(n)}\`\n${ATTACK}`;
    expect(await hookDenies(command)).toBe(true);
  });

  it("the hook denies the push behind 300 pending heredocs in an unquoted heredoc body", async () => {
    const command = `cat <<X\n${padding(300).join("\n")}\n${heredocs(300)}\nX\n${ATTACK}`;
    expect(await hookDenies(command)).toBe(true);
  });

  it("refuses to classify a pending heredoc inside a backtick substitution", () => {
    const command = `echo \`${padding(300).join("\n")}\n${heredocs(300)}\`\n${ATTACK}`;
    expect(() => classifyCommand(command)).toThrow();
  });
});

describe("a pending heredoc before a quote that never closes", () => {
  const openers = [
    ["<(", "cat <(cat <<EOF)"],
    [">(", "cat >(cat <<EOF)"],
    ["$(<(", "echo $(cat <(cat <<EOF))"],
  ];
  const quotes = [
    ["single", "it's", "echo '"],
    ["double", 'say "hi', 'echo "'],
  ];
  const guarded = [
    ["gh pr merge", "gh pr merge 1 --squash"],
    ["git push", PUSH],
  ];
  const rows = openers.flatMap(([o, opener]) => quotes.flatMap(([q, body, tail]) => guarded.map(([g, cmd]) => [`${o} with a ${q} quote before ${g}`, `${opener}\n${body}\nEOF\n${cmd}\n${tail}`])));

  it.each(rows)("the hook denies %s", async (_name, command) => {
    expect(await hookDenies(command)).toBe(true);
  });
});

describe("a pending heredoc in a followed script", () => {
  const dir = mkdtempSync(join(tmpdir(), "procsub-script-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const FILLER = "flock $F ls git status\n".repeat(200);
  const scriptWith = (last: string) => `cat <(cat <<EOF)\nflock $F ls ${last}\nEOF\n${FILLER}`;

  async function verdict(command: string, script: string): Promise<boolean> {
    writeFileSync(join(dir, "s.sh"), script);
    const readScript = (path: string) => (path === join(dir, "s.sh") ? readFileSync(path, "utf8") : null);
    const port: HookPort = { context: { ...context, readHead: () => "main", readScript }, now: () => new Date(0), loadDecide: async () => decide };
    const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: dir, tool_input: { command } });
    return (await handle(input, { PATH: "/usr/bin" }, port)).stdout !== "";
  }

  it.each(["bash ./s.sh", "./s.sh"])("the hook denies `%s` when the body line pushes behind an unsure flock", async (command) => {
    expect(await verdict(command, scriptWith(PUSH))).toBe(true);
  });

  it.each(["bash ./s.sh", "./s.sh"])("the hook refuses `%s` even when the body line only reads status", async (command) => {
    expect(await verdict(command, scriptWith("git status"))).toBe(true);
  });
});
