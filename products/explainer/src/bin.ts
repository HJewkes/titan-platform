#!/usr/bin/env node
import { runEvalCli } from "./eval-cli.js";
import { runGuideCli } from "./guide-plan-cli.js";
import { runPrCli } from "./presets/pr-overview/pr-cli.js";
import { runRewriteCli } from "./rewrite-cli.js";
import { runRunCli } from "./workflow/run-cli.js";
import { runStageCli } from "./workflow/stage-cli.js";

const argv = process.argv.slice(2);

const SUBCOMMANDS = new Map<string | undefined, (argv: string[]) => Promise<number>>([["guide", runGuideCli], ["pr", runPrCli], ["rewrite", runRewriteCli], ["run", runRunCli], ["stage", runStageCli]]);

process.exitCode = await (SUBCOMMANDS.get(argv[0]) ?? runEvalCli)(argv);
