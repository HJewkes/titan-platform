import type { ReactNode } from "react";
import { Typography } from "@titan-design/react-ui";
import { useQuery } from "./data/rpc.js";

/** UTC to the minute, so the line reads the same in every timezone and a twin frame does not move. */
const minuteUtc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Which build the console is serving, so the owner can tell whether a merge has reached it. */
export function BuildFooter(): ReactNode {
  const build = useQuery("console.build").data?.build;
  if (!build) return null;
  return (
    <div className="px-gutter-sm pb-gutter-sm sm:px-gutter-md sm:pb-gutter-md">
      <Typography variant="caption" color="tertiary" testID="build-footer">
        {`Build ${build.sha.slice(0, 7)}${build.dirty ? " (dirty)" : ""}, built ${minuteUtc(build.builtAt)}`}
      </Typography>
    </div>
  );
}
