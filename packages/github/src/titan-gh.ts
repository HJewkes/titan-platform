#!/usr/bin/env node
import { ghCliWire } from "./gh-cli.js";
import { githubPort } from "./port.js";
import { runTitanGh } from "./titan-gh-cli.js";

process.exitCode = await runTitanGh(process.argv.slice(2), {
  port: githubPort(ghCliWire()),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
