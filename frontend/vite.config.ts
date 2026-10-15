import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared/src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // Proxy WebSocket connections — same origin in dev and prod
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
      // Proxy REST API calls
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
