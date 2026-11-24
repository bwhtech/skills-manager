import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The same .env the server reads (all keys, not only VITE_ ones), so the proxy follows PORT.
  const env = { ...loadEnv(mode, import.meta.dirname, ""), ...process.env }
  const apiPort = Number(env.PORT || 3530)
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve(import.meta.dirname, "./src"),
        "@shared": resolve(import.meta.dirname, "./shared"),
      },
    },
    server: {
      port: Number(env.SKILLS_MANAGER_DEV_PORT || 5530),
      host: "127.0.0.1",
      // Keep Host and add X-Forwarded-Host, so the server's Origin check
      // accepts mutating requests made through the dev proxy.
      proxy: {
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false, xfwd: true },
      },
    },
  }
})
