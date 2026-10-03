import type { ReactNode } from "react";
import { Badge, BadgeText } from "@titan-design/react-ui";

/** Marks an initiative that is shown here and left out of every export. */
export function PersonalBadge(): ReactNode {
  return (
    <Badge color="warning" variant="subtle" size="sm">
      <BadgeText>personal</BadgeText>
    </Badge>
  );
}
