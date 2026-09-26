import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// The Cloudflare plugin auto-discovers wrangler.jsonc, runs the Worker + Durable
// Object in workerd alongside the Vite client dev server (with HMR), and builds
// both for `vite build`.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(
      process.env.MAFIA_E2E_STATE_DIR
        ? { persistState: { path: process.env.MAFIA_E2E_STATE_DIR } }
        : {},
    ),
  ],
});
