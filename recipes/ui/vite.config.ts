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
    // react-i18next and i18next are provided by the Core host bundle.
    // React and ReactDOM are also externalized so the host's singleton is used
    // (avoids double-React which breaks hooks).
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime", "i18next", "react-i18next"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
          "react/jsx-runtime": "ReactJSXRuntime",
          i18next: "i18next",
          "react-i18next": "ReactI18next",
        },
      },
    },
    outDir: "../bundle",
    emptyOutDir: true,
  },
});
