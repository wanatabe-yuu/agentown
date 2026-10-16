import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    {
      // The server's /player page loads this from its own origin instead of a CDN (no third party in the page).
      name: "vendor-hls",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "vendor/hls.min.js", source: readFileSync(new URL("./node_modules/hls.js/dist/hls.min.js", import.meta.url)) });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8080", ws: true } },
  },
});
