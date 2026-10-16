import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { DialogHost } from "./dialogs.tsx";
import { loadLang } from "./i18n.ts";
import { installPullToRefresh, watchForNewVersion } from "./refresh.ts";
import "./styles.css";

installPullToRefresh();
watchForNewVersion();

// The interface language's words first (English needs none); a failed load still starts, in English.
void loadLang().catch(() => {}).then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
      <DialogHost />
    </StrictMode>,
  ),
);
