import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { global: true, process: true, Buffer: true },
    }),
  ],
  server: {
    port: 5173,
  },
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    include: ["simple-peer", "socket.io-client"],
  },
});

