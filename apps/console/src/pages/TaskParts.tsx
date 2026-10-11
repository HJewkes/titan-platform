import type { ReactNode } from "react";
import { Badge, Link, Typography } from "@titan-design/react-ui";
import type { TaskStage } from "../../server/task-stage.js";
import { refToRoute } from "../refs.js";
import { open } from "../router.js";

type BadgeColor = "default" | "primary" | "secondary" | "success" | "error" | "warning" | "info";

/** Stage groups in board order; a list of open tasks has no done group, but a done task's detail still shows its stage. */
export const STAGE_ORDER: readonly TaskStage[] = ["blocked", "ready", "in-progress", "review", "done"];

const STAGE_BADGES: Record<TaskStage, { label: string; color: BadgeColor }> = {
  blocked: { label: "Blocked", color: "error" },
  ready: { label: "Ready", color: "default" },
  "in-progress": { label: "In progress", color: "info" },
  review: { label: "In review", color: "warning" },
  done: { label: "Done", color: "success" },
};

export const stageLabel = (stage: TaskStage): string => STAGE_BADGES[stage].label;

/**
 * Stands in for react-ui's `TaskStagePill`, which only the unreleased react-ui 0.22.0 exports.
 * Once the console pins that release, this function becomes `<TaskStagePill stage={stage} />`.
 */
export function TaskStageBadge({ stage }: { stage: TaskStage }): ReactNode {
  const { label, color } = STAGE_BADGES[stage];
  return (
    <Badge variant="subtle" size="sm" color={color}>
      {label}
    </Badge>
  );
}

export function GuessedCaption(): ReactNode {
  return (
    <Typography variant="caption" color="secondary">
      Stage guessed: no stage signal on this task
    </Typography>
  );
}

/** react-ui 0.20.0's `Link` renders no anchor (TD-493), so an outside link opens its own window. */
function pressFor(refText: string): (() => void) | undefined {
  const target = refToRoute(refText);
  if (target?.kind === "route") return () => open(target.route);
  if (target?.kind === "github") return () => window.open(target.url, "_blank", "noopener");
  return undefined;
}

/** A ref as a link through `refToRoute`, plain text when it leads nowhere; `RefChip` (TD-497) replaces it. */
export function RefLink({ refText, label }: { refText: string; label?: string }): ReactNode {
  const onPress = pressFor(refText);
  const text = label ?? refText;
  if (!onPress) return <Typography variant="body1">{text}</Typography>;
  return (
    <Link color="primary" isExternal={refText.startsWith("pr:")} onPress={onPress}>
      {text}
    </Link>
  );
}
