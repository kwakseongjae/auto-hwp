import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed dev port and a static build in `dist/` (see tauri.conf.json).
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});
