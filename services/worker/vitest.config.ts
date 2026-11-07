import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'src/module_bindings/**'],
    testTimeout: 15_000,
  },
});
