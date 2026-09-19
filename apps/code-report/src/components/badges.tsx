import type { ReactNode } from "react";
import { Badge, BadgeText } from "@titan-design/react-ui";

const SEVERITY_COLOR: Record<string, "error" | "warning" | "info"> = { error: "error", warning: "warning" };

export function SeverityBadge({ severity }: { severity: string }): ReactNode {
  return (
    <Badge color={SEVERITY_COLOR[severity] ?? "info"} variant="subtle" size="sm">
      <BadgeText>{severity}</BadgeText>
    </Badge>
  );
}

const PROVENANCE_TEXT: Record<string, string> = { measured: "measured", derived: "derived from a rule", model: "model judgement" };

/** Every datum says where it came from: measured by a tool, derived by a rule, or judged by a model. */
export function ProvenanceBadge({ kind, source }: { kind: string; source?: string }): ReactNode {
  return (
    <Badge color={kind === "model" ? "secondary" : "default"} variant="outline" size="sm">
      <BadgeText>{`${PROVENANCE_TEXT[kind] ?? kind}${source ? `: ${source}` : ""}`}</BadgeText>
    </Badge>
  );
}
