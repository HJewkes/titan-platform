#!/usr/bin/env node
import { runCli } from "./cli.js";

// Always exit 0: the verdict lives in the printed line, so a failing check never stands in for one.
const line = await runCli(process.argv.slice(2), process.cwd());
process.stdout.write(`${line}\n`);
process.exitCode = 0;
