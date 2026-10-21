import type { ReactNode } from "react";
import { HStack, Typography, VStack } from "@titan-design/react-ui";

interface BoardColumn {
  key: string;
  label: string;
  items: readonly { key: string; node: ReactNode }[];
}

/**
 * Interim for TD-1001 (react-ui `Board`: columns are stages, read-only, lanes as rows): one stack per stage with its
 * cards under it, wrapping at narrow widths. One row only, since the read model names no lane slot yet (gap G3). Kept
 * in this one file so the swap touches nothing else.
 */
export function AutoresearchLanesBoard({ columns }: { columns: readonly BoardColumn[] }): ReactNode {
  return (
    <HStack gap={4} align="start" wrap>
      {columns.map((column) => (
        <VStack key={column.key} gap={2} className="min-w-0 max-w-full" testID={`autoresearch-lane-${column.key}`}>
          <Typography variant="overline" color="secondary">{`${column.label} · ${column.items.length}`}</Typography>
          {column.items.map((item) => (
            <VStack key={item.key} gap={0}>
              {item.node}
            </VStack>
          ))}
        </VStack>
      ))}
    </HStack>
  );
}
