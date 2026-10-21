/** One key a round page owns: what `event.key` it answers to, how the legend names it, and what it does. */
export interface RoundKey {
  keys: readonly string[];
  label: string;
  does: string;
  group: RoundKeyGroup;
  /** Held with Cmd or Ctrl; every other key acts only with neither held. */
  command?: true;
}

export const ROUND_KEY_GROUPS = ["Questions", "Sections and rounds", "Frames", "Sending", "Help"] as const;
type RoundKeyGroup = (typeof ROUND_KEY_GROUPS)[number];

/**
 * Every key a round page binds, in legend order. Each handler matches its key from here and the legend lists this
 * table, so a key cannot do one thing while the legend says another.
 */
export const ROUND_KEYS = {
  pick: { keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"], label: "1-9", does: "Pick a choice in the active question", group: "Questions" },
  reveal: { keys: ["r"], label: "r", does: "Show or hide the active question's recommendation", group: "Questions" },
  advance: { keys: ["Enter"], label: "Enter", does: "Go to the next unanswered question", group: "Questions" },
  nextSection: { keys: ["n"], label: "n", does: "Next section", group: "Sections and rounds" },
  prevSection: { keys: ["p"], label: "p", does: "Previous section", group: "Sections and rounds" },
  nextRound: { keys: ["]"], label: "]", does: "Next round in the set", group: "Sections and rounds" },
  prevRound: { keys: ["["], label: "[", does: "Previous round in the set", group: "Sections and rounds" },
  chosen: { keys: ["c"], label: "c", does: "Mark the active frame Chosen", group: "Frames" },
  rejected: { keys: ["x"], label: "x", does: "Mark the active frame Rejected", group: "Frames" },
  maybe: { keys: ["m"], label: "m", does: "Mark the active frame Maybe", group: "Frames" },
  clearVerdict: { keys: ["u"], label: "u", does: "Clear the active frame's verdict", group: "Frames" },
  pins: { keys: ["a"], label: "a", does: "Start or stop pinning notes on the active frame", group: "Frames" },
  leavePins: { keys: ["Escape"], label: "Esc", does: "Stop pinning", group: "Frames" },
  check: { keys: ["Enter"], label: "⌘ or Ctrl + Enter", does: "Check before sending; on the check screen, send", group: "Sending", command: true },
  back: { keys: ["Escape"], label: "Esc", does: "On the check screen, go back to answering", group: "Sending" },
  legend: { keys: ["?"], label: "?", does: "Show or hide this list of keys", group: "Help" },
} as const satisfies Record<string, RoundKey>;

/**
 * Whether `event` presses `binding`: its key, Cmd or Ctrl exactly when the binding asks for it, and never Alt. Shift
 * is part of a printed key such as `?`, so only a named key such as Enter refuses it.
 */
export function pressed(binding: RoundKey, event: KeyboardEvent): boolean {
  if (!binding.keys.includes(event.key) || event.altKey) return false;
  if (event.key.length > 1 && event.shiftKey) return false;
  return (event.metaKey || event.ctrlKey) === (binding.command === true);
}
