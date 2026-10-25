import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { App } from "../../web/src/App";
import "../../web/src/styles.css";

window.__AUTOFIX_CODEX_EMBED__ = true;

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      const normalized = String(key);
      return values.has(normalized) ? values.get(normalized)! : null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(String(key));
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
  };
}

// The CDP host deliberately keeps this document on an opaque sandbox origin.
// That blocks persistent storage, while the original Agent Forge shell reads
// localStorage during its first render. Keep the sandbox boundary and provide
// an isolated, in-memory fallback only when the browser storage getter throws.
try {
  window.localStorage.getItem("__autofix_embed_storage_probe__");
} catch {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    enumerable: true,
    value: createMemoryStorage(),
  });
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MemoryRouter initialEntries={["/todos"]}>
      <App />
    </MemoryRouter>
  </React.StrictMode>
);
