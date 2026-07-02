import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// jsdom so the SVG sanitizer's DOMParser/XMLSerializer path (the browser path, not the regex fallback)
// runs in tests, and React components mount + fire events under @testing-library/react.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
