// `pnpm --filter @titan-design/speech-tts smoke:speech [--suite ...] [--device ...] [--profile ...]`: spike E8's
// speech smoke on the real models. Unpublished; it imports the package's built dist, so run `pnpm build` first.
import { realEngines } from "./smoke-engines.ts";
import { runSmoke } from "./smoke-run.ts";

const log = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const deps = { engines: realEngines, env: process.env, now: () => performance.now(), log };

// Exit 3 keeps a crash apart from a failed stage (1) and bad usage (2).
process.exitCode = await runSmoke(process.argv.slice(2), deps).catch((err: unknown) => {
  log(`smoke: crash: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return 3;
});
