import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { LockTimeoutError, acquire, lockWaitMs, readHolder, release, runCappedWorker, tryAcquire, workerExitCode } from "./dag-check-lock.mjs";

const MODULE = new URL("./dag-check-lock.mjs", import.meta.url).href;
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function lockPath() {
  const root = mkdtempSync(join(tmpdir(), "dag-check-lock-"));
  roots.push(root);
  return join(root, "nested", "dag-check.lock");
}

function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** A separate process that takes the lock, releases it on SIGTERM, and says "held" once it holds it. */
async function spawnHolder(lockDir) {
  const script = `
    import { acquire, cleanupOnSignal, release } from ${JSON.stringify(MODULE)};
    const dir = ${JSON.stringify(lockDir)};
    await acquire({ lockDir: dir, timeoutMs: 5000, pollMs: 20, log: () => {} });
    cleanupOnSignal([() => release(dir)]);
    console.log("held");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const [chunk] = await once(child.stdout, "data");
  expect(String(chunk).trim()).toBe("held");
  return child;
}

describe("dag-check lock", () => {
  it("takes a free lock, records this pid, and release removes it", () => {
    const lockDir = lockPath();

    expect(tryAcquire(lockDir)).toBeNull();
    expect(readHolder(lockDir)).toBe(process.pid);
    release(lockDir);

    expect(existsSync(lockDir)).toBe(false);
  });

  it("makes a second acquirer wait, naming the holder, until the lock is released", async () => {
    const lockDir = lockPath();
    tryAcquire(lockDir);
    const lines = [];
    let acquired = false;

    const waiting = acquire({ lockDir, timeoutMs: 5000, pollMs: 10, log: (m) => lines.push(m) }).then(() => (acquired = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(acquired).toBe(false);
    release(lockDir);
    await waiting;

    expect(lines).toEqual([`waiting for dag-check lock held by ${process.pid}, 0 ahead of you`]);
    expect(readHolder(lockDir)).toBe(process.pid);
  });

  it("takes over a lock whose holder pid is dead", () => {
    const lockDir = lockPath();
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), String(deadPid()));

    expect(tryAcquire(lockDir)).toBeNull();

    expect(readHolder(lockDir)).toBe(process.pid);
  });

  it("gives up with a LockTimeoutError once the timeout passes", async () => {
    const lockDir = lockPath();
    tryAcquire(lockDir);

    const attempt = acquire({ lockDir, timeoutMs: 50, pollMs: 10, log: () => {} });

    await expect(attempt).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it("fails with the busy message naming the holder and the queue ahead once the bound passes", async () => {
    const lockDir = lockPath();
    tryAcquire(lockDir);

    const attempt = acquire({ lockDir, timeoutMs: 50, pollMs: 10, log: () => {} });

    await expect(attempt).rejects.toThrow(`dag-check lock busy (held by ${process.pid}, 0 ahead of you); retry later`);
  });

  it("hands the lock to three staggered waiters in arrival order", async () => {
    const lockDir = lockPath();
    tryAcquire(lockDir);
    const order = [];
    const waiters = [];
    for (const name of ["first", "second", "third"]) {
      waiters.push(
        acquire({ lockDir, timeoutMs: 5000, pollMs: 5, log: () => {} }).then(() => {
          order.push(name);
          release(lockDir);
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    release(lockDir);
    await Promise.all(waiters);

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("reports its place in the queue to a waiter behind another", async () => {
    const lockDir = lockPath();
    tryAcquire(lockDir);
    const lines = [];
    const ahead = acquire({ lockDir, timeoutMs: 5000, pollMs: 5, log: () => {} }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    const behind = acquire({ lockDir, timeoutMs: 60, pollMs: 5, log: (m) => lines.push(m) }).catch(() => {});
    await behind;

    expect(lines[0]).toBe(`waiting for dag-check lock held by ${process.pid}, 1 ahead of you`);
    release(lockDir);
    await ahead;
  });

  it("skips a ticket whose pid is dead", async () => {
    const lockDir = lockPath();
    mkdirSync(`${lockDir}.queue`, { recursive: true });
    const stale = `${String(1).padStart(15, "0")}-${String(deadPid()).padStart(10, "0")}-abc123`;
    writeFileSync(join(`${lockDir}.queue`, stale), "");

    await acquire({ lockDir, timeoutMs: 1000, pollMs: 5, log: () => {} });

    expect(readHolder(lockDir)).toBe(process.pid);
    expect(existsSync(join(`${lockDir}.queue`, stale))).toBe(false);
  });

  it("leaves no ticket behind after acquiring", async () => {
    const lockDir = lockPath();

    await acquire({ lockDir, timeoutMs: 1000, pollMs: 5, log: () => {} });

    expect(readdirSync(`${lockDir}.queue`)).toEqual([]);
  });

  it("reads the wait bound from DAG_CHECK_LOCK_WAIT_MS and defaults to eight minutes", () => {
    expect(lockWaitMs({})).toBe(480000);
    expect(lockWaitMs({ DAG_CHECK_LOCK_WAIT_MS: "1500" })).toBe(1500);
  });

  it("releases the lock when the holding process gets SIGTERM", async () => {
    const lockDir = lockPath();
    const holder = await spawnHolder(lockDir);
    expect(tryAcquire(lockDir)).toBe(holder.pid);

    holder.kill("SIGTERM");
    const [code] = await once(holder, "exit");

    expect(code).toBe(143);
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe("the capped indexer child", () => {
  function scriptFile(body) {
    const root = mkdtempSync(join(tmpdir(), "dag-check-worker-"));
    roots.push(root);
    writeFileSync(join(root, "worker.mjs"), body);
    return join(root, "worker.mjs");
  }

  async function run(body, heapCapMb = 64) {
    const lines = [];
    const code = await runCappedWorker({ script: scriptFile(body), args: [], name: "indexer", heapCapMb, cleanups: [], log: (m) => lines.push(m) });
    return { code, lines };
  }

  it("passes the child's own exit code through", async () => {
    expect(await run("process.exit(1);")).toEqual({ code: 1, lines: [] });
  });

  it("reports an out-of-memory abort at the heap cap as exit 2 with the cause named", async () => {
    const { code, lines } = await run("const keep = []; for (;;) keep.push(new Array(1e5).fill({}));", 32);
    expect(code).toBe(2);
    expect(lines).toEqual(["indexer ran out of memory: V8 aborted it at the 32 MB heap cap"]);
  }, 30000);

  it("names a raw 134 exit from a shell wrapper as out of memory too", () => {
    const lines = [];
    expect(workerExitCode({ code: 134, signal: null, name: "indexer", heapCapMb: 1024, log: (m) => lines.push(m) })).toBe(2);
    expect(lines[0]).toContain("ran out of memory");
  });

  it("reports any other signal as exit 2 naming the signal", () => {
    const lines = [];
    expect(workerExitCode({ code: null, signal: "SIGKILL", name: "indexer", heapCapMb: 1024, log: (m) => lines.push(m) })).toBe(2);
    expect(lines).toEqual(["indexer died with SIGKILL"]);
  });
});
