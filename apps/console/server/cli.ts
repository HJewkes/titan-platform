#!/usr/bin/env node
// The titan-console bin: serves the built app beside /rpc until SIGINT or SIGTERM, on loopback and,
// when TITAN_CONSOLE_HOST is set, on that LAN address behind auth. Two verbs manage LAN sign-in,
// and `inbox file` lets an agent file an owner item.
import { existsSync } from "node:fs";
import { resolveConfig, type ConsoleConfig } from "./config.js";
import { closeOnSignal, createLoginLink, lanOrigin, rotateLanToken, startConsoleDaemon } from "./daemon.js";
import { fileDeposit } from "./inbox.js";
import { PAGE_FILE } from "./paths.js";

const USAGE = `usage: titan-console                    serve the console
       titan-console login-link         print a one-time, ten-minute LAN login link
       titan-console token rotate       end every LAN session and void every login link
       titan-console inbox file [<json>|-]
                                        file an owner item on loopback and print its id;
                                        with - or no argument, the JSON comes from stdin`;

async function serve(config: ConsoleConfig): Promise<void> {
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

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
if (args === "") await serve(resolveConfig());
else if (args === "login-link") loginLink(resolveConfig());
else if (args === "token rotate") rotate(resolveConfig());
else if (argv[0] === "inbox" && argv[1] === "file" && argv.length <= 3) await fileInbox(resolveConfig(), argv[2]);
else if (args === "--help" || args === "help") console.log(USAGE);
else {
  console.error(USAGE);
  process.exitCode = 64;
}
