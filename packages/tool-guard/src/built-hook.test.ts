import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type * as Deadline from "./deadline.js";

// The built bundle orders its modules differently from the source vitest loads, so a load-order crash shows only here.
// CI builds before it tests; locally run `pnpm build` first.
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "tool-guard-built-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function event(command: string): string {
  return JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: home, tool_input: { command } });
}

describe("the built tool-guard", () => {
  it.each([
    ["a push to main", "git push origin HEAD:main"],
    ["a push after a CR and a #", "echo x\r#; git push origin HEAD:main"],
  ])("denies %s through the hook with exit 0", (_form, command) => {
    const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: event(command), env: { ...process.env, HOME: home }, encoding: "utf-8" });

    expect(run.stderr).not.toContain("TypeError");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"permissionDecision":"deny"');
  });

  it("answers an ordinary line silently through its worker", () => {
    const run = spawnSync(process.execPath, [join(dist, "bin.js"), "hook"], { input: event("ls -la"), env: { ...process.env, HOME: home }, encoding: "utf-8" });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("loads its entry point", async () => {
    await expect(import(pathToFileURL(join(dist, "index.js")).href)).resolves.toBeDefined();
  });
});

describe("the built tool-guard on a line whose check outruns its deadline (TP-3224)", () => {
  const fill = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

  it("denies within the deadline plus a margin, telling the agent to split the command", async () => {
    const deadline = (await import(pathToFileURL(join(dist, "deadline.js")).href)) as typeof Deadline;
    const repo = join(home, "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, ".git/HEAD"), "ref: refs/heads/feat/x\n");
    // About 3 s to classify with case folding on; far past the 200 ms deadline.
    writeFileSync(join(repo, "a.sh"), fill("a b c d e f g h i j k l m n o p q r s t u v w x y z\n", 64 * 1024));
    const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: repo, tool_input: { command: "./a.sh; git push origin HEAD:main" } });
    const deadlineMs = 200;
    const start = performance.now();

    const result = await deadline.answerWithin(input, {
      env: {},
      now: () => new Date(),
      deadlineMs,
      start: (text) => deadline.startWorker({ input: text, env: {}, home, foldCase: true }),
    });

    expect(performance.now() - start).toBeLessThan(deadlineMs + 1500);
    expect(result.stdout).toContain("could not finish checking this call in time, so it was not run. Split the command into smaller Bash calls.");
  });
});
