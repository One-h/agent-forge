import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const companionRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: companionRoot,
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: fileURLToPath(new URL("./src/embed-main.tsx", import.meta.url)),
      output: {
        entryFileNames: "assets/embed-main.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (assetInfo) => assetInfo.name?.endsWith(".css")
          ? "assets/style.css"
          : "assets/[name][extname]"
      }
    }
  }
});
