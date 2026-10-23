#!/usr/bin/env node
// The titan-console bin: serves the built app beside /rpc until SIGINT or SIGTERM, on loopback and,
// when TITAN_CONSOLE_HOST is set, on that LAN address behind auth. Two verbs manage LAN sign-in,
// `inbox file` lets an agent file an owner item, `decisions file` lets a seat file a questions-only decision round,
// `rounds import` lands a review round, `rounds withdraw` marks one superseded, `rounds sweep` withdraws superseded rounds
// and proposes ones the decisions file cites as answered, `rounds nudge` prints each round waiting over six hours once,
// `rounds subscribe` tells a seat of answers,
// `storybooks gc` sweeps the Storybook store, `config import` / `config compare-tree` run the coordinator config
// store's shadow steps, and `self-update --apply` (run by the bootstrap a systemd timer starts) swaps in the served console.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolveConfig, type ConsoleConfig } from "./config.js";
import { decisionsFileArgs, fileDecisionCli, importRoundCli, roundsImportArgs, roundsWithdrawArgs, withdrawRoundCli } from "./cli-rounds.js";
import { nudgeRoundsCli, roundsNudgeArgs } from "./cli-rounds-nudge.js";
import { roundsSweepArgs, sweepRoundsCli } from "./cli-rounds-sweep.js";
import { storybooksGcArgs, storybooksGcCli } from "./cli-storybooks.js";
import { subscriptionArgs, subscriptionCli } from "./cli-subscriptions.js";
import { CONFIG_USAGE, configArgs, configCli } from "./config-store/cli.js";
import type { ConfigStoreSource } from "./config-store/compare.js";
import { coordinatorFilePath } from "./config-store/materialize.js";
import { closeOnSignal, createLoginLink, lanOrigin, rotateLanToken, startConsoleDaemon } from "./daemon.js";
import { fileDeposit } from "./inbox.js";
import { PAGE_FILE } from "./paths.js";
import { SELF_UPDATE_USAGE, selfUpdateArgs, selfUpdateVerb } from "./self-update/cli.js";

const USAGE = `usage: titan-console                    serve the console
       titan-console login-link         print a one-time, ten-minute LAN login link
       titan-console token rotate       end every LAN session and void every login link
       titan-console inbox file [<json>|-]
                                        file an owner item on loopback and print its id;
                                        with - or no argument, the JSON comes from stdin
       titan-console decisions file [<round.json>|-] [--seat <name>] [--initiative <slug>] [--json]
                                        file a questions-only round@2 into the rounds dir and print its
                                        id, asker and console URL; the round comes from stdin with - or
                                        no path, the seat defaults to AGENT_CHAT_NAME, and the seat is
                                        messaged once the owner answers
       titan-console rounds import <round-dir> [--seat <name>] [--json]
                                        copy a review-harness round dir into the rounds dir and
                                        print its id, frame count, feedback outcome and console URL;
                                        with --seat, that seat is messaged once the owner answers
       titan-console rounds withdraw <id> --reason <new-head[:<sha>]|closed|answered-elsewhere|superseded-by:<id>> [--json]
                                        mark an unanswered round withdrawn; an answered round is kept
       titan-console rounds sweep [--dry-run|--apply] [--json] [--decisions <path>]
                                        list the open rounds a round's supersedes names and the open
                                        rounds the decisions file cites as answered or resolved;
                                        writes nothing unless --apply, which withdraws them all
       titan-console rounds nudge [--json]
                                        print one "reply rec" line for each round open over 6 h with
                                        no answer, once: a nudged.json marker keeps it from repeating
       titan-console rounds subscribe <round-id|unit-glob|owner/repo#N>... [--seat <name>] [--json]
                                        message the seat (default AGENT_CHAT_NAME) once for each answer
                                        to a matching round, imported now or later, from now on
       titan-console rounds unsubscribe <round-id|unit-glob|owner/repo#N>... [--seat <name>] [--json]
       titan-console rounds list-subscriptions [--seat <name>] [--json]
       titan-console storybooks gc [--dry-run] [--json]
                                        remove Storybook builds no open or recently closed round
                                        names, and print each build kept or removed and why;
                                        --dry-run deletes nothing
${CONFIG_USAGE}
${SELF_UPDATE_USAGE}`;

