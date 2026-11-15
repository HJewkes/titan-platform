import type { ReactNode } from "react";
import { Card, CardContent, Link, Typography, VStack } from "@titan-design/react-ui";
import { open } from "../router.js";
import { PHONE_TAP_LINK } from "./phone.js";

/** The video's cover, served beside the video by the daemon. */
function VideoPoster({ id }: { id: string }): ReactNode {
  return <img src={`/media/videos/${encodeURIComponent(id)}/poster`} alt="" loading="lazy" className="block h-auto w-full max-w-sm rounded bg-black" data-testid="home-video-poster" />;
}

/** A resolved video as a poster and a link into the theater. */
export function ResolvedVideoCard({ id, label }: { id: string; label: string }): ReactNode {
  return (
    <Card variant="outline" testID="home-video">
      <CardContent>
        <VStack gap={2}>
          <VideoPoster id={id} />
          <Link color="primary" className={PHONE_TAP_LINK} onPress={() => open({ view: "theater", id })} testID="home-video-link">
            <Typography variant="body2">{label}</Typography>
          </Link>
        </VStack>
      </CardContent>
    </Card>
  );
}
