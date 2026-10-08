import { describe, expect, it } from "vitest";
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

  it("the hook lets a pending heredoc with no push pass", async () => {
    expect(await hookDenies("cat <(cat <<EOF)\nbody\nEOF\nls")).toBe(false);
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
});
