import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GeoDeploy's own `geodeploy ui` server (see packages/cli) serves this app's
// built `dist/` and exposes the read-only /api/* contract in production.
// During `vite dev` that server isn't in front of us, so proxy /api/* to it
// directly (default port 4000) to keep the standalone dev server useful.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
