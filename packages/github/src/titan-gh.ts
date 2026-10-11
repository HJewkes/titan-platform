#!/usr/bin/env node
import { ghCliWire } from "./gh-cli.js";
import { githubPort } from "./port.js";
import { runTitanGhCli } from "./titan-gh-cli.js";

process.exitCode = await runTitanGhCli(
  process.argv.slice(2),
  {
    out: (text) => process.stdout.write(text),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  githubPort(ghCliWire()),
);
