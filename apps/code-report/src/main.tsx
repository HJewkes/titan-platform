import "@titan-design/react-ui/theme/global.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Badge, BadgeText, Card } from "@titan-design/react-ui";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Card variant="outline" className="m-4 p-4">
      <p className="text-text-primary">Hello</p>
      <Badge color="warning"><BadgeText>warning</BadgeText></Badge>
    </Card>
  </StrictMode>,
);
