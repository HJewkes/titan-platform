import { describe, expect, it, vi } from "vitest";
import type { ChangedFile } from "./config.js";
import { packageJsonChanges } from "./package-sides.js";

function renamed(path: string, previousPath: string): ChangedFile {
  return { path, previousPath, status: "renamed", additions: 0, deletions: 0 };
}

describe("packageJsonChanges", () => {
  it("reads the base side of a renamed package.json from its previous path", () => {
    const show = vi.fn((rev: string, path: string) => (rev === "BASE" ? `{"name":"@s/old","from":"${path}"}` : `{"name":"@s/new","from":"${path}"}`));
    const err = vi.fn();

    const changes = packageJsonChanges([renamed("packages/new/package.json", "packages/old/package.json")], "main", {
      mergeBase: () => "BASE",
      show,
      err,
    });

    expect(show).toHaveBeenCalledWith("BASE", "packages/old/package.json");
    expect(show).toHaveBeenCalledWith("HEAD", "packages/new/package.json");
    expect(changes).toEqual([
      {
        path: "packages/new/package.json",
        base: { name: "@s/old", from: "packages/old/package.json" },
        head: { name: "@s/new", from: "packages/new/package.json" },
      },
    ]);
    expect(err).not.toHaveBeenCalled();
  });

  it("yields no changes and one warning when the merge base cannot be found", () => {
    const show = vi.fn();
    const err = vi.fn();
    const files: ChangedFile[] = [
      { path: "packages/a/package.json", status: "modified", additions: 1, deletions: 1 },
      { path: "packages/b/package.json", status: "modified", additions: 1, deletions: 1 },
    ];

    const changes = packageJsonChanges(files, "main", {
      mergeBase: () => {
        throw new Error("no merge base");
      },
      show,
      err,
    });

    expect(changes).toEqual([]);
    expect(show).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]?.[0]).toContain("skipped package.json sides: no merge base");
  });
});
