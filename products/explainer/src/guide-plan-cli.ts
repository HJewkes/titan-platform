import { readFileSync } from "node:fs";
import { CommanderError, Command, Option } from "commander";
import { parseSpine } from "./spine-schema.js";
import { GUIDE_STAGES, guidePlan, type GuideDeps, type GuideStage } from "./guide-plan.js";

const EXIT = { OK: 0, USAGE: 2 } as const;

interface GuideCliIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** `explainer guide plan [--stage plan|script] [--spine <spine.md>]`: prints the planner guide as markdown. */
export async function runGuideCli(argv: string[], deps: GuideDeps = {}, io: GuideCliIo = {}): Promise<number> {
  const { out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text) } = io;
  let code: number = EXIT.OK;
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err });
  program
    .command("guide")
    .command("plan")
    .description("Print the planner guide: stage rules and the story-spine template")
    .addOption(new Option("--stage <stage>", "pipeline stage").choices([...GUIDE_STAGES]).default("plan"))
    .option("--spine <spine.md>", "story spine whose rows and ledger are appended per act")
    .action((flags: { stage: GuideStage; spine?: string }) => {
      const spine = flags.spine === undefined ? deps.spine : parseSpine(readFileSync(flags.spine, "utf8"));
      out(guidePlan(flags.stage, { ...deps, ...(spine ? { spine } : {}) }));
    });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    code = error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  }
  return code;
}
