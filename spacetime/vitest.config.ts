import { defineConfig, type Plugin } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

// The plugin swaps the host-only `spacetime:sys` imports for SpacetimeDB's real in-memory datastore, so the
// reducers in src/ run unmodified against the same schema the published module uses.
export default defineConfig({
  cacheDir: 'node_modules/.vite-module-tests',
  plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin],
  test: {
    environment: 'node',
    include: ['src/module.test.ts'],
  },
});
