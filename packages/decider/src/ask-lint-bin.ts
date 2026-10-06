#!/usr/bin/env node
import * as fs from "node:fs";
import { runAskLint } from "./ask-lint-cli.js";

process.exitCode = runAskLint(process.argv.slice(2), {
  readFile: (file) => fs.readFileSync(file, "utf-8"),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
