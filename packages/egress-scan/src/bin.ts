#!/usr/bin/env node
import * as fs from "node:fs";
import { runCli } from "./cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  readStdin: () => fs.readFileSync(0, "utf-8"),
  readFile: (file) => fs.readFileSync(file, "utf-8"),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