async function serve(config: ConsoleConfig): Promise<void> {
  for (const warning of config.startupWarnings ?? []) console.warn(warning);
  if (!existsSync(PAGE_FILE)) console.warn(`${PAGE_FILE} is missing; run \`pnpm --filter titan-console build\` (the daemon serves a "not built" page until then)`);
  const handle = await startConsoleDaemon({ config, staticRoot: PAGE_FILE });
  console.log(`titan console: http://127.0.0.1:${handle.port}/ (pid ${process.pid})`);
  if (config.lanHost !== null) console.log(`titan console on the LAN: ${lanOrigin(config, handle.port)}/ (sign in with \`titan-console login-link\`)`);
  closeOnSignal(handle);
}

// The link goes to the operator's terminal only; nothing logs it.
function loginLink(config: ConsoleConfig): void {
  console.log(createLoginLink(config));
  console.log("Open it within ten minutes on the device to sign in; it works once.");
}

function rotate(config: ConsoleConfig): void {
  rotateLanToken(config);
  console.log(`Rotated ${config.lanTokenPath}: every LAN session has ended and every login link is void.`);
}

function configStoreOf(config: ConsoleConfig): ConfigStoreSource {
  const paths = config.configStore ?? { autonomyTree: null, coordinatorFile: coordinatorFilePath() };
  return { stateDir: config.stateDir, ...paths };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const readSource = (source: string): Promise<string> => (source === "-" ? readStdin() : readFile(source, "utf8"));

// Prints only the item id, or the console's refusal; the body is never echoed.
async function fileInbox(config: ConsoleConfig, input: string | undefined): Promise<void> {
  const body = input === undefined || input === "-" ? await readStdin() : input;
  try {
    console.log(await fileDeposit(config.port, body));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const argv = process.argv.slice(2);
const args = argv.join(" ");
const roundsImport = roundsImportArgs(argv);
const roundsWithdraw = roundsWithdrawArgs(argv);
const roundsSweep = roundsSweepArgs(argv);
const roundsNudge = roundsNudgeArgs(argv);
const decisionsFile = decisionsFileArgs(argv);
const subscription = subscriptionArgs(argv);
const storybooksGc = storybooksGcArgs(argv);
const configVerb = configArgs(argv);
const selfUpdateVerbArgs = selfUpdateArgs(argv);
if (args === "") await serve(resolveConfig());
else if (args === "login-link") loginLink(resolveConfig());
else if (args === "token rotate") rotate(resolveConfig());
else if (argv[0] === "inbox" && argv[1] === "file" && argv.length <= 3) await fileInbox(resolveConfig(), argv[2]);
else if (decisionsFile !== null) await fileDecisionCli(resolveConfig(), decisionsFile, readSource);
else if (roundsImport !== null) await importRoundCli(resolveConfig(), roundsImport);
else if (roundsWithdraw !== null) await withdrawRoundCli(resolveConfig(), roundsWithdraw);
else if (roundsSweep !== null) await sweepRoundsCli(resolveConfig(), roundsSweep);
else if (roundsNudge !== null) await nudgeRoundsCli(resolveConfig(), roundsNudge);
else if (subscription !== null) await subscriptionCli(resolveConfig(), subscription);
else if (storybooksGc !== null) await storybooksGcCli(resolveConfig(), storybooksGc);
else if (configVerb !== null) await configCli(configStoreOf(resolveConfig()), configVerb);
else if (selfUpdateVerbArgs !== null) process.exitCode = await selfUpdateVerb(resolveConfig, selfUpdateVerbArgs);
else if (args === "--help" || args === "help") console.log(USAGE);
else {
  console.error(USAGE);
  process.exitCode = 64;
}
