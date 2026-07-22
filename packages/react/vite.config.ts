import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Library build (issue 016): ESM bundle + a co-located styles.css. React / react-dom / @auto-hwp/engine
// are EXTERNAL — the host provides React, and the wasm engine ships as its own package. .d.ts is
// emitted separately by `tsc -p tsconfig.build.json` (see package.json build script).
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      // The regex also externalizes subpaths (issue 055: "@auto-hwp/engine/worker-client").
      external: ["react", "react-dom", "react/jsx-runtime", /^@auto-hwp\/engine(\/.*)?$/],
      output: {
        // Name the extracted stylesheet `styles.css` to match the package export map.
        assetFileNames: (info) => (info.name && info.name.endsWith(".css") ? "styles.css" : "[name][extname]"),
      },
    },
    sourcemap: true,
    // Emit dist/styles.css alongside dist/index.js (the CSS import in src is code-split out).
    cssCodeSplit: false,
    emptyOutDir: true,
  },
});
