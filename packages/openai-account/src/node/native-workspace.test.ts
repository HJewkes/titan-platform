import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertProjectlessWorkspace } from "./native-workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const missing = () => Object.assign(new Error("absent"), { code: "ENOENT" });
const directory = { isDirectory: () => true };

describe("native workspace ancestry", () => {
  it.each([".git", ".codex"]) ("refuses any %s entry including files and links without reading content", async marker => {
    for (const kind of ["file", "directory", "symlink"]) {
      const seen: string[] = [];
      await expect(assertProjectlessWorkspace("/alias/cwd", {
        realpath: async () => "/physical/project/temp",
        lstat: async path => {
          seen.push(path);
          if (path === "/physical/project/temp") return directory;
          if (path === `/physical/project/${marker}`) return { isDirectory: () => kind === "directory" };
          throw missing();
        },
      })).rejects.toThrow("native quota workspace unsafe");
      expect(seen).toContain(`/physical/project/${marker}`);
    }
  });
  it("refuses unknown or unreadable metadata, including a root ancestor", async () => {
    for (const code of ["EACCES", "EPERM", "ELOOP", "ENOTDIR"]) {
      await expect(assertProjectlessWorkspace("/physical/temp", {
        realpath: async path => path,
        lstat: async path => {
          if (path === "/physical/temp") return directory;
          if (path === "/.codex") throw Object.assign(new Error("private-path"), { code });
          throw missing();
        },
      })).rejects.toThrow("native quota workspace unsafe");
    }
  });
  it("accepts only canonical project-config-free ancestry and checks every ancestor", async () => {
    const checked: string[] = [];
    expect(await assertProjectlessWorkspace("/alias/temp", {
      realpath: async () => "/physical/temp",
      lstat: async path => {
        if (path === "/physical/temp") return directory;
        checked.push(path); throw missing();
      },
    })).toBe("/physical/temp");
    expect(checked).toEqual(["/physical/temp/.git", "/physical/temp/.codex", "/physical/.git", "/physical/.codex", "/.git", "/.codex"]);
  });
  it("finds project config without a .git marker through a physical symlink ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "quota-workspace-guard-")); roots.push(root);
    const project = join(root, "project"); const nested = join(project, "scratch");
    await mkdir(nested, { recursive: true }); await mkdir(join(project, ".codex"));
    await mkdir(join(project, ".company-root"));
    const alias = join(root, "alias"); await symlink(nested, alias);
    await expect(assertProjectlessWorkspace(alias)).rejects.toThrow("native quota workspace unsafe");
  });
});
