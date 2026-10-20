#!/usr/bin/env node
import { runEvalCli } from "./eval-cli.js";
import { runGuideCli } from "./guide-plan-cli.js";

const argv = process.argv.slice(2);

process.exitCode = argv[0] === "guide" ? await runGuideCli(argv) : await runEvalCli(argv);
