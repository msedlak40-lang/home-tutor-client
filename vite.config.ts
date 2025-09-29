import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      devOptions: { enabled: true, type: "module" },
      manifest: {
        name: "Home Tutor",
        short_name: "Tutor",
        start_url: "/",
        display: "standalone",
        background_color: "#0b0b0b",
        theme_color: "#0ea5e9",
icons: [
  { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
  { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
  { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
]
      }
    })
  ]
});
