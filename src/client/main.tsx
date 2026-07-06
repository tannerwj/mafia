import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { getSharedReporter, installGlobalErrorHandlers } from "./net/errorReporting";
import "./index.css";

// Spec 17 D3: module-scope, installed once — `window.onerror` +
// `unhandledrejection` catch what the render-tree ErrorBoundary below
// structurally cannot (errors outside React's render/lifecycle, e.g. in
// event handlers or async callbacks that don't rethrow into render).
installGlobalErrorHandlers(
  window as unknown as Parameters<typeof installGlobalErrorHandlers>[0],
  getSharedReporter(),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
