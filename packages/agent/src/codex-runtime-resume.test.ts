import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexExecAdapter } from "./codex-exec.js";
import { codexCapabilitiesFromHelp, inspectCodexCapabilities } from "./codex-runtime.js";
import type { CodexRunRequest } from "./harness-contracts.js";
import type { CodexProcessInput } from "./codex-process.js";

const execHelp = await readFile(new URL("./fixtures/codex-0.162.1/exec-help.txt", import.meta.url), "utf8");
const resumeHelp = await readFile(new URL("./fixtures/codex-0.162.1/exec-resume-help.txt", import.meta.url), "utf8");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const request = (resume: boolean): CodexRunRequest => ({
  harness: "codex", prompt: "report", cwd: "/tmp/work", wallTimeMs: 2000,
  target: resume ? { kind: "resume", conversation: { harness: "codex", namespace: "fixture", nativeId: "019c0000-0000-7000-8000-000000000001" } }
    : { kind: "fresh", namespace: "fixture" },
  native: { model: "fixture-model", sandbox: "read-only", approvalPolicy: "never" },
});
async function* events() {
  yield JSON.stringify({ type: "thread.started", thread_id: "019c0000-0000-7000-8000-000000000001" });
  yield JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } });
  yield JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
}
function adapter(inspectCapabilities: typeof inspectCodexCapabilities) {
  const start = vi.fn((_input: CodexProcessInput) => ({ stdout: events(), stderr: (async function* () {})(),
    completed: Promise.resolve({ exitCode: 0, signal: null }), terminate: vi.fn() }));
  return { start, instance: createCodexExecAdapter({ auth: "cached-cli" }, {
    inspectVersion: async () => "codex-cli 0.162.1", inspectCapabilities, start,
  }) };
}
async function helpProgram(resume = resumeHelp) {
  const root = await mkdtemp(join(tmpdir(), "codex-help-fixture-")); roots.push(root);
  const executable = join(root, "help-fixture");
  const script = `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2).join(' ');\nappendFileSync(${JSON.stringify(join(root, "calls"))}, args + '\\n');\nif (args === 'exec --help') console.log(${JSON.stringify(execHelp)});\nelse if (args === 'exec resume --help') console.log(${JSON.stringify(resume)});\nelse process.exit(99);\n`;
  // An .mjs extension makes the fake executable independent of the host's default module mode.
  const path = `${executable}.mjs`;
  await writeFile(path, script, { mode: 0o700 });
  return { path, calls: join(root, "calls") };
}

describe("0.162.1 captured help regression", () => {
  it("takes resume flags from resume help and sandbox values from exec help", () => {
    const resume = codexCapabilitiesFromHelp(resumeHelp, execHelp);
    expect(resume.capabilities.config_overrides).toBe(true);
    expect(resume.capabilities.working_directory).toBe(false);
    expect(resume.sandboxes).toContain("read-only");
    expect(codexCapabilitiesFromHelp(resumeHelp).sandboxes).toEqual([]);
  });
  it("admits a resume through the real inspector using captured help, without a native model", async () => {
    const fake = await helpProgram();
    const fixture = adapter((_path, env, options) => inspectCodexCapabilities(fake.path, env, options));
    expect(await fixture.instance.run(request(true))).toMatchObject({ ok: true });
    expect(fixture.start).toHaveBeenCalledOnce();
    expect(fixture.start.mock.calls[0]?.[0]).toMatchObject({ args: expect.arrayContaining(["resume", "--config", 'sandbox_mode="read-only"']) });
    expect(await readFile(fake.calls, "utf8")).toBe("exec --help\nexec resume --help\n");
  });
  it("requires config overrides on resume itself, not just the parent", async () => {
    const fake = await helpProgram(resumeHelp.replace("--config <key=value>", "--unsupported-config <key=value>"));
    const fixture = adapter((_path, env, options) => inspectCodexCapabilities(fake.path, env, options));
    expect(await fixture.instance.run(request(true))).toMatchObject({ ok: false, failure: { reason: expect.stringContaining("config_overrides") } });
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("admits fresh execution and still refuses absent sandbox values", async () => {
    const good = adapter(async () => codexCapabilitiesFromHelp(execHelp));
    expect(await good.instance.run(request(false))).toMatchObject({ ok: true });
    const bad = adapter(async () => codexCapabilitiesFromHelp(execHelp.replace("read-only, workspace-write, danger-full-access", "workspace-write")));
    expect(await bad.instance.run(request(false))).toMatchObject({ ok: false, failure: { reason: expect.stringContaining("sandbox read-only") } });
    expect(bad.start).not.toHaveBeenCalled();
  });
});
