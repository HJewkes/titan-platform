#!/usr/bin/env node
// The titan-console bin: serves the built app beside /rpc on loopback until SIGINT or SIGTERM.
import { existsSync } from "node:fs";
import { resolveConfig } from "./config.js";
import { closeOnSignal, startConsoleDaemon } from "./daemon.js";
import { PAGE_FILE } from "./paths.js";

if (!existsSync(PAGE_FILE)) console.warn(`${PAGE_FILE} is missing; run \`pnpm --filter titan-console build\` (the daemon serves a "not built" page until then)`);
const handle = await startConsoleDaemon({ config: resolveConfig(), staticRoot: PAGE_FILE });
console.log(`titan console: http://127.0.0.1:${handle.port}/ (pid ${process.pid})`);
closeOnSignal(handle);
