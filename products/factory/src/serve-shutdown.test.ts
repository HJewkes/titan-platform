import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execSafeAsync, type AnswersPage } from "@titan-design/agent-dispatch";
import { silentLogger, type Logger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GateNotifyOptions } from "./gate-notify-sweep.js";
import { startFactoryServer, type FactoryServer } from "./serve.js";
import { SHUTDOWN_SWEEP_GRACE_MS } from "./serve-shutdown.js";
import { gateId, gateOpened, landScenario, type LandScenario } from "./test-support/land.js";

const GRACE_MS = 300;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

interface Logged {
  fields: Record<string, unknown>;
  msg: string;
}

function recordingLogger(): { log: Logger; lines: Logged[] } {
  const lines: Logged[] = [];
  const record = (fields: Record<string, unknown>, msg: string) => void lines.push({ fields, msg });
  return { log: { ...silentLogger, info: record, warn: record, error: record }, lines };
}

/** A gate notifier whose answer read waits on `answers`, standing in for an agent-chat call stuck on its 30 s timeout. */
function slowNotifier(answers: Promise<void>, onRead: () => void = () => undefined): GateNotifyOptions {
  return {
    label: "titan-factory",
    resolverClass: "owner-remote",
    askHuman: async () => "q1",
    readAnswers: async (): Promise<AnswersPage> => {
      await answers;
      onRead();
      return { answers: [] };
    },
    dismissAsk: async () => undefined,
  };
}

async function serve(scenario: LandScenario, log: Logger, gateNotify: GateNotifyOptions): Promise<FactoryServer> {
  const dir = mkdtempSync(join(tmpdir(), "factory-shutdown-"));
  dirs.push(dir);
  return startFactoryServer({
    dbPath: join(dir, "factory.sqlite3"),
    workflows: [scenario.workflow],
    routes: scenario.routes,
    gatePollMs: 10,
    port: 0,
    logger: log,
    github: { status: () => "ok", refresh: async () => undefined },
    gateNotify,
    shutdownGraceMs: GRACE_MS,
  });
}

const never = new Promise<void>(() => undefined);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A notifier whose answer read is a real child that outlives any grace, writing its pid first. */
function childNotifier(pidFile: string): GateNotifyOptions {
  const sleeper = ["-c", `echo $$ > ${pidFile}; exec sleep 60`];
  return {
    ...slowNotifier(never),
    readAnswers: async (_label, _since, signal): Promise<AnswersPage> => {
      await execSafeAsync("/bin/sh", sleeper, { PATH: process.env.PATH ?? "/usr/bin:/bin" }, 60_000, undefined, undefined, signal);
      return { answers: [] };
    },
  };
}

describe("serve's bounded shutdown", () => {
  it("waits five seconds by default", () => {
    expect(SHUTDOWN_SWEEP_GRACE_MS).toBe(5_000);
  });

  it("a hung sweep tick no longer holds close past the grace", async () => {
    const { log, lines } = recordingLogger();
    const server = await serve(landScenario(), log, slowNotifier(never));
    const started = Date.now();

    await server.close();

    expect(Date.now() - started).toBeLessThan(GRACE_MS + 2_000);
    expect(lines).toContainEqual({ msg: "closed", fields: expect.objectContaining({ abandoned: ["gate notify"] }) });
  });

  it("a hung tick's child process is killed at the end of the grace", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "factory-child-")), "pid");
    dirs.push(dirname(pidFile));
    const server = await serve(landScenario(), recordingLogger().log, childNotifier(pidFile));
    await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()).toBeTruthy());
    const pid = Number(readFileSync(pidFile, "utf8"));
    const started = Date.now();

    await server.close();

    expect(Date.now() - started).toBeLessThan(GRACE_MS + 2_000);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2_000 });
  });

  it("the runtime releases runs before any sweep is awaited", async () => {
    const scenario = landScenario();
    const server = await serve(scenario, recordingLogger().log, slowNotifier(never));
    const runId = server.host.runtime.start("land-test");
    await gateOpened(server.host, gateId(runId, "approve-merge"));
    const ownerBefore = server.host.runtime.status(runId)?.owner;

    const closed = server.close();
    const ownerAtClose = server.host.runtime.status(runId)?.owner;
    await closed;

    expect(ownerBefore).toBeDefined();
    expect(ownerAtClose).toBeUndefined();
  });

  it("a tick that finishes inside the grace is awaited", async () => {
    const { log, lines } = recordingLogger();
    let answer = (): void => undefined;
    const answers = new Promise<void>((resolve) => (answer = resolve));
    const read = vi.fn();
    const server = await serve(landScenario(), log, slowNotifier(answers, read));

    const closed = server.close();
    setTimeout(answer, GRACE_MS / 3);
    await closed;

    expect(read).toHaveBeenCalledTimes(1);
    expect(lines).toContainEqual({ msg: "closed", fields: { ms: expect.any(Number) } });
  });
});
