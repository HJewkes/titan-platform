import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkBin, onPath, parseArgs } from "./factory-link-bin.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A checkout with a built bin, another checkout's bin, and a bin directory that does not exist yet. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "factory-link-bin-"));
  roots.push(root);
  const built = (checkout) => {
    mkdirSync(join(root, checkout, "dist"), { recursive: true });
    writeFileSync(join(root, checkout, "dist", "bin.js"), "#!/usr/bin/env node\n");
    return join(root, checkout, "dist", "bin.js");
  };
  return { target: built("checkout"), other: built("other-checkout"), binDir: join(root, "home", "bin"), link: join(root, "home", "bin", "titan-factory") };
}

describe("factory-link-bin", () => {
  it("creates the bin directory and links titan-factory to the built bin", () => {
    const { target, binDir, link } = sandbox();

    expect(linkBin({ target, binDir, force: false })).toEqual({ link, status: "linked" });

    expect(readlinkSync(link)).toBe(target);
  });

  it("leaves a link that already points at the built bin alone", () => {
    const { target, binDir, link } = sandbox();
    linkBin({ target, binDir, force: false });

    expect(linkBin({ target, binDir, force: false })).toEqual({ link, status: "unchanged" });
  });

  it("refuses to repoint a link at another checkout without --force", () => {
    const { target, other, binDir, link } = sandbox();
    linkBin({ target: other, binDir, force: false });

    expect(() => linkBin({ target, binDir, force: false })).toThrow(/already points at .*other-checkout.*--force/);

    expect(readlinkSync(link)).toBe(other);
  });

  it("repoints a link at another checkout with --force", () => {
    const { target, other, binDir, link } = sandbox();
    linkBin({ target: other, binDir, force: false });

    expect(linkBin({ target, binDir, force: true })).toEqual({ link, status: "repointed" });

    expect(readlinkSync(link)).toBe(target);
  });

  it("repoints a dangling link only with --force", () => {
    const { target, binDir, link } = sandbox();
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(binDir, "gone", "bin.js"), link);

    expect(() => linkBin({ target, binDir, force: false })).toThrow(/--force/);
    expect(linkBin({ target, binDir, force: true }).status).toBe("repointed");
  });

  it("never replaces a regular file, even with --force", () => {
    const { target, binDir, link } = sandbox();
    mkdirSync(binDir, { recursive: true });
    writeFileSync(link, "a wrapper script");

    expect(() => linkBin({ target, binDir, force: true })).toThrow(/not a symlink/);

    expect(lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it("fails before touching the bin directory when the bin is not built", () => {
    const { binDir, link } = sandbox();

    expect(() => linkBin({ target: join(binDir, "missing", "bin.js"), binDir, force: false })).toThrow(/is not built/);

    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("defaults to ~/.local/bin and reads --bin-dir and --force", () => {
    expect(parseArgs([], "/srv/tester")).toEqual({ binDir: "/srv/tester/.local/bin", force: false });
    expect(parseArgs(["--bin-dir", "/opt/bin", "--force"], "/srv/tester")).toEqual({ binDir: "/opt/bin", force: true });
    expect(() => parseArgs(["--global"], "/srv/tester")).toThrow(/unknown argument --global/);
  });

  it("knows whether the bin directory is on PATH", () => {
    expect(onPath("/srv/tester/.local/bin", "/usr/bin:/srv/tester/.local/bin/")).toBe(true);
    expect(onPath("/srv/tester/.local/bin", "/usr/bin:/bin")).toBe(false);
    expect(onPath("/srv/tester/.local/bin", undefined)).toBe(false);
  });
});
