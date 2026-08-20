import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
