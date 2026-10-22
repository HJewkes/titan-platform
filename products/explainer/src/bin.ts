#!/usr/bin/env node
import { runEvalCli } from "./eval-cli.js";
import { runGuideCli } from "./guide-plan-cli.js";
import { runRewriteCli } from "./rewrite-cli.js";

const argv = process.argv.slice(2);

const SUBCOMMANDS = new Map<string | undefined, (argv: string[]) => Promise<number>>([["guide", runGuideCli], ["rewrite", runRewriteCli]]);

process.exitCode = await (SUBCOMMANDS.get(argv[0]) ?? runEvalCli)(argv);
