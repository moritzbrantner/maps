import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "@moritzbrantner/ui/atlas/styles.css";
import "../styles.css";
import "./styles.css";
import "./showcase.css";

import { App } from "./App";
import { ShowcaseShell } from "./ShowcaseShell";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ShowcaseShell>
        <App />
      </ShowcaseShell>
    </QueryClientProvider>
  </StrictMode>,
);
