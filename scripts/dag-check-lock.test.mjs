import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { LockTimeoutError, acquire, holdLogPath, lockWaitMs, medianHoldMs, readHolder, release, runCappedWorker, tryAcquire, workerExitCode } from "./dag-check-lock.mjs";

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

describe("the dag-check hold log", () => {
  const EIGHT_MINUTES = 8 * 60 * 1000;

  /** heldSeconds entries are seconds, or { s, exit } to record the check's exit code on that line. */
  function seedHolds(lockDir, heldSeconds, extraLines = []) {
    mkdirSync(join(lockDir, ".."), { recursive: true });
    const lines = heldSeconds.map((held, i) => {
      const { s, ...rest } = typeof held === "number" ? { s: held } : held;
      return JSON.stringify({ check: "dag:check", acquiredAt: i * 1e6, releasedAt: i * 1e6 + s * 1000, ...rest });
    });
    writeFileSync(holdLogPath(lockDir), `${[...lines, ...extraLines].join("\n")}\n`);
  }

  /** Live tickets ahead: this process's pid is alive, and their names sort before any ticket taken now. */
  function seedTicketsAhead(lockDir, count) {
    mkdirSync(`${lockDir}.queue`, { recursive: true });
    for (let i = 0; i < count; i++) {
      writeFileSync(join(`${lockDir}.queue`, `${String(i + 1).padStart(15, "0")}-${String(process.pid).padStart(10, "0")}-seed${i}`), "");
    }
  }

  it("appends one line per release naming the check, its times, the queue at join and the exit", async () => {
    const lockDir = lockPath();
    const hold = await acquire({ lockDir, check: "dead:check", timeoutMs: 1000, pollMs: 5, log: () => {} });
    hold.exit = 1;

    release(lockDir, hold);

    const lines = readFileSync(holdLogPath(lockDir), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({ check: "dead:check", pid: process.pid, aheadAtJoin: 0, exit: 1 });
    expect(line.joinedAt).toBeLessThanOrEqual(line.acquiredAt);
    expect(line.acquiredAt).toBeLessThanOrEqual(line.releasedAt);
  });

  it("keeps only the last 200 lines", () => {
    const lockDir = lockPath();
    seedHolds(lockDir, Array.from({ length: 250 }, () => 1));
    tryAcquire(lockDir);

    release(lockDir, { check: "dag:check", joinedAt: 0, acquiredAt: 0, aheadAtJoin: 0 });

    expect(readFileSync(holdLogPath(lockDir), "utf8").trim().split("\n")).toHaveLength(200);
  });

  it("fails at once, naming the queue, the estimate and CI, when the queue ahead cannot clear in the wait budget", async () => {
    const lockDir = lockPath();
    seedHolds(lockDir, [100, 120, 140]);
    seedTicketsAhead(lockDir, 5);
    const started = Date.now();

    const attempt = acquire({ lockDir, timeoutMs: EIGHT_MINUTES, pollMs: 10, log: () => {} });

    await expect(attempt).rejects.toThrow(
      "dag-check lock: 5 ahead, about 10 min at the median hold of 120 s; exit 75. CI's dag-check job runs dag:check and dead:check on the PR.",
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readdirSync(`${lockDir}.queue`)).toHaveLength(5);
  }, 2000);

  it("waits as before when the log has fewer than three holds", async () => {
    const lockDir = lockPath();
    seedHolds(lockDir, [600, 600]);
    seedTicketsAhead(lockDir, 5);
    const lines = [];

    const attempt = acquire({ lockDir, timeoutMs: 100, pollMs: 10, log: (m) => lines.push(m) });

    await expect(attempt).rejects.toThrow("dag-check lock busy");
    expect(lines[0]).toContain("5 ahead of you");
  });

  it("fails at once behind a live holder with nobody ahead when one median hold exceeds the budget", async () => {
    const lockDir = lockPath();
    seedHolds(lockDir, [600, 600, 600]);
    tryAcquire(lockDir);
    const started = Date.now();

    const attempt = acquire({ lockDir, timeoutMs: EIGHT_MINUTES, pollMs: 10, log: () => {} });

    await expect(attempt).rejects.toThrow(
      "dag-check lock: the holder and 0 ahead, about 10 min at the median hold of 600 s; exit 75. CI's dag-check job runs dag:check and dead:check on the PR.",
    );
    expect(Date.now() - started).toBeLessThan(1000);
  }, 2000);

  it("acquires behind a long median when no one holds the lock", async () => {
    const lockDir = lockPath();
    seedHolds(lockDir, [600, 600, 600]);

    await acquire({ lockDir, timeoutMs: EIGHT_MINUTES, pollMs: 10, log: () => {} });

    expect(readHolder(lockDir)).toBe(process.pid);
  }, 2000);

  it("removes the lock even when the hold-log write throws", () => {
    const lockDir = lockPath();
    tryAcquire(lockDir);
    mkdirSync(holdLogPath(lockDir));

    expect(() => release(lockDir, { check: "dag:check", joinedAt: 0, acquiredAt: 0, aheadAtJoin: 0 })).toThrow();

    expect(existsSync(lockDir)).toBe(false);
  });

  it("leaves holds with no exit code out of the median and the three-hold minimum", () => {
    const completed = { s: 300, exit: 0 };
    const signalled = { s: 1, exit: null };
    const mixed = lockPath();
    const mostlySignalled = lockPath();
    seedHolds(mixed, [completed, completed, completed, signalled, signalled, signalled]);
    seedHolds(mostlySignalled, [completed, completed, signalled, signalled, signalled, signalled, signalled]);

    expect(medianHoldMs(mixed)).toBe(300000);
    expect(medianHoldMs(mostlySignalled)).toBeNull();
  });

  it("skips a corrupt or partial log line instead of throwing", () => {
    const lockDir = lockPath();
    seedHolds(lockDir, [10, 20, 30], ["not json", '{"check":"dag:check","acquiredAt":1']);

    expect(medianHoldMs(lockDir)).toBe(20000);
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
