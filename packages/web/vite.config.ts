import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.AVA_API ?? `http://127.0.0.1:${process.env.PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    host: "127.0.0.1",
    proxy: {
      "/api/live": { target: api.replace(/^http/, "ws"), ws: true },
      "/api": { target: api, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022", chunkSizeWarningLimit: 800 },
});
