import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// GitHub Pages serves the site under /granite-sql-engine/; local dev uses /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.STUDIO_BASE ?? '/granite-sql-engine/') : '/',
  resolve: {
    alias: {
      '@granite/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'es2023',
    outDir: 'dist',
    emptyOutDir: true,
  },
}));
