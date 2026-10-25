import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { startTheme, syncThemeFromServer } from "./themeStartup.js";

// Farbschema zuerst: mehrere Module lesen ihre Farben beim Laden.
startTheme();

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

void import("./App.js").then(({ default: App }) => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  void syncThemeFromServer();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}
