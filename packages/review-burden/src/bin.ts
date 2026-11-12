#!/usr/bin/env node
import { realDeps, run } from "./cli.js";

process.exitCode = run(process.argv.slice(2), realDeps());
