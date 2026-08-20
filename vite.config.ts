import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The changelog and the LLM instructions are their own pages so they can be
    // opened in a separate tab without disturbing a running match.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        changelog: resolve(__dirname, 'changelog.html'),
        instructions: resolve(__dirname, 'instructions.html'),
      },
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
