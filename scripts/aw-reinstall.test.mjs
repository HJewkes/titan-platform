import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const run = (script, ...rest) => {
  const overrides = typeof rest.at(-1) === "object" ? rest.pop() : {};
  return execFileSync("bash", [join(SCRIPTS, script), ...rest], {
    encoding: "utf8",
    env: { ...process.env, AW_REPO: "/repo", AW_STAGE_ROOT: "/stage", AW_BIN_DIR: "/bin-dir", AW_LOG: "/log/aw.log", ...overrides },
  });
};

describe("aw-reinstall.sh --dry-run", () => {
  it("prints every step in order and runs none of them", () => {
    const out = run("aw-reinstall.sh", "--dry-run");
    const order = ["fetch origin main", "install --frozen-lockfile", "build", "ln -sfn", "restart active-work.service", "append to /log/aw.log"];
    const at = order.map((needle) => out.indexOf(needle));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("re-points both bins at the staging build, not the checkout", () => {
    const out = run("aw-reinstall.sh", "--dry-run");
    expect(out).toContain("/bin-dir/active-work");
    expect(out).toContain("/bin-dir/aw");
    expect(out).not.toMatch(/ln -sfn \/repo/);
  });

  it("times the open before the first change and after the restart", () => {
    const lines = run("aw-reinstall.sh", "--dry-run").split("\n");
    const timed = lines.flatMap((l, i) => (l.includes("time:") ? [i] : []));
    const restart = lines.findIndex((l) => l.includes("restart"));
    expect(timed).toHaveLength(2);
    expect(timed[0]).toBeLessThan(lines.findIndex((l) => l.includes("fetch")));
    expect(timed[1]).toBeGreaterThan(restart);
  });

  it("runs install and build through the corepack-pinned pnpm, not whichever pnpm is on PATH", () => {
    const out = run("aw-reinstall.sh", "--dry-run");
    expect(out).toMatch(/^pnpm: corepack pnpm@/m);
    expect(out).toMatch(/\[dry-run\] corepack pnpm@.+ --dir \/stage\/.+ install --frozen-lockfile/);
    expect(out).toMatch(/\[dry-run\] corepack pnpm@.+ --dir \/stage\/.+ --filter .* build/);
    expect(out).not.toMatch(/\[dry-run\] pnpm /);
  });

  it("reads the pin from origin/main and strips the +sha512 suffix", () => {
    const dir = mkdtempSync(join(tmpdir(), "aw-reinstall-"));
    try {
      const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
      git("init", "-q");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.0+sha512.abc" }, null, 2));
      git("add", "package.json");
      git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const out = run("aw-reinstall.sh", "--dry-run", { AW_REPO: dir });
      expect(out.split("\n")).toContain("pnpm: corepack pnpm@9.15.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown argument", () => {
    expect(() => run("aw-reinstall.sh", "--bogus")).toThrow();
  });
});

describe("aw-reinstall.service", () => {
  it("is a oneshot that runs the script", () => {
    const unit = readFileSync(join(SCRIPTS, "..", "ops", "systemd", "aw-reinstall.service"), "utf8");
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^ExecStart=.*scripts\/aw-reinstall\.sh$/m);
  });
});

describe("aw-reinstall-install.sh --dry-run", () => {
  it("prints the unit copy and the daemon-reload", () => {
    const out = run("aw-reinstall-install.sh", "--dry-run");
    expect(out).toContain("aw-reinstall.service");
    expect(out).toContain("systemctl --user daemon-reload");
  });
});
