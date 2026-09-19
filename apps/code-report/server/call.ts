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
  const cold = await timed(() => invokeCommand(command, args, createContext()));
  const warm = await timed(() => invokeCommand(command, args, createContext()));
  const json = JSON.stringify(warm.value.envelope);
  // The first call loads the snapshot's model and derives its findings; later calls reuse it.
  console.error(`${name} ${JSON.stringify(args)}: ${json.length} bytes, first call ${cold.ms} ms, repeat ${warm.ms} ms`);
  console.log(json);
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: string }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: (performance.now() - started).toFixed(1) };
}

await main();
