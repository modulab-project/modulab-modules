import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJsPlugin from "vite-plugin-css-injected-by-js";
import { resolve } from "path";

// Build the Vacation Spots UI as a single ES module bundle.
// React, ReactDOM, i18next and react-i18next are provided by the ModuLab Core
// host via window.__MODULAB_HOST__. We alias each package to a local shim file
// that reads from the host object — this guarantees a single React instance
// (required for hooks) while keeping the bundle small.
// MapLibre GL is bundled directly (not provided by host).
//
// ModuLab Core loads a module's UI exclusively via GET /v1/modules/{name}/ui/bundle.js
// (fetch + Blob URL + dynamic import) — it never fetches or links a module's separate
// CSS output file. Any component styles that rely on an external stylesheet (e.g.
// MapLibre GL's control/button CSS) would otherwise be silently unstyled/invisible in
// production. cssInjectedByJsPlugin inlines the built CSS into bundle.js itself, which
// injects a <style> tag at import time — no Core-side changes needed.
export default defineConfig({
  plugins: [react(), cssInjectedByJsPlugin()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    alias: {
      "react/jsx-runtime": resolve(__dirname, "src/host-shims/react-jsx-runtime.ts"),
      "react-dom":         resolve(__dirname, "src/host-shims/react-dom.ts"),
      "react":             resolve(__dirname, "src/host-shims/react.ts"),
      "react-i18next":     resolve(__dirname, "src/host-shims/react-i18next.ts"),
      "i18next":           resolve(__dirname, "src/host-shims/i18next.ts"),
    },
  },
  build: {
    lib: {
      entry: "src/main.tsx",
      name: "VacationSpotsModule",
      fileName: () => "bundle.js",
      formats: ["es"],
    },
    outDir: "../bundle",
    emptyOutDir: true,
  },
});
