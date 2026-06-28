import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the Recipes UI as a single self-contained ES module (bundle.js).
// ModulePage.tsx loads it via dynamic import() at runtime.
//
// All dependencies (React, i18next, etc.) are bundled in — the browser has no
// import map for bare specifiers like "react", so externalising them would cause
// the dynamic import() to fail with a resolution error. The bundle is ~300 KB
// gzipped which is acceptable for a homelab module loaded once per session.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/main.tsx",
      name: "RecipesModule",
      fileName: () => "bundle.js",
      formats: ["es"],
    },
    outDir: "../bundle",
    emptyOutDir: true,
  },
});
