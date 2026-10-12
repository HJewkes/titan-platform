#!/usr/bin/env node
import { main } from "./cli.js";

// Built as dist/judge.js. It can only judge, so the judge CI job cannot be steered into building or running either
// commit, and its presence in a merge-base build is how the run script knows that base supports the three-job split.
await main(["judge", ...process.argv.slice(2)]);
