import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist' },
  // `npm run dev` serves the page from vite and hands the API to the real
  // server, so the two can be worked on at once.
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
