import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRegularFile } from "./bounded-read.js";

const scratch = (): string => mkdtempSync(join(tmpdir(), "speech-tts-read-"));

describe("readRegularFile", () => {
  it("reads a regular file within the limit", async () => {
    const path = join(scratch(), "out.wav");
    writeFileSync(path, "RIFF....");

    expect((await readRegularFile(path, 64)).toString()).toBe("RIFF....");
  });

  // Mutation caught: open follows symlinks, so a file swapped for a link after the path checks is read through it.
  // This is the state the swap race leaves behind; the race itself is not timed here.
  it("refuses a path that is a symlink at open time", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "secret.txt"), "not audio");
    symlinkSync(join(dir, "secret.txt"), join(dir, "out.wav"));

    await expect(readRegularFile(join(dir, "out.wav"), 64)).rejects.toThrow("is a symlink");
  });

  // Mutation caught: the type check is dropped, so a FIFO (stat size 0) passes the limit and is read as audio.
  it.skipIf(process.platform === "win32")("refuses a FIFO, which a size check alone would pass", async () => {
    const path = join(scratch(), "out.wav");
    execFileSync("mkfifo", [path]);

    await expect(readRegularFile(path, 64)).rejects.toThrow("is not a regular file");
  });

  // Mutation caught: the nlink check is dropped, so a hardlink to a file outside outDir is read as audio.
  it("refuses a file with more than one hard link", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "secret.txt"), "not audio");
    linkSync(join(dir, "secret.txt"), join(dir, "out.wav"));

    await expect(readRegularFile(join(dir, "out.wav"), 64)).rejects.toThrow("has 2 links; a hardlinked file is refused");
  });

  // Mutation caught: the oversize check is dropped, so the whole file is read.
  it("refuses a file larger than the limit before reading it", async () => {
    const path = join(scratch(), "out.wav");
    writeFileSync(path, Buffer.alloc(1_000));

    await expect(readRegularFile(path, 999)).rejects.toThrow("is larger than maxOutputBytes (999)");
  });
});
