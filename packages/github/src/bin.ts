#!/usr/bin/env node
import * as fs from "node:fs";
import { runSquashCli } from "./squash-cli.js";

process.exitCode = runSquashCli(process.argv.slice(2), {
  readStdin: () => fs.readFileSync(0, "utf-8"),
  out: (text) => process.stdout.write(text),
  err: (line) => process.stderr.write(`${line}\n`),
});
