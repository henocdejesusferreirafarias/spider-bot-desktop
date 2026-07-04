import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";

const projectDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(projectDir, "src/renderer");
const outputDir = resolve(projectDir, "dist-renderer");

export default defineConfig({
  root: rootDir,
  base: "./",
  plugins: [react()],
  build: {
    outDir: outputDir,
    emptyOutDir: true
  },
  server: {
    port: 5173,
    host: "127.0.0.1"
  }
});
