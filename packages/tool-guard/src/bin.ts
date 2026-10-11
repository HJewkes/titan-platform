#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readWithin, runCli } from "./cli.js";
import { nodeContext } from "./context.js";

// Resolved, so a HOME set with a doubled or trailing slash still matches the guarded paths.
const home = path.resolve(os.homedir());

function appendLog(file: string, lines: readonly string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // O_NOFOLLOW: a log path planted as a symlink to a settings file is refused, never written through.
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, lines.map((line) => `${line}\n`).join(""));
  } finally {
    fs.closeSync(fd);
  }
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  home,
  context: nodeContext(home),
  readStdin: (ms) => readWithin(process.stdin, ms),
  appendLog,
  readFile,
  realpath: (p) => fs.realpathSync.native(p),
  now: () => new Date(),
  loadDecide: async () => (await import("./decide.js")).decide,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
