import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      "@shared": resolve(import.meta.dirname, "./shared"),
    },
  },
  server: {
    port: 5530,
    host: "127.0.0.1",
    // Keep Host and add X-Forwarded-Host, so the server's Origin check
    // accepts mutating requests made through the dev proxy.
    proxy: {
      "/api": { target: "http://127.0.0.1:3530", changeOrigin: false, xfwd: true },
    },
  },
})
