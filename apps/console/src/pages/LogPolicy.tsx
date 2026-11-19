import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, HStack, Section, SectionContent, SectionHeader, Typography, VStack } from "@titan-design/react-ui";
import type { LogHeader } from "../../server/log-floor.js";

const MODE_TEXT: Record<LogHeader["mode"], string> = {
  off: "off: nothing resolves by rec",
  shadow: "shadow: logs what it would do, resolves nothing",
  live: "live: resolves by rec",
};

/**
 * The by-rec policy above the log: mode, wait and the exclusions. A floor class shows the owner-only change that removes
 * it and no control, since the floor is code; the policy file's own additions are listed apart.
 */
export function LogPolicyHeader({ header }: { header: LogHeader }): ReactNode {
  return (
    <Section testID="log-policy">
      <SectionHeader title="Auto-by-rec policy" subtitle={`Approvals with a recommendation go with it after ${header.afterHours} h of silence`} />
      <SectionContent>
        <VStack gap={3}>
          <HStack gap={2} align="center" wrap>
            <Badge variant="subtle" size="sm" color={header.mode === "live" ? "success" : header.mode === "shadow" ? "warning" : "default"} testID="log-mode">
              <BadgeText>{MODE_TEXT[header.mode]}</BadgeText>
            </Badge>
            <Typography variant="caption" color="secondary">{`Wait ${header.afterHours} h`}</Typography>
            {header.minConfidence !== undefined ? <Typography variant="caption" color="secondary">{`Confidence at least ${header.minConfidence}`}</Typography> : null}
          </HStack>
          {header.problem !== undefined ? <Alert status="error" message={header.problem} testID="log-policy-problem" /> : null}
          <Alert status="warning" message="Exclusion floor: assumed, not yet confirmed by the owner." testID="log-floor-unconfirmed" />
          <FloorList header={header} />
          <AddedList header={header} />
        </VStack>
      </SectionContent>
    </Section>
  );
}

function FloorList({ header }: { header: LogHeader }): ReactNode {
  return (
    <VStack gap={2} testID="log-floor">
      <Typography variant="subtitle2">Never by rec (the floor, in code)</Typography>
      {header.floor.map((floor) => (
        <VStack key={floor.reason} gap={0} className="min-w-0" testID={`log-floor-${floor.reason}`}>
          <Typography variant="body2" className="break-words">
            {floor.label}
          </Typography>
          <Typography variant="caption" color="secondary" className="break-words">
            {`To remove: ${floor.removeBy}`}
          </Typography>
        </VStack>
      ))}
    </VStack>
  );
}

function AddedList({ header }: { header: LogHeader }): ReactNode {
  return (
    <VStack gap={2} testID="log-added">
      <Typography variant="subtitle2">Added by the policy file</Typography>
      {header.added.length === 0 ? (
        <Typography variant="caption" color="secondary">
          None.
        </Typography>
      ) : (
        header.added.map((rule) => (
          <Typography key={`${rule.field}=${rule.value}`} variant="body2" className="break-words" testID={`log-added-${rule.field}-${rule.value}`}>
            {`${rule.field} = ${rule.value}${rule.note === undefined ? "" : `: ${rule.note}`}`}
          </Typography>
        ))
      )}
    </VStack>
  );
}
