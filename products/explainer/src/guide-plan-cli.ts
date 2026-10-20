import { Command, Option } from "commander";
import { GUIDE_STAGES, guidePlan, type GuideDeps, type GuideStage } from "./guide-plan.js";

const EXIT = { OK: 0, USAGE: 2 } as const;

export interface GuideCliIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** `explainer guide plan [--stage plan|script]`: prints the planner guide as markdown. */
export async function runGuideCli(argv: string[], deps: GuideDeps = {}, io: GuideCliIo = {}): Promise<number> {
  const { out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text) } = io;
  let code: number = EXIT.OK;
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err });
  program
    .command("guide")
    .command("plan")
    .description("Print the planner guide: stage rules and the story-spine template")
    .addOption(new Option("--stage <stage>", "pipeline stage").choices([...GUIDE_STAGES]).default("plan"))
    .action((flags: { stage: GuideStage }) => out(guidePlan(flags.stage, deps)));
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    code = (error as { exitCode?: number }).exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  }
  return code;
}
