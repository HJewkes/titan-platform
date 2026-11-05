import { readFileSync } from "node:fs";
import { CommanderError, Command, Option } from "commander";
import { parseSpine } from "./spine-schema.js";
import { GUIDE_STAGES, guidePlan, type GuideDeps, type GuideStage } from "./guide-plan.js";
import { guideForType, writeTypeGuides, type TypeGuideDeps } from "./guide-type.js";
import { UnknownProfileError } from "./profile-load.js";

const EXIT = { OK: 0, USAGE: 2 } as const;

interface GuideCliIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
}

type Deps = GuideDeps & TypeGuideDeps;

interface PlanFlags {
  stage: GuideStage;
  spine?: string;
  type?: string;
}

function printTypeGuide(type: string, deps: Deps, { out, err }: Required<GuideCliIo>): number {
  try {
    out(guideForType(type, deps));
    return EXIT.OK;
  } catch (error) {
    if (!(error instanceof UnknownProfileError)) throw error;
    err(`${error.message}\n`);
    return EXIT.USAGE;
  }
}

function printPlan(flags: PlanFlags, deps: Deps, io: Required<GuideCliIo>): number {
  if (flags.type !== undefined) return printTypeGuide(flags.type, deps, io);
  const spine = flags.spine === undefined ? deps.spine : parseSpine(readFileSync(flags.spine, "utf8"));
  io.out(guidePlan(flags.stage, { ...deps, ...(spine ? { spine } : {}) }));
  return EXIT.OK;
}

/**
 * `explainer guide plan [--stage plan|script] [--spine <spine.md>] [--type <type>]` prints a planner
 * guide as markdown; `explainer guide types [--doctrine <dir>]` regenerates `guides/planner/<type>.md`.
 */
export async function runGuideCli(argv: string[], deps: Deps = {}, io: GuideCliIo = {}): Promise<number> {
  const { out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text) } = io;
  let code: number = EXIT.OK;
  const program = new Command("explainer").exitOverride().configureOutput({ writeOut: out, writeErr: err });
  const guide = program.command("guide");
  guide
    .command("plan")
    .description("Print the planner guide: stage rules and the story-spine template, or one video type's guide")
    .addOption(new Option("--stage <stage>", "pipeline stage").choices([...GUIDE_STAGES]).default("plan"))
    .option("--spine <spine.md>", "story spine whose rows and ledger are appended per act")
    .option("--type <type>", "print this video type's generated guide instead")
    .action((flags: PlanFlags) => {
      code = printPlan(flags, deps, { out, err });
    });
  guide
    .command("types")
    .description("Regenerate guides/planner/<type>.md from every doctrine/types profile")
    .option("--doctrine <dir>", "doctrine directory")
    .action((flags: { doctrine?: string }) => out(`wrote ${writeTypeGuides(flags.doctrine, deps).join(", ")}\n`));
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    code = error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
  }
  return code;
}
