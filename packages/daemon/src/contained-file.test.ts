import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { containedFile } from "./contained-file.js";

let dir: string;
let root: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "contained-file-"));
  root = path.join(dir, "build");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "iframe.html"), "<!doctype html><title>story</title>");
  await writeFile(path.join(root, "index.json"), "{}");
  await writeFile(path.join(root, "assets", "a-hash.js"), "export {}");
  await writeFile(path.join(root, "assets", "blob.bin"), "x");
  await writeFile(path.join(root, ".env"), "TOKEN=1");
  await writeFile(path.join(dir, "secret.txt"), "outside-the-root");
  await symlink(path.join(dir, "secret.txt"), path.join(root, "escape.txt"));
  await symlink(dir, path.join(root, "up"));
  await symlink(path.join(root, "iframe.html"), path.join(root, "alias.html"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("containedFile", () => {
  it.each([
    ["/iframe.html", "text/html; charset=utf-8"],
    ["/index.json", "application/json; charset=utf-8"],
    ["/assets/a-hash.js", "text/javascript; charset=utf-8"],
    ["/assets/blob.bin", "application/octet-stream"],
  ])("serves %s under the root with its content type", async (pathname, type) => {
    const found = await containedFile(root, pathname);

    expect(found).toMatchObject({ kind: "file", contentType: type });
    expect(found.kind === "file" && path.relative(root, found.file)).toBe(path.join(...pathname.split("/").filter(Boolean)));
  });

  it("follows a symlink that stays inside the root", async () => {
    expect(await containedFile(root, "/alias.html")).toMatchObject({ kind: "file", contentType: "text/html; charset=utf-8" });
  });

  it.each([
    ["a symlinked file outside the root", "/escape.txt"],
    ["a symlinked directory outside the root", "/up/secret.txt"],
    ["an encoded slash after ..", "/..%2fsecret.txt"],
    ["a raw .. segment", "/../secret.txt"],
    ["an encoded absolute path", "/%2Fetc%2Fpasswd"],
    ["an encoded backslash", "/..%5csecret.txt"],
    ["a drive letter", "/C:%5Cwindows"],
    ["a NUL", "/iframe.html%00.png"],
    ["a malformed escape", "/%E0%A4%A"],
  ])("refuses %s", async (_case, pathname) => {
    expect(await containedFile(root, pathname)).toEqual({ kind: "refused" });
  });

  it.each([
    ["a dotfile", "/.env"],
    ["the root itself", "/"],
    ["a directory", "/assets"],
    ["an absent file", "/nope.js"],
    ["a doubled slash that stays under the root", "//etc/passwd"],
  ])("answers %s as missing, never a listing", async (_case, pathname) => {
    expect(await containedFile(root, pathname)).toEqual({ kind: "missing" });
  });

  it("answers missing when the root does not exist", async () => {
    expect(await containedFile(path.join(dir, "absent"), "/iframe.html")).toEqual({ kind: "missing" });
  });
});
