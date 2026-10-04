// One process for development: the console daemon, and Vite's dev server proxying /rpc to it: `pnpm --filter titan-console dev`.
import { createServer } from "vite";
import { resolveConfig } from "./config.js";
import { closeOnSignal, startConsoleDaemon } from "./daemon.js";
import { APP_DIR } from "./paths.js";

const handle = await startConsoleDaemon({ config: resolveConfig() });
const vite = await createServer({ root: APP_DIR, configFile: `${APP_DIR}/vite.config.ts` });
await vite.listen();
vite.printUrls();
console.log(`console daemon: http://127.0.0.1:${handle.port}/ (pid ${process.pid})`);
closeOnSignal(handle, () => vite.close());
