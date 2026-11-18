/**
 * Transitional data, not policy. When `visibility` landed (TP-5453 P6) a brief with no
 * `visibility` key became owner-only, so these code initiatives keep agent access until the
 * owner writes `visibility: agent-visible` into each brief. A follow-up deletes this file and
 * its one lookup in `visibility.ts` once every brief listed here declares its visibility.
 * An explicit `visibility` in a brief always wins over this list.
 */
export const TRANSITIONAL_AGENT_VISIBLE = {
  added: "2026-11-12",
  removeWhen: "every initiative below declares visibility in its brief (TP-5453 follow-up)",
  initiatives: [
    "titan-platform",
    "claude-channels",
    "titan-design",
    "voltras-workspace",
    "codewatch",
    "relay",
    "logan",
    "home-assistant",
    "fantasy-football",
    "audiobook",
    "hermes",
    "demo",
    "tennis",
    "youtube",
    "herald",
    "demo-video-tooling",
    "brain",
  ],
} as const;
