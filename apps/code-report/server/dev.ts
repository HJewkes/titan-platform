// One process for development: the report daemon, and Vite's dev server proxying /rpc to it: `pnpm --filter code-report dev`.
import { createServer } from "vite";
import { closeOnSignal, startReportDaemon } from "./daemon.js";
import { APP_DIR } from "./paths.js";

const handle = await startReportDaemon();
const vite = await createServer({ root: APP_DIR, configFile: `${APP_DIR}/vite.config.ts` });
await vite.listen();
vite.printUrls();
console.log(`read API daemon: http://127.0.0.1:${handle.port}/ (pid ${process.pid})`);
closeOnSignal(handle, () => vite.close());
