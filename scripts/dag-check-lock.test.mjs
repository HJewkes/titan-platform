import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { LockTimeoutError, acquire, readHolder, release, tryAcquire } from "./dag-check-lock.mjs";

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

    expect(lines).toEqual([`waiting for dag-check lock held by ${process.pid}`]);
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
