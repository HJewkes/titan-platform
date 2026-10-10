#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  now: Date.now,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
