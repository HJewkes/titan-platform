import "@titan-design/react-ui/theme/global.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RpcProvider, pageDataSource, readEmbeddedSnapshot } from "@titan-design/react-app";
import { App } from "./App.js";
import { AnswerSourceProvider } from "./data/submit.js";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

const source = pageDataSource();

createRoot(root).render(
  <StrictMode>
    <RpcProvider source={source}>
      <AnswerSourceProvider value={readEmbeddedSnapshot() ? null : source}>
        <App />
      </AnswerSourceProvider>
    </RpcProvider>
  </StrictMode>,
);
