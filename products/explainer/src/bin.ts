#!/usr/bin/env node
import { runAaFloorCli } from "./aa-floor-cli.js";
import { runAudioCli } from "./audio-cli.js";
import { runSheetsCli } from "./contact-sheet-cli.js";
import { runDailyCli } from "./workflow/daily-cli.js";
import { runEvalCli } from "./eval-cli.js";
import { runGuideCli } from "./guide-plan-cli.js";
import { runPlateCuesCli } from "./plate-cues-cli.js";
import { runPrCli } from "./presets/pr-overview/pr-cli.js";
import { runRenderCli } from "./render-cli.js";
import { runRewriteCli } from "./rewrite-cli.js";
import { runRunCli } from "./workflow/run-cli.js";
import { runEditCli } from "./workflow/edit-cli.js";
import { runRunsCli } from "./workflow/runs-cli.js";
import { runPropsCli } from "./workflow/props-cli.js";
import { runAbCli } from "./workflow/samples-cli.js";
import { runStageCli } from "./workflow/stage-cli.js";

const argv = process.argv.slice(2);

const SUBCOMMANDS = new Map<string | undefined, (argv: string[]) => Promise<number>>([
  ["aa-floor", runAaFloorCli],
  ["ab", runAbCli],
  ["audio", runAudioCli],
  ["daily", runDailyCli],
  ["edit", runEditCli],
  ["guide", runGuideCli],
  ["plate-cues", runPlateCuesCli],
  ["pr", runPrCli],
  ["props", runPropsCli],
  ["render", runRenderCli],
  ["rewrite", runRewriteCli],
  ["run", runRunCli],
  ["runs", runRunsCli],
  ["sheets", runSheetsCli],
  ["stage", runStageCli],
]);

process.exitCode = await (SUBCOMMANDS.get(argv[0]) ?? runEvalCli)(argv);
