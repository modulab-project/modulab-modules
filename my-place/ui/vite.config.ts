import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Build the Vacation Spots UI as a single ES module bundle.
// React, ReactDOM, i18next and react-i18next are provided by the ModuLab Core
// host via window.__MODULAB_HOST__. We alias each package to a local shim file
// that reads from the host object — this guarantees a single React instance
// (required for hooks) while keeping the bundle small.
// MapLibre GL is bundled directly (not provided by host).
export default defineConfig({
  plugins: [react()],
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
