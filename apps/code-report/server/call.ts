// Answers one command in process and prints its size and time: `pnpm --filter code-report call hierarchy.get '{"depth":2}'`.
import { invokeCommand } from "@titan-design/registry";
import { createContext, createReportRegistry } from "./registry.js";

async function main(): Promise<void> {
  const [name, argsJson] = process.argv.slice(2);
  if (!name) throw new Error("usage: call <command> [json-args]");
  const { registry } = await createReportRegistry();
  const command = registry.get(name);
  if (!command) throw new Error(`Unknown command: ${name}`);
  const args: unknown = JSON.parse(argsJson ?? "{}");
  await invokeCommand(command, args, createContext()); // warms the snapshot model so the timing is the query alone
  const started = performance.now();
  const { envelope } = await invokeCommand(command, args, createContext());
  const ms = (performance.now() - started).toFixed(1);
  const json = JSON.stringify(envelope);
  console.error(`${name} ${JSON.stringify(args)}: ${json.length} bytes, ${ms} ms (model already loaded)`);
  console.log(json);
}

await main();
