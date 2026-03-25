import { defineConfig } from "vite";

export default defineConfig({
  server: {
    open: true,
  },
  optimizeDeps: {
    include: ["react-pdf", "pdfjs-dist"],
  },
});
