import { parentPort, workerData } from "node:worker_threads";
import { nodeContext } from "./context.js";
import type { WorkerInput } from "./deadline.js";
import { handle } from "./hook.js";

// The check of one event, run off the hook's main thread so its deadline timer can fire (TP-3224).
const data = workerData as WorkerInput;
const context = nodeContext(data.home);
const result = await handle(data.input, data.env, {
  context: data.foldCase ? { ...context, foldCase: true } : context,
  now: () => new Date(),
  loadDecide: async () => (await import("./decide.js")).decide,
});
parentPort?.postMessage(result);
