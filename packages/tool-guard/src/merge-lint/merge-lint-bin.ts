#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { MAX_FILE_BYTES, run } from "./run.js";
import type { RunIo } from "./run.js";
import type { SourceFile } from "./scan.js";

function readText(file: string): string | null {
  try {
    return readTextOrThrow(file);
  } catch {
    return null;
  }
}

/** Null for a file that is deliberately not scanned (not a regular file, oversized, binary). */
function readTextOrThrow(file: string): string | null {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  const buffer = fs.readFileSync(file);
  return buffer.subarray(0, 8000).includes(0) ? null : buffer.toString("utf-8");
}

function trackedFiles(): { files: SourceFile[]; unreadable: string[] } {
  const listing = execFileSync("git", ["ls-files", "-z"], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  const files: SourceFile[] = [];
  const unreadable: string[] = [];
  for (const path of listing.split("\0").filter((p) => p !== "")) {
    try {
      const text = readTextOrThrow(path);
      if (text !== null) files.push({ path, text });
    } catch {
      unreadable.push(path);
    }
  }
  return { files, unreadable };
}

const io: RunIo = {
  env: process.env,
  readRules: readText,
  trackedFiles,
  readStdin: () => fs.readFileSync(0, "utf-8"),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

process.exitCode = run(process.argv.slice(2), io);
