import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset paths so the packaged app can load dist/index.html from file://
  base: './',
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2500 },
});
