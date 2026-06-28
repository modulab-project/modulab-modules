import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the Recipes UI as a single self-contained ES module (bundle.js).
// ModulePage.tsx loads it via dynamic import() at runtime.
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/main.tsx",
      name: "RecipesModule",
      fileName: () => "bundle.js",
      formats: ["es"],
    },
    // Keep bundle self-contained — no external dependencies.
    // React and ReactDOM are bundled in so the host doesn't need to share them.
    rollupOptions: {
      external: [],
    },
    outDir: "../bundle",
    emptyOutDir: true,
  },
});
