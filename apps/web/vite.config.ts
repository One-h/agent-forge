import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = `http://127.0.0.1:${process.env.PORT ?? 4731}`;
const proxy = { "/api": apiTarget };

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy
  },
  preview: {
    host: "127.0.0.1",
    proxy
  }
});
