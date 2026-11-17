import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@granite/core/node': fileURLToPath(new URL('./packages/core/src/node.ts', import.meta.url)),
      '@granite/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tests/**/*.spec.ts'],
    maxWorkers: 4,
  },
});
