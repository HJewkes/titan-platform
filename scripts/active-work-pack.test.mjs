// Packs @titan-design/active-work together with its workspace closure, installs the tarballs into a scratch prefix and
// runs the installed bins. This is the artifact the host cutover installs (site/guides/active-work.md), so it is the
// only test that catches a `files` entry, a prepack step or a workspace: range that works in the monorepo and breaks
// once packed. Needs the closure built (`pnpm build`).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceMemberDirs } from "./structure-rules.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PRODUCT = path.join(ROOT, "products/active-work");
const PACKAGE_NAME = "@titan-design/active-work";
const REQUIRED_FILES = [
  "dist/cli.js",
  "dist/aw.js",
  "skill/SKILL.md",
  "claude-commands/aw-prompt.md",
  "scripts/postinstall.js",
  "docs/cli-reference.md",
];
const SETUP_TIMEOUT_MS = 480_000;

let scratch;
let home;
let prefix;
let tarballs;
let env;

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function bin(name, args) {
  return run(path.join(prefix, "node_modules/.bin", name), args);
}

function listTarball(tarball) {
  return run("tar", ["-tzf", tarball]).split("\n").map((line) => line.replace(/^package\//, ""));
}

/** Directories of the product and every workspace package it installs at runtime, found through `workspace:` ranges. */
function closureDirs() {
  const byName = new Map(workspaceMemberDirs(ROOT).map((rel) => {
    const dir = path.join(ROOT, rel);
    return [JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name, dir];
  }));
  const seen = new Map();
  const visit = (name) => {
    if (seen.has(name)) return;
    const dir = byName.get(name);
    seen.set(name, dir);
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies };
    Object.keys(deps).filter((dep) => byName.has(dep)).forEach(visit);
  };
  visit(PACKAGE_NAME);
  return [...seen.values()];
}

function activeWorkTarball() {
  return tarballs.find((file) => path.basename(file).startsWith("titan-design-active-work-"));
}

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "active-work-pack-"));
  home = path.join(scratch, "home");
  prefix = path.join(scratch, "prefix");
  const packDir = path.join(scratch, "tarballs");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(packDir);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    ACTIVE_ROOT: path.join(home, "active-root"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    npm_config_cache: path.join(scratch, "npm-cache"),
  };
  for (const dir of closureDirs()) run("pnpm", ["pack", "--pack-destination", packDir], { cwd: dir });
  tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz")).map((file) => path.join(packDir, file));
  mkdirSync(prefix);
  run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", ...tarballs], { cwd: scratch });
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("active-work closure tarball", () => {
  it("packs the product together with its workspace dependencies", () => {
    const names = tarballs.map((file) => path.basename(file));

    expect(tarballs.length).toBeGreaterThan(1);
    expect(names.some((name) => name.startsWith("titan-design-daemon-"))).toBe(true);
  });

  it("lists every file the installed CLI and skill need", () => {
    const listed = new Set(listTarball(activeWorkTarball()));

    expect(REQUIRED_FILES.filter((file) => !listed.has(file))).toEqual([]);
  });

  it("installs bins whose --version matches package.json", () => {
    const { version } = JSON.parse(readFileSync(path.join(PRODUCT, "package.json"), "utf8"));

    expect(bin("active-work", ["--version"]).trim()).toBe(version);
  });

  it("runs aw --help", () => {
    expect(bin("aw", ["--help"])).toContain("Usage:");
  });

  it("copies the skill and slash command into the scratch .claude on install", () => {
    expect(existsSync(path.join(home, ".claude/skills/active-work/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, ".claude/commands/aw-prompt.md"))).toBe(true);
  });

  it("bootstraps a synthetic initiative and adds and lists a task", () => {
    bin("active-work", ["new", "demo", "--title", "Synthetic demo"]);
    bin("active-work", ["task", "add", "demo", "--title", "Smoke task", "--done-when", "the installed tarball lists this task after adding it", "--quiet"]);

    const tasks = JSON.parse(bin("active-work", ["--json", "task", "list", "demo"]));
    const prompt = bin("active-work", ["prompt", "demo", "--offline", "--no-sibling-check"]);

    expect(JSON.stringify(tasks)).toContain("Smoke task");
    expect(prompt).toContain("demo");
  });

  it("writes the initiative under the scratch active root only", () => {
    expect(existsSync(path.join(home, "active-root", "demo"))).toBe(true);
  });
});
