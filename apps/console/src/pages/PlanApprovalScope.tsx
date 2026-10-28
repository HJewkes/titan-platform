import { createContext, useContext, type ReactNode } from "react";
import { Card, CardContent, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest } from "../../server/round-schema.js";

type PlanBinding = NonNullable<Manifest["planApprovals"]>[number];

const PlanApprovalsContext = createContext<readonly PlanBinding[]>([]);

/**
 * The round's `planApprovals` for its questions. A bound question's approve pick writes its scope verbatim as the owner's
 * plan approval (TP-4357), so the page shows the scope beside the question: the owner approves what is on the page.
 */
export function PlanApprovalsProvider({ manifest, children }: { manifest: Manifest; children: ReactNode }): ReactNode {
  return <PlanApprovalsContext.Provider value={manifest.planApprovals ?? []}>{children}</PlanApprovalsContext.Provider>;
}

const blobLabel = (blob: string | null): string => (blob === null ? "absent at head" : `content ${blob.slice(0, 12)}`);

function scopeLines(binding: PlanBinding): string[] {
  if (binding.gate !== "ci-policy") return binding.scope.paths.map((path) => `Path: ${path}`);
  const keys = `CI-policy weakened: ${binding.scope.ciPolicyKeys.join(", ")}`;
  return [keys, ...binding.scope.files.map(({ path, blob }) => `File: ${path} (${blobLabel(blob)})`)];
}

/** What picking the question's approve option records; nothing for a question no binding names. */
export function PlanApprovalScope({ questionId }: { questionId: string }): ReactNode {
  const binding = useContext(PlanApprovalsContext).find((each) => each.questionId === questionId);
  if (binding === undefined) return null;
  const { approve, gate, task, repo } = binding;
  return (
    <Card variant="subtle" testID={`plan-approval-scope-${questionId}`}>
      <CardContent>
        <VStack gap={1}>
          <Typography variant="subtitle2">{`"${approve}" records a ${gate} plan approval for ${task} in ${repo}, covering only:`}</Typography>
          {scopeLines(binding).map((line) => (
            <Typography key={line} variant="caption" color="secondary">{line}</Typography>
          ))}
        </VStack>
      </CardContent>
    </Card>
  );
}
