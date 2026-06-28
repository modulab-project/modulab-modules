import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Rollup plugin that rewrites bare-specifier imports to window.__MODULAB_HOST__
// property accesses. This is needed because:
//   - ES module bundles loaded via Blob URL cannot resolve bare specifiers
//     like "react" (no import map available)
//   - globals: {} only works for iife/umd formats, not "es"
//   - The host exposes its singletons on window.__MODULAB_HOST__ so that
//     module and host share the same React instance (required for hooks)
function modulabExternalsPlugin(): Plugin {
  const hostMap: Record<string, string> = {
    react:             "window.__MODULAB_HOST__.React",
    "react-dom":       "window.__MODULAB_HOST__.ReactDOM",
    "react/jsx-runtime": "window.__MODULAB_HOST__.ReactJSXRuntime",
    i18next:           "window.__MODULAB_HOST__.i18next",
    "react-i18next":   "window.__MODULAB_HOST__.ReactI18next",
  };

  return {
    name: "modulab-externals",
    resolveId(id) {
      if (id in hostMap) return `\0modulab-external:${id}`;
    },
    load(id) {
      const prefix = "\0modulab-external:";
      if (id.startsWith(prefix)) {
        const pkg = id.slice(prefix.length);
        const expr = hostMap[pkg];
        // Re-export everything from the host object so named + default imports work.
        return `const mod = ${expr}; export default mod; export * from mod;`;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), modulabExternalsPlugin()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
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
