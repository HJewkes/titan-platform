#!/usr/bin/env node
import { runEvalCli } from "./eval-cli.js";

process.exitCode = await runEvalCli(process.argv.slice(2));
