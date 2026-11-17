import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const api = process.env.PF_FLEET_API ?? "http://localhost:1337";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/install.sh": { target: api, changeOrigin: true },
      "/agent": { target: api, changeOrigin: true, ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
