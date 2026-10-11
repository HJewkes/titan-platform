#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  titanBin: fileURLToPath(import.meta.url),
});
