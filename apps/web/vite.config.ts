import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "url";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the workspace contracts package through its TypeScript source
      // so Vite/esbuild bundles it correctly without a separate npm publish.
      "@onboardos/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    // The Cognito app client only registers http://localhost:5173/callback.
    // If 5173 is busy, fail loudly instead of silently moving to another port
    // (which would break the OAuth redirect with redirect_mismatch).
    strictPort: true,
    open: false,
  },
});
