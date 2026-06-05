import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  build: {
    cssTarget: "chrome61",
    target: "es2017"
  },
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false
  }
});
