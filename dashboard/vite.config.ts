import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:20200", changeOrigin: true },
      "/v1": { target: "http://127.0.0.1:20200", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:20200", changeOrigin: true },
    },
  },
  build: { outDir: "../dist/dashboard", emptyOutDir: true },
});
