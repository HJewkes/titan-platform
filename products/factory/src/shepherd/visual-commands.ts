// The visual verbs: pr-visual reads, the weekly Ship batch and its feedback sheet, and the log's frames (TP-6777).
import { logFramesCommand } from "./log-frames-command.js";
import { visualDeltaCommand } from "./visual-delta-command.js";
import { visualFeedbackCommand } from "./visual-feedback-command.js";
import { visualFeedbackNotesCommand } from "./visual-feedback-notes-command.js";
import { visualWeekCommand } from "./visual-week-command.js";

export const VISUAL_COMMANDS = {
  "shepherd.visual-delta": visualDeltaCommand,
  "shepherd.visual-week": visualWeekCommand,
  "shepherd.visual-week-feedback": visualFeedbackCommand,
  "shepherd.visual-feedback-notes": visualFeedbackNotesCommand,
  "shepherd.log-frames": logFramesCommand,
} as const;
