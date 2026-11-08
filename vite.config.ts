import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "client",
  publicDir: false,
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/socket.io": { target: "http://localhost:3000", ws: true },
      "/api": "http://localhost:3000",
    },
  },
});
